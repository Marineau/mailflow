import { simpleParser } from 'mailparser';
import type { ImapFlow } from 'imapflow';
import type { AccountConfig } from './config.js';
import { connectionFor } from './imap.js';
import { noProgress, type ProgressReporter } from './progress.js';
import { db, deleteBody, deleteMessage, indexForSearch, upsertMessage } from './db.js';
import { makeSnippet, sanitizeMailHtml } from './sanitize.js';
import { findTextPart } from './bodyparts.js';
import {
  dropFolderAttachments,
  dropMessageAttachments,
  loadAttachment,
  storeAttachmentBytes,
} from './attachments.js';
import { deferHeavyImages, type InlineAttachment } from './inlineImages.js';

export interface FolderSummary {
  path: string;
  name: string;
  delimiter: string | null;
  specialUse: string | null;
  total: number;
  unseen: number;
}

const upsertFolder = db.prepare(`
INSERT INTO folders (account, path, name, delimiter, special_use, subscribed, uid_validity, total, unseen, synced_at)
VALUES (@account, @path, @name, @delimiter, @special_use, 1, @uid_validity, @total, @unseen, @synced_at)
ON CONFLICT (account, path) DO UPDATE SET
  name = excluded.name,
  delimiter = excluded.delimiter,
  special_use = excluded.special_use,
  uid_validity = excluded.uid_validity,
  total = excluded.total,
  unseen = excluded.unseen,
  synced_at = excluded.synced_at
`);

const storedValidity = db.prepare(
  'SELECT uid_validity FROM folders WHERE account = ? AND path = ?',
);
const storeValidity = db.prepare(
  'UPDATE folders SET uid_validity = ? WHERE account = ? AND path = ?',
);
const touchBody = db.prepare(
  'UPDATE bodies SET opened_at = ? WHERE account = ? AND folder = ? AND uid = ?',
);

/**
 * Un UID ne désigne un message que sous un UIDVALIDITY donné. Quand le serveur
 * en émet un nouveau (boîte reconstruite, restaurée, recréée sous le même nom),
 * tout ce qui est en cache pour ce dossier peut décrire un autre message :
 * les en-têtes d'un mail s'afficheraient avec le corps et les pièces jointes
 * d'un autre. On jette donc le dossier entier — en-têtes, corps, index, fichiers.
 * Le cache est jetable, le serveur fait autorité.
 *
 * L'état d'indexation part avec : rien ne se réindexe tout seul, c'est à
 * l'utilisateur de relancer.
 *
 * À appeler avant toute écriture dans `messages` pour ce dossier.
 */
export function checkUidValidity(accountId: string, path: string, current: string | null): void {
  if (!current) return;
  const row = storedValidity.get(accountId, path) as { uid_validity: string | null } | undefined;
  if (!row || row.uid_validity === current) return;

  if (row.uid_validity) {
    const dropped = db.transaction(() => {
      const { changes } = db
        .prepare('DELETE FROM messages WHERE account = ? AND folder = ?')
        .run(accountId, path);
      db.prepare('DELETE FROM bodies WHERE account = ? AND folder = ?').run(accountId, path);
      db.prepare('DELETE FROM messages_fts WHERE account = ? AND folder = ?').run(accountId, path);
      db.prepare('DELETE FROM index_state WHERE account = ? AND folder = ?').run(accountId, path);
      return changes;
    })();
    dropFolderAttachments(accountId, path);
    console.warn(
      `[sync:${accountId}] ${path} — UIDVALIDITY ${row.uid_validity} → ${current}, ` +
        `cache du dossier vidé (${dropped} en-têtes)`,
    );
  }

  storeValidity.run(current, accountId, path);
}

export async function syncFolders(account: AccountConfig): Promise<FolderSummary[]> {
  const connection = connectionFor(account);
  const client = await connection.get();
  const list = await client.list();

  const summaries: FolderSummary[] = [];

  for (const box of list) {
    if (box.flags?.has('\\Noselect')) continue;

    let total = 0;
    let unseen = 0;
    let uidValidity: string | null = null;

    try {
      const status = await client.status(box.path, {
        messages: true,
        unseen: true,
        uidValidity: true,
      });
      total = status.messages ?? 0;
      unseen = status.unseen ?? 0;
      uidValidity = status.uidValidity != null ? String(status.uidValidity) : null;
    } catch {
      // Certains serveurs refusent STATUS sur des boîtes exotiques : on la liste
      // quand même, les compteurs se rempliront à l'ouverture.
    }

    checkUidValidity(account.id, box.path, uidValidity);

    upsertFolder.run({
      account: account.id,
      path: box.path,
      name: box.name,
      delimiter: box.delimiter ?? null,
      special_use: box.specialUse ?? null,
      uid_validity: uidValidity,
      total,
      unseen,
      synced_at: Date.now(),
    });

    summaries.push({
      path: box.path,
      name: box.name,
      delimiter: box.delimiter ?? null,
      specialUse: box.specialUse ?? null,
      total,
      unseen,
    });
  }

  return summaries;
}

export const FETCH_HEADERS = {
  uid: true,
  flags: true,
  size: true,
  envelope: true,
  bodyStructure: true,
} as const;

type FetchedMessage = {
  uid: number;
  size?: number;
  flags?: Set<string>;
  envelope?: {
    messageId?: string;
    inReplyTo?: string;
    subject?: string;
    date?: Date;
    from?: { name?: string; address?: string }[];
    to?: unknown[];
    cc?: unknown[];
  };
  bodyStructure?: unknown;
};

export function toMessageRow(msg: FetchedMessage, accountId: string, path: string) {
  const envelope = msg.envelope ?? {};
  const flags = msg.flags ?? new Set<string>();
  const sender = envelope.from?.[0];
  // La structure est là, gratuitement : on note où se trouve le texte pour que
  // l'indexation n'ait pas à la redemander.
  const textPart = findTextPart(msg.bodyStructure);

  return {
    account: accountId,
    folder: path,
    uid: msg.uid,
    message_id: envelope.messageId ?? null,
    in_reply_to: envelope.inReplyTo ?? null,
    references_: null,
    subject: envelope.subject ?? null,
    from_name: sender?.name ?? null,
    from_addr: sender?.address ?? null,
    to_addrs: JSON.stringify(envelope.to ?? []),
    cc_addrs: JSON.stringify(envelope.cc ?? []),
    date: (envelope.date ?? new Date()).getTime(),
    size: msg.size ?? null,
    seen: flags.has('\\Seen') ? 1 : 0,
    flagged: flags.has('\\Flagged') ? 1 : 0,
    answered: flags.has('\\Answered') ? 1 : 0,
    draft: flags.has('\\Draft') ? 1 : 0,
    has_attach: hasAttachment(msg.bodyStructure) ? 1 : 0,
    snippet: null,
    text_part: textPart?.part ?? null,
    text_type: textPart?.type ?? null,
    text_encoding: textPart?.encoding ?? null,
    text_charset: textPart?.charset ?? null,
    text_size: textPart?.size ?? null,
  };
}

function hasAttachment(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const part = node as { disposition?: string; childNodes?: unknown[] };
  if (part.disposition?.toLowerCase() === 'attachment') return true;
  return (part.childNodes ?? []).some(hasAttachment);
}

/**
 * Rapatrie les en-têtes d'une boîte. `limit` borne le premier passage : sur une
 * INBOX de 30 000 mails, tout charger d'un coup bloque l'UI plusieurs minutes
 * pour un écran qui n'en affiche que cinquante.
 */
export async function syncMessages(
  account: AccountConfig,
  path: string,
  limit = 200,
  report: ProgressReporter = noProgress,
): Promise<number> {
  const connection = connectionFor(account);
  // Steps of a refresh: opening the folder (up to 0.2), the headers (0.2 to
  // 0.85, one checkpoint every few messages); the caller owns the rest.
  report(0, 0.2);

  return connection.withMailbox(path, async (client: ImapFlow) => {
    const mailbox = client.mailbox;
    if (!mailbox || typeof mailbox === 'boolean') return 0;

    // La boîte vient d'être ouverte : c'est la valeur la plus fraîche qu'on
    // puisse avoir, avant d'écrire quoi que ce soit sous ces UID.
    checkUidValidity(
      account.id,
      path,
      mailbox.uidValidity != null ? String(mailbox.uidValidity) : null,
    );
    if (mailbox.exists === 0) return 0;

    const from = Math.max(1, mailbox.exists - limit + 1);
    const range = `${from}:*`;
    const expected = mailbox.exists - from + 1;
    const share = (n: number) => 0.2 + (0.65 * Math.min(n, expected)) / expected;
    report(0.2, share(10));

    let count = 0;
    const write = db.transaction((rows: Parameters<typeof upsertMessage.run>[0][]) => {
      for (const row of rows) upsertMessage.run(row);
    });

    const batch: Parameters<typeof upsertMessage.run>[0][] = [];

    for await (const msg of client.fetch(range, FETCH_HEADERS)) {
      batch.push(toMessageRow(msg, account.id, path));
      count += 1;
      if (count % 5 === 0) report(share(count), share(count + 10));
    }

    write(batch);
    report(0.85, 0.85);
    return count;
  });
}

/**
 * Recherche déléguée au serveur IMAP (`SEARCH TEXT` : en-têtes et corps).
 * C'est le seul moyen de trouver un mot dans un mail jamais téléchargé.
 * En contrepartie c'est un aller-retour réseau, donc plus lent que FTS.
 *
 * Les en-têtes trouvés sont écrits en base au passage : une recherche enrichit
 * le cache au lieu de le laisser tel quel.
 */
export async function searchOnServer(
  account: AccountConfig,
  path: string,
  query: string,
  limit = 200,
): Promise<number[]> {
  const connection = connectionFor(account);

  return connection.withMailbox(path, async (client) => {
    // TEXT couvre les en-têtes et le corps. BODY + SUBJECT ratait un mail
    // dont l'adresse n'apparaît que dans le champ À ou De.
    const uids = await client.search({ text: query }, { uid: true });
    if (!uids || uids.length === 0) return [];

    // Les UID sont croissants : les plus récents sont en fin de liste.
    const recent = uids.slice(-limit);

    const write = db.transaction((rows: Parameters<typeof upsertMessage.run>[0][]) => {
      for (const row of rows) upsertMessage.run(row);
    });

    const batch: Parameters<typeof upsertMessage.run>[0][] = [];
    for await (const msg of client.fetch({ uid: recent.join(',') }, FETCH_HEADERS, { uid: true })) {
      batch.push(toMessageRow(msg, account.id, path));
    }
    write(batch);

    return recent;
  });
}

export interface FullMessage {
  uid: number;
  folder: string;
  account: string;
  subject: string;
  from: { name: string; address: string } | null;
  to: { name: string; address: string }[];
  cc: { name: string; address: string }[];
  date: number;
  messageId: string | null;
  references: string[];
  html: string | null;
  text: string | null;
  /**
   * Ressources distantes retenues, que « Afficher » rétablit : les `<img>`,
   * mais aussi les adresses nommées dans le CSS (fonds, `@import`, polices).
   */
  blockedImages: number;
  /** Photos laissées hors du HTML, réaffichées sur clic. */
  inlineImages: number;
  attachments: { filename: string; contentType: string; size: number; cid: string | null }[];
}

/**
 * Retire les photos du HTML servi. Le texte part tout de suite ; les images
 * lourdes restent des fichiers, réaffichées quand on le demande.
 */
function presentHtml(
  accountId: string,
  folder: string,
  uid: number,
  html: string | null,
  attachments: InlineAttachment[],
): { html: string | null; inlineImages: number; attachments: InlineAttachment[] } {
  if (!html) return { html, inlineImages: 0, attachments };
  return deferHeavyImages(html, accountId, folder, uid, attachments);
}

/** Corps complet, servi depuis le cache si on l'a déjà téléchargé. */
export async function getMessageBody(
  account: AccountConfig,
  path: string,
  uid: number,
): Promise<FullMessage> {
  const cached = db
    .prepare('SELECT * FROM bodies WHERE account = ? AND folder = ? AND uid = ?')
    .get(account.id, path, uid) as
    | { html: string | null; text: string | null; attachments: string; headers: string }
    | undefined;

  const header = db
    .prepare('SELECT * FROM messages WHERE account = ? AND folder = ? AND uid = ?')
    .get(account.id, path, uid) as Record<string, unknown> | undefined;

  if (cached && header) {
    // L'éviction part du moins récemment ouvert : chaque lecture le fait savoir.
    touchBody.run(Date.now(), account.id, path, uid);
    const meta = JSON.parse(cached.headers) as Partial<FullMessage>;
    const attachments = JSON.parse(cached.attachments) as InlineAttachment[];
    const presented = presentHtml(account.id, path, uid, cached.html, attachments);
    if (
      presented.html !== cached.html ||
      JSON.stringify(presented.attachments) !== cached.attachments
    ) {
      db.prepare(
        `UPDATE bodies SET html = ?, attachments = ? WHERE account = ? AND folder = ? AND uid = ?`,
      ).run(presented.html, JSON.stringify(presented.attachments), account.id, path, uid);
    }
    return {
      uid,
      folder: path,
      account: account.id,
      subject: (header.subject as string) ?? '',
      from: meta.from ?? null,
      to: meta.to ?? [],
      cc: meta.cc ?? [],
      date: header.date as number,
      messageId: (header.message_id as string) ?? null,
      references: meta.references ?? [],
      html: presented.html,
      text: cached.text,
      blockedImages: meta.blockedImages ?? 0,
      inlineImages: presented.inlineImages,
      attachments: presented.attachments,
    };
  }

  const connection = connectionFor(account);

  return connection.withMailbox(path, async (client) => {
    const downloaded = await client.download(String(uid), undefined, { uid: true });
    if (!downloaded?.content) {
      throw Object.assign(new Error('Message introuvable sur le serveur'), { status: 404 });
    }

    const parsed = await simpleParser(downloaded.content, { skipImageLinks: true });

    const sanitized = parsed.html ? sanitizeMailHtml(parsed.html) : null;
    const attachments = parsed.attachments.map((a) => ({
      filename: a.filename ?? 'sans-nom',
      contentType: a.contentType,
      size: a.size,
      cid: a.cid ?? null,
    }));
    storeAttachmentBytes(
      account.id,
      path,
      uid,
      parsed.attachments.map((attachment, index) => ({
        index,
        content: Buffer.isBuffer(attachment.content)
          ? attachment.content
          : Buffer.from(attachment.content ?? []),
      })),
    );

    const toList = normalizeAddresses(parsed.to);
    const ccList = normalizeAddresses(parsed.cc);
    const fromEntry = normalizeAddresses(parsed.from)[0] ?? null;
    const references = Array.isArray(parsed.references)
      ? parsed.references
      : parsed.references
        ? [parsed.references]
        : [];

    const presented = presentHtml(account.id, path, uid, sanitized?.html ?? null, attachments);

    const message: FullMessage = {
      uid,
      folder: path,
      account: account.id,
      subject: parsed.subject ?? '',
      from: fromEntry,
      to: toList,
      cc: ccList,
      date: (parsed.date ?? new Date()).getTime(),
      messageId: parsed.messageId ?? null,
      references,
      html: presented.html,
      text: parsed.text ?? null,
      blockedImages: sanitized?.blockedImages ?? 0,
      inlineImages: presented.inlineImages,
      attachments: presented.attachments,
    };

    const fetchedAt = Date.now();
    db.prepare(
      `INSERT INTO bodies (account, folder, uid, html, text, attachments, headers, fetched_at, opened_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (account, folder, uid) DO UPDATE SET
         html = excluded.html, text = excluded.text,
         attachments = excluded.attachments, headers = excluded.headers,
         fetched_at = excluded.fetched_at, opened_at = excluded.opened_at`,
    ).run(
      account.id,
      path,
      uid,
      message.html,
      message.text,
      JSON.stringify(message.attachments),
      JSON.stringify({
        from: message.from,
        to: toList,
        cc: ccList,
        references,
        blockedImages: message.blockedImages,
      }),
      fetchedAt,
      fetchedAt,
    );

    const snippet = makeSnippet(parsed.text, parsed.html || undefined);
    db.prepare('UPDATE messages SET snippet = ? WHERE account = ? AND folder = ? AND uid = ?').run(
      snippet,
      account.id,
      path,
      uid,
    );

    indexForSearch({
      account: account.id,
      folder: path,
      uid,
      subject: message.subject,
      from_addr: fromEntry?.address ?? null,
      from_name: fromEntry?.name ?? null,
      body: parsed.text ?? snippet,
    });

    return message;
  });
}

type AddressLike =
  | { value: { name?: string; address?: string }[] }
  | { value: { name?: string; address?: string }[] }[]
  | undefined;

function normalizeAddresses(input: AddressLike): { name: string; address: string }[] {
  if (!input) return [];
  const groups = Array.isArray(input) ? input : [input];
  return groups.flatMap((group) =>
    (group.value ?? [])
      .filter((entry) => entry.address)
      .map((entry) => ({ name: entry.name ?? '', address: entry.address as string })),
  );
}

export async function downloadAttachment(
  account: AccountConfig,
  path: string,
  uid: number,
  index: number,
) {
  return loadAttachment(account, path, uid, index);
}

export async function setFlags(
  account: AccountConfig,
  path: string,
  uid: number,
  add: string[],
  remove: string[],
) {
  const connection = connectionFor(account);
  await connection.withMailbox(path, async (client) => {
    if (add.length) await client.messageFlagsAdd({ uid: String(uid) }, add, { uid: true });
    if (remove.length) await client.messageFlagsRemove({ uid: String(uid) }, remove, { uid: true });
  });

  const columns: Record<string, string> = {
    '\\Seen': 'seen',
    '\\Flagged': 'flagged',
    '\\Answered': 'answered',
  };

  for (const flag of add) {
    const column = columns[flag];
    if (column) {
      db.prepare(
        `UPDATE messages SET ${column} = 1 WHERE account = ? AND folder = ? AND uid = ?`,
      ).run(account.id, path, uid);
    }
  }
  for (const flag of remove) {
    const column = columns[flag];
    if (column) {
      db.prepare(
        `UPDATE messages SET ${column} = 0 WHERE account = ? AND folder = ? AND uid = ?`,
      ).run(account.id, path, uid);
    }
  }
}

export async function moveMessage(
  account: AccountConfig,
  path: string,
  uid: number,
  target: string,
) {
  const connection = connectionFor(account);
  await connection.withMailbox(path, async (client) => {
    await client.messageMove({ uid: String(uid) }, target, { uid: true });
  });
  // Le message a un nouvel UID dans la boîte cible : la ligne locale ne vaut plus rien,
  // ses pièces jointes sur disque non plus.
  deleteMessage.run(account.id, path, uid);
  deleteBody.run(account.id, path, uid);
  dropMessageAttachments(account.id, path, uid);
}

export async function deleteMessagePermanently(
  account: AccountConfig,
  path: string,
  uid: number,
) {
  const connection = connectionFor(account);
  await connection.withMailbox(path, async (client) => {
    await client.messageDelete({ uid: String(uid) }, { uid: true });
  });
  deleteMessage.run(account.id, path, uid);
  deleteBody.run(account.id, path, uid);
  dropMessageAttachments(account.id, path, uid);
}
