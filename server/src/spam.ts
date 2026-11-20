import type { AccountConfig } from './config.js';
import { accounts, isMicrosoftAccount } from './config.js';
import { db } from './db.js';
import { onAppEvent } from './events.js';
import { connectionFor } from './imap.js';
import { moveMessage, setFlags, syncFolders, syncMessages } from './mailbox.js';
import { sendNotice } from './send.js';

/** Microsoft user-submission mailbox for junk. The original RFC822 rides along as an attachment. */
const MICROSOFT_JUNK = 'junk@office365.microsoft.com';

/** A partial message would be a bad sample. Above this, block and file, but do not submit. */
const MAX_REPORT_BYTES = 20 * 1024 * 1024;

/** One listing of a folder moves one batch. The rest wait for the next pass. */
const FILE_BATCH = 20;

/**
 * Blocking a sender sweeps the copies already cached, up to this many. Each
 * message is still moved on its own, so the mailbox lock is not held throughout.
 */
const BLOCK_SWEEP = 200;

const BANNED_NAME = 'banned';

const SKIP_SPECIAL = new Set(['\\Trash', '\\Sent', '\\Drafts']);

/** Accent-folded mailbox names that are not a place we should pull mail out of. */
const SKIP_NAMES = new Set([
  'trash',
  'deleted',
  'deleted items',
  'deleted messages',
  'corbeille',
  'elements supprimes',
  'sent',
  'sent items',
  'sent messages',
  'envoyes',
  'elements envoyes',
  'drafts',
  'brouillons',
  'outbox',
]);

/** Lower rank wins when the server does not advertise `\Junk`. */
const JUNK_RANK: Record<string, number> = {
  junk: 0,
  'junk email': 1,
  'junk e-mail': 1,
  spam: 2,
  'courrier indesirable': 3,
  indesirables: 4,
  pourriel: 5,
  'bulk mail': 6,
};

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export interface BlockedSender {
  email: string;
  blockedAt: number;
}

export interface SpamResult {
  email: string;
  alreadyBlocked: boolean;
  moved: boolean;
  /** The message sits in Indésirables: it stays there and is no longer listed. */
  hidden: boolean;
  /** The message was already sitting in Banned, so there was nowhere to move it. */
  alreadyInBanned: boolean;
  bannedFolder: string | null;
  /** Microsoft accepted the submission. Other providers are reported by the junk keyword. */
  submitted: boolean;
  /** French sentence when the move or the submission did not finish. The block still stands. */
  warning: string | null;
}

interface FolderRow {
  path: string;
  name: string;
  special_use: string | null;
}

const blockedLookup = db.prepare(
  'SELECT 1 AS n FROM blocked_senders WHERE account = ? AND email = ?',
);
const insertBlock = db.prepare(
  `INSERT INTO blocked_senders (account, email, blocked_at)
   VALUES (?, ?, ?)
   ON CONFLICT (account, email) DO NOTHING`,
);
const deleteBlock = db.prepare('DELETE FROM blocked_senders WHERE account = ? AND email = ?');
const listBlocks = db.prepare(
  `SELECT email, blocked_at AS blockedAt
   FROM blocked_senders
   WHERE account = ?
   ORDER BY blocked_at DESC`,
);
const hasBlock = db.prepare('SELECT 1 AS n FROM blocked_senders WHERE account = ? LIMIT 1');

/** One mailbox address, lowercased, or null when the string is not an address. */
export function normalizeEmail(input: string | null | undefined): string | null {
  if (!input) return null;
  let value = input.trim().toLowerCase();
  const wrapped = value.match(/<([^<>\s]+)>/);
  if (wrapped?.[1]) value = wrapped[1].trim().toLowerCase();
  if (value.length > 320 || value.includes('..') || !EMAIL.test(value)) return null;
  return value;
}

export function isSenderBlocked(accountId: string, address: string | null | undefined): boolean {
  const email = normalizeEmail(address);
  if (!email) return false;
  return Boolean(blockedLookup.get(accountId, email));
}

export function listBlockedSenders(accountId: string): BlockedSender[] {
  return listBlocks.all(accountId) as BlockedSender[];
}

export function unblockSender(accountId: string, address: string): boolean {
  const email = normalizeEmail(address);
  if (!email) {
    throw Object.assign(new Error('Adresse illisible'), { status: 400 });
  }
  const result = deleteBlock.run(accountId, email);
  return result.changes > 0;
}

/**
 * Blocks the sender and reports this message. The message leaves its folder
 * for Banned. Sent, drafts and trash stay put, and so does Indésirables: a
 * mailbox may read a move out of its junk folder as "not junk" (unverified for
 * Outlook.com, decided on 2026-11-17 rather than tested on real mail), so mail
 * the server already filed there is hidden from the listing instead.
 * The block and the provider submission still run when the move does not.
 */
export async function reportSpam(
  account: AccountConfig,
  path: string,
  uid: number,
): Promise<SpamResult> {
  const sender = await readSender(account, path, uid);
  if (!sender) {
    throw Object.assign(new Error("Ce message n'a pas d'expéditeur à bloquer"), { status: 400 });
  }
  if (sender.email === normalizeEmail(account.email)) {
    throw Object.assign(new Error('Cette adresse est la vôtre'), { status: 400 });
  }

  const alreadyBlocked = isSenderBlocked(account.id, sender.email);
  insertBlock.run(account.id, sender.email, Date.now());

  const warnings: string[] = [];
  let source: Buffer | null = null;
  if (isMicrosoftAccount(account)) {
    try {
      const downloaded = await downloadSource(account, path, uid);
      if (downloaded.tooBig) {
        warnings.push(
          "Le message dépasse 20 Mo : il est bloqué et classé, sans transmission à Microsoft.",
        );
      } else if (!downloaded.source) {
        warnings.push("Le message n'a pas pu être lu pour le signalement.");
      } else {
        source = downloaded.source;
      }
    } catch (err) {
      warnings.push(`Le message n'a pas pu être lu pour le signalement : ${clip(err)}`);
    }
  }

  try {
    await markJunk(account, path, uid);
  } catch (err) {
    warnings.push(`Le marquage indésirable a échoué : ${clip(err)}`);
  }

  let bannedFolder: string | null = null;
  try {
    bannedFolder = await ensureBannedFolder(account);
  } catch (err) {
    warnings.push(clip(err));
  }

  const alreadyInBanned = bannedFolder != null && bannedFolder === path;
  const leaveInPlace = isFilingSkipped(account.id, path);
  let moved = false;
  if (bannedFolder && !alreadyInBanned && !leaveInPlace) {
    try {
      await moveMessage(account, path, uid, bannedFolder);
      moved = true;
    } catch (err) {
      warnings.push(`Le message n'a pas pu être déplacé : ${clip(err)}`);
    }
  }

  let submitted = false;
  if (source) {
    try {
      await sendNotice(account, {
        to: MICROSOFT_JUNK,
        subject: 'Spam',
        text: 'Spam report.',
        filename: 'message.eml',
        content: source,
        contentType: 'message/rfc822',
      });
      submitted = true;
    } catch (err) {
      warnings.push(`Le signalement à Microsoft n'a pas abouti : ${clip(err)}`);
    }
  }

  // Other copies already in the cache leave with this sender. Mail not cached yet
  // is filed the next time its folder is listed.
  await fileCachedFromSender(account, sender.email).catch((err) => {
    console.error(`[spam:${account.id}] classement — ${clip(err)}`);
  });

  return {
    email: sender.email,
    alreadyBlocked,
    moved,
    hidden: !moved && hidesBlockedMail(account.id, path),
    alreadyInBanned,
    bannedFolder,
    submitted,
    warning: warnings.length ? warnings.join(' ') : null,
  };
}

/**
 * Moves cached mail from blocked senders out of `path` into Banned. Trash,
 * sent, drafts, Indésirables and Banned itself are left alone. Safe to call on
 * every folder listing: it does no IMAP when the account has no block.
 */
export async function fileBlockedSenders(account: AccountConfig, path: string): Promise<number> {
  if (!hasBlock.get(account.id)) return 0;
  if (isFilingSkipped(account.id, path)) return 0;

  const banned = await ensureBannedFolder(account);
  if (banned === path) return 0;

  const own = normalizeEmail(account.email);
  const select = db.prepare(
    `SELECT m.uid AS uid
     FROM messages m
     JOIN blocked_senders b
       ON b.account = m.account AND b.email = lower(trim(m.from_addr))
     WHERE m.account = ? AND m.folder = ?
       AND (? IS NULL OR lower(trim(m.from_addr)) != ?)
     ORDER BY m.date DESC
     LIMIT ?`,
  );

  const rows = select.all(account.id, path, own, own, FILE_BATCH) as { uid: number }[];
  const moved = rows.length
    ? await moveEach(
        account,
        rows.map((row) => ({ folder: path, uid: row.uid })),
        banned,
      )
    : 0;

  if (moved > 0) {
    console.log(`[spam:${account.id}] ${moved} message(s) déplacé(s) vers Banned (${path})`);
  }
  return moved;
}

/** Rows of `alias` (a `messages` alias) whose sender is on the account's block list. */
function blockedSenderSql(alias: string): string {
  return `EXISTS (
    SELECT 1 FROM blocked_senders b
    WHERE b.account = ${alias}.account AND b.email = lower(trim(${alias}.from_addr))
  )`;
}

/**
 * True for the one folder where blocked mail is hidden rather than moved: the
 * junk folder of an account that blocks someone.
 */
export function hidesBlockedMail(accountId: string, path: string): boolean {
  return Boolean(hasBlock.get(accountId)) && isJunkFolder(accountId, path);
}

/** `AND …` clause that drops hidden mail from a listing of `path`, or nothing. */
export function visibleMailSql(accountId: string, path: string, alias: string): string {
  return hidesBlockedMail(accountId, path) ? `AND NOT ${blockedSenderSql(alias)}` : '';
}

/**
 * Hidden mail still counts in the totals the server reports for the folder.
 * Only what is cached can be subtracted, so a count can run high until the
 * folder has been listed.
 */
export function hiddenCounts(accountId: string, path: string): { total: number; unseen: number } {
  if (!hidesBlockedMail(accountId, path)) return { total: 0, unseen: 0 };
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN m.seen = 0 THEN 1 ELSE 0 END), 0) AS unseen
       FROM messages m
       WHERE m.account = ? AND m.folder = ? AND ${blockedSenderSql('m')}`,
    )
    .get(accountId, path) as { total: number; unseen: number };
  return row;
}

/** Search results cross folders, so they are filtered row by row. */
export function isHiddenMessage(
  accountId: string,
  path: string,
  from: string | null | undefined,
): boolean {
  if (!from || !hidesBlockedMail(accountId, path)) return false;
  return Boolean(blockedLookup.get(accountId, from.trim().toLowerCase()));
}

/**
 * New mail on the selected mailbox. The connection can IDLE on only one folder,
 * so this does not see the inbox while another folder is open — listing that
 * folder files whatever was missed.
 */
export function watchBlockedMail() {
  const inflight = new Set<string>();

  onAppEvent((event) => {
    if (event.type !== 'exists' || !event.path) return;
    const account = accounts.find((item) => item.id === event.account);
    if (!account || !hasBlock.get(account.id)) return;
    if (isFilingSkipped(account.id, event.path)) return;

    const key = `${account.id}\0${event.path}`;
    if (inflight.has(key)) return;
    inflight.add(key);

    const folder = event.path;
    void (async () => {
      try {
        await syncMessages(account, folder, 40);
        await fileBlockedSenders(account, folder);
      } catch (err) {
        console.error(`[spam:${account.id}] ${folder} — ${clip(err)}`);
      } finally {
        inflight.delete(key);
      }
    })();
  });
}

async function fileCachedFromSender(account: AccountConfig, email: string): Promise<number> {
  const banned = await ensureBannedFolder(account);
  const skip = folders(account.id)
    .filter((row) => row.path === banned || isFilingSkipped(account.id, row.path))
    .map((row) => row.path);
  const excluded = skip.length ? `AND folder NOT IN (${skip.map(() => '?').join(',')})` : '';
  const select = db.prepare(
    `SELECT folder, uid FROM messages
     WHERE account = ? AND lower(trim(from_addr)) = ?
       AND folder != ?
       ${excluded}
     ORDER BY date DESC
     LIMIT ?`,
  );

  let moved = 0;
  while (moved < BLOCK_SWEEP) {
    const rows = select.all(account.id, email, banned, ...skip, FILE_BATCH) as {
      folder: string;
      uid: number;
    }[];
    if (rows.length === 0) break;
    const count = await moveEach(account, rows, banned);
    if (count === 0) break;
    moved += count;
  }
  if (moved > 0) {
    console.log(`[spam:${account.id}] ${moved} autre(s) message(s) classé(s) dans Banned`);
  }
  return moved;
}

async function moveEach(
  account: AccountConfig,
  rows: { folder: string; uid: number }[],
  banned: string,
): Promise<number> {
  let moved = 0;
  for (const row of rows) {
    try {
      await markJunk(account, row.folder, row.uid);
      await moveMessage(account, row.folder, row.uid, banned);
      moved += 1;
    } catch (err) {
      const message = clip(err);
      if (isConnectionError(message)) {
        console.error(`[spam:${account.id}] classement interrompu — ${message}`);
        break;
      }
      console.warn(`[spam:${account.id}] ${row.folder}:${row.uid} — ${message}`);
    }
  }
  return moved;
}

async function readSender(
  account: AccountConfig,
  path: string,
  uid: number,
): Promise<{ email: string; subject: string | null } | null> {
  const cached = db
    .prepare(
      'SELECT from_addr, subject FROM messages WHERE account = ? AND folder = ? AND uid = ?',
    )
    .get(account.id, path, uid) as { from_addr: string | null; subject: string | null } | undefined;

  const cachedEmail = normalizeEmail(cached?.from_addr);
  if (cachedEmail) return { email: cachedEmail, subject: cached?.subject ?? null };

  const connection = connectionFor(account);
  const message = await connection.withMailbox(path, async (client) =>
    client.fetchOne(String(uid), { envelope: true }, { uid: true }),
  );
  if (!message) return null;
  const email = normalizeEmail(message.envelope?.from?.[0]?.address);
  if (!email) return null;
  return { email, subject: message.envelope?.subject ?? null };
}

async function downloadSource(
  account: AccountConfig,
  path: string,
  uid: number,
): Promise<{ source: Buffer | null; tooBig: boolean }> {
  const connection = connectionFor(account);
  const message = await connection.withMailbox(path, async (client) =>
    client.fetchOne(
      String(uid),
      { size: true, source: { maxLength: MAX_REPORT_BYTES + 1 } },
      { uid: true },
    ),
  );
  if (!message || !message.source) return { source: null, tooBig: false };
  const size = message.size ?? message.source.length;
  if (size > MAX_REPORT_BYTES || message.source.length > MAX_REPORT_BYTES) {
    return { source: null, tooBig: true };
  }
  return { source: Buffer.from(message.source), tooBig: false };
}

/** `$Junk` is the common keyword; `Junk` is what some filters (and Thunderbird) store. */
async function markJunk(account: AccountConfig, path: string, uid: number) {
  try {
    await setFlags(account, path, uid, ['$Junk', 'Junk'], []);
    return;
  } catch (err) {
    console.warn(`[spam:${account.id}] mots-clés groupés refusés — ${clip(err)}`);
  }
  for (const flag of ['$Junk', 'Junk']) {
    try {
      await setFlags(account, path, uid, [flag], []);
      return;
    } catch (err) {
      console.warn(`[spam:${account.id}] ${flag} refusé — ${clip(err)}`);
    }
  }
}

async function ensureBannedFolder(account: AccountConfig): Promise<string> {
  const existing = findBannedFolder(account.id);
  if (existing) return existing;

  if (folders(account.id).length === 0) {
    await syncFolders(account);
    const refreshed = findBannedFolder(account.id);
    if (refreshed) return refreshed;
  }

  const client = await connectionFor(account).get();
  try {
    await client.mailboxCreate('Banned');
  } catch (err) {
    console.warn(`[spam:${account.id}] création de Banned — ${clip(err)}`);
  }
  await syncFolders(account);
  const created = findBannedFolder(account.id);
  if (!created) {
    throw new Error("Le dossier Banned n'a pas pu être créé.");
  }
  return created;
}

function findBannedFolder(accountId: string): string | null {
  const matches = folders(accountId).filter((row) => fold(row.name) === BANNED_NAME);
  return matches.find((row) => row.path === 'Banned')?.path ?? matches[0]?.path ?? null;
}

function findJunkFolder(accountId: string): string | null {
  const rows = folders(accountId);
  const special = rows.find((row) => row.special_use === '\\Junk');
  if (special) return special.path;

  let best: { path: string; rank: number } | null = null;
  for (const row of rows) {
    const rank = JUNK_RANK[fold(row.name)];
    if (rank == null) continue;
    if (!best || rank < best.rank) best = { path: row.path, rank };
  }
  return best?.path ?? null;
}

function isJunkFolder(accountId: string, path: string): boolean {
  return findJunkFolder(accountId) === path;
}

function isFilingSkipped(accountId: string, path: string): boolean {
  const row = folders(accountId).find((item) => item.path === path);
  const leaf = path.split(/[./\\]/).pop() ?? path;
  const name = fold(row?.name ?? leaf);
  if (name === BANNED_NAME) return true;
  if (row?.special_use && SKIP_SPECIAL.has(row.special_use)) return true;
  if (SKIP_NAMES.has(name)) return true;
  // The server's own verdict stands: nothing is pulled out of the junk folder.
  if (isJunkFolder(accountId, path)) return true;
  return false;
}

function folders(accountId: string): FolderRow[] {
  return db
    .prepare('SELECT path, name, special_use FROM folders WHERE account = ?')
    .all(accountId) as FolderRow[];
}

function fold(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

function clip(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function isConnectionError(message: string): boolean {
  return /connection not available|connection closed|socket|econnreset|etimedout|not connected/i.test(
    message,
  );
}
