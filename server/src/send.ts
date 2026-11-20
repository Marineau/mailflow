import nodemailer, { type SentMessageInfo, type Transporter } from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { serverFilesSentMail, type AccountConfig } from './config.js';
import { connectionFor } from './imap.js';
import { getAccessToken } from './oauth.js';
import { db } from './db.js';
import { sanitizeOutgoingHtml } from './outgoingHtml.js';
import { noProgress, type ProgressReporter } from './progress.js';

/** 10 Mo par fichier, 20 Mo au total : le corps JSON plafonne à 32 Mo, base64 compris. */
const MAX_ATTACHMENTS = 20;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS_BYTES = 20 * 1024 * 1024;

/** Une capture collée dans le texte. Pas de SVG : un fichier image ne doit pas porter de script. */
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);
const INLINE_CID = /^[A-Za-z0-9._-]{1,80}$/;

export interface OutgoingAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  /** Présent seulement pour une image affichée dans le corps (`cid:`). */
  cid?: string;
}

export interface OutgoingMail {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string | null;
  references?: string[];
  attachments?: OutgoingAttachment[];
}

/**
 * Le client envoie le fichier en base64 dans le JSON. On n'accepte ni chemin
 * disque ni URL : un nom de fichier ne doit jamais devenir une lecture locale.
 */
export function parseOutgoingAttachments(input: unknown): OutgoingAttachment[] {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw Object.assign(new Error('Les pièces jointes doivent être une liste'), { status: 400 });
  }
  if (input.length > MAX_ATTACHMENTS) {
    throw Object.assign(new Error(`Trop de pièces jointes (maximum ${MAX_ATTACHMENTS})`), {
      status: 400,
    });
  }

  let total = 0;
  const cids = new Set<string>();
  return input.map((item) => {
    if (!item || typeof item !== 'object') {
      throw Object.assign(new Error('Pièce jointe illisible'), { status: 400 });
    }
    const raw = item as {
      filename?: unknown;
      contentType?: unknown;
      content?: unknown;
      cid?: unknown;
    };
    const filename = safeFilename(raw.filename);
    const content = decodeAttachment(raw.content, filename);
    if (content.length > MAX_ATTACHMENT_BYTES) {
      throw Object.assign(new Error(`« ${filename} » dépasse 10 Mo`), { status: 400 });
    }
    total += content.length;
    if (total > MAX_ATTACHMENTS_BYTES) {
      throw Object.assign(new Error('Les pièces jointes dépassent 20 Mo au total'), { status: 400 });
    }
    const contentType = safeContentType(raw.contentType);
    const cid = safeCid(raw.cid, filename, contentType);
    if (cid) {
      if (cids.has(cid)) {
        throw Object.assign(new Error('Deux images du message portent le même identifiant'), {
          status: 400,
        });
      }
      cids.add(cid);
    }
    return { filename, contentType, content, ...(cid ? { cid } : {}) };
  });
}

function safeCid(input: unknown, filename: string, contentType: string): string | undefined {
  if (input == null || input === '') return undefined;
  if (typeof input !== 'string' || !INLINE_CID.test(input)) {
    throw Object.assign(new Error('Image du message illisible'), { status: 400 });
  }
  if (!INLINE_IMAGE_TYPES.has(contentType)) {
    throw Object.assign(new Error(`« ${filename} » ne peut pas s'afficher dans le message`), {
      status: 400,
    });
  }
  return input;
}

function safeFilename(input: unknown): string {
  const raw = typeof input === 'string' ? input : '';
  const base = raw.split(/[/\\]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  return cleaned.slice(0, 180) || 'piece-jointe';
}

function safeContentType(input: unknown): string {
  if (typeof input !== 'string') return 'application/octet-stream';
  const type = input.split(';')[0]?.trim().toLowerCase() ?? '';
  if (/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) return type;
  return 'application/octet-stream';
}

function decodeAttachment(input: unknown, filename: string): Buffer {
  if (typeof input !== 'string') {
    throw Object.assign(new Error(`« ${filename} » est illisible`), { status: 400 });
  }
  const compact = input.replace(/\s/g, '');
  if (compact.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) {
    throw Object.assign(new Error(`« ${filename} » dépasse 10 Mo`), { status: 400 });
  }
  if (compact !== '' && (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0)) {
    throw Object.assign(new Error(`« ${filename} » n'est pas un fichier valide`), { status: 400 });
  }
  return Buffer.from(compact, 'base64');
}

const transports = new Map<string, Transporter>();

/** Ferme les sockets SMTP gardées pour les comptes en mot de passe. */
export function closeTransports() {
  for (const transport of transports.values()) transport.close();
  transports.clear();
}

/** Drops the kept SMTP socket of one account, once it is removed. */
export function closeTransport(accountId: string) {
  transports.get(accountId)?.close();
  transports.delete(accountId);
}

/**
 * En OAuth2 le transport est reconstruit à chaque envoi : le jeton d'accès a une
 * durée de vie d'une heure, un transport mis en cache enverrait un jeton périmé.
 */
async function transportFor(account: AccountConfig): Promise<Transporter> {
  const base = {
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
  };

  if (account.authMode === 'oauth2') {
    return nodemailer.createTransport({
      ...base,
      auth: {
        type: 'OAuth2',
        user: account.smtp.user,
        accessToken: await getAccessToken(account),
      },
    });
  }

  let transport = transports.get(account.id);
  if (!transport) {
    transport = nodemailer.createTransport({
      ...base,
      auth: { user: account.smtp.user, pass: account.pass },
    });
    transports.set(account.id, transport);
  }
  return transport;
}

function sentFolderPath(accountId: string): string | null {
  const row = db
    .prepare(
      `SELECT path FROM folders
       WHERE account = ? AND (special_use = '\\Sent' OR lower(name) IN ('sent','envoyés','éléments envoyés'))
       ORDER BY special_use IS NULL LIMIT 1`,
    )
    .get(accountId) as { path: string } | undefined;
  return row?.path ?? null;
}

/**
 * Assumed SMTP upload rate, only to pace the send button between checkpoints:
 * nodemailer reports nothing while it streams the message.
 */
const SMTP_BYTES_PER_MS = 300;

export async function sendMail(
  account: AccountConfig,
  mail: OutgoingMail,
  report: ProgressReporter = noProgress,
) {
  if (!mail.to.length) {
    throw Object.assign(new Error('Au moins un destinataire est requis'), { status: 400 });
  }

  const attachments = mail.attachments ?? [];
  const cids = new Set(attachments.flatMap((file) => (file.cid ? [file.cid] : [])));
  // Le HTML n'existe que si le message porte une mise en forme ou une capture.
  // Il repasse par une liste blanche : une balise ou une image distante ne part pas.
  const html = mail.html ? sanitizeOutgoingHtml(mail.html, cids) : undefined;

  const composer = new MailComposer({
    // Le label du compte (« Perso ») est un surnom local. Sans nom public
    // explicite, on n'envoie que l'adresse : le destinataire ne doit pas voir
    // le surnom de la barre latérale.
    from: account.fromName
      ? { name: account.fromName, address: account.email }
      : account.email,
    to: mail.to,
    cc: mail.cc,
    bcc: mail.bcc,
    subject: mail.subject,
    text: mail.text,
    html,
    inReplyTo: mail.inReplyTo ?? undefined,
    references: mail.references?.length ? mail.references : undefined,
    attachments: attachments.length
      ? attachments.map((file) => ({
          filename: file.filename,
          content: file.content,
          contentType: file.contentType,
          // `cid` place l'image dans le corps. Sans cid, c'est un fichier joint.
          contentDisposition: file.cid ? ('inline' as const) : ('attachment' as const),
          ...(file.cid ? { cid: file.cid } : {}),
        }))
      : undefined,
    disableFileAccess: true,
    disableUrlAccess: true,
  });

  // The client spends 0 to 0.1 reading the attachments; building is next.
  report(0.1, 0.15);
  const raw = await composer.compile().build();

  const willAppend = !serverFilesSentMail(account) && Boolean(sentFolderPath(account.id));
  report(0.15, willAppend ? 0.85 : 0.97, 1200 + raw.length / SMTP_BYTES_PER_MS);
  const transport = await transportFor(account);
  // OAuth reconstruit un transport à chaque envoi. Sans close(), la socket SMTP
  // reste dans le pool de cet objet jusqu'au ramasse-miettes.
  const ephemeral = account.authMode === 'oauth2';
  let info: SentMessageInfo;
  try {
    info = await transport.sendMail({
      envelope: {
        from: account.email,
        to: [...mail.to, ...(mail.cc ?? []), ...(mail.bcc ?? [])],
      },
      raw,
    });
  } finally {
    if (ephemeral) transport.close();
  }

  // Sans APPEND, le mail envoyé n'existe que dans le journal SMTP : il faut le
  // déposer soi-même dans « Envoyés », un serveur IMAP ordinaire ne le fait pas.
  // `copiedTo` reste nul si l'APPEND échoue : l'interface ne doit pas annoncer
  // une copie qui n'a pas eu lieu.
  //
  // Microsoft fait exception : Outlook.com range lui-même dans « Envoyés » tout
  // message soumis par SMTP. Un APPEND en plus y stockait chaque envoi deux fois
  // (421 paires relevées dans le cache le 2026-11-17). Pour ces comptes, la copie
  // est celle du serveur, et `copiedBy` le dit à l'interface.
  const sentPath = sentFolderPath(account.id);
  let copiedTo: string | null = null;
  let copiedBy: 'mailflow' | 'server' | null = null;
  let copyError: string | null = null;
  // Gmail does the same (serverFilesSentMail).
  if (serverFilesSentMail(account)) {
    copiedTo = sentPath;
    copiedBy = 'server';
  } else if (sentPath) {
    try {
      report(0.85, 0.97, 800 + raw.length / SMTP_BYTES_PER_MS);
      const client = await connectionFor(account).get();
      await client.append(sentPath, raw, ['\\Seen']);
      copiedTo = sentPath;
      copiedBy = 'mailflow';
    } catch (err) {
      copyError = errorText(err);
      console.error(`[smtp:${account.id}] copie dans « ${sentPath} » échouée :`, err);
    }
  }

  return {
    ok: true as const,
    accepted: smtpAddresses(info.accepted),
    rejected: smtpAddresses(info.rejected),
    copiedTo,
    copiedBy,
    copyError,
  };
}

/**
 * Envoie un avis sans le déposer dans « Envoyés ». Le signalement d'indésirable
 * joint le message d'origine : un APPEND en plus de la copie que range Outlook
 * stockerait ce spam deux fois.
 */
export async function sendNotice(
  account: AccountConfig,
  notice: {
    to: string;
    subject: string;
    text: string;
    filename: string;
    content: Buffer;
    contentType: string;
  },
): Promise<void> {
  const composer = new MailComposer({
    from: account.fromName
      ? { name: account.fromName, address: account.email }
      : account.email,
    to: notice.to,
    subject: notice.subject,
    text: notice.text,
    attachments: [
      {
        filename: notice.filename,
        content: notice.content,
        contentType: notice.contentType,
        contentDisposition: 'attachment' as const,
      },
    ],
    disableFileAccess: true,
    disableUrlAccess: true,
  });

  const raw = await composer.compile().build();
  const transport = await transportFor(account);
  const ephemeral = account.authMode === 'oauth2';
  try {
    const info = await transport.sendMail({
      envelope: { from: account.email, to: [notice.to] },
      raw,
    });
    const rejected = smtpAddresses(info.rejected);
    if (rejected.length > 0) {
      throw new Error(`Destinataire refusé : ${rejected.join(', ')}`);
    }
  } finally {
    if (ephemeral) transport.close();
  }
}

function smtpAddresses(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const address = item.trim();
      if (address) out.push(address);
      continue;
    }
    if (item && typeof item === 'object' && 'address' in item && typeof item.address === 'string') {
      const address = item.address.trim();
      if (address) out.push(address);
    }
  }
  return out;
}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, ' ').trim().slice(0, 240);
}

export async function verifySmtp(account: AccountConfig) {
  const transport = await transportFor(account);
  try {
    await transport.verify();
  } finally {
    if (account.authMode === 'oauth2') transport.close();
  }
}
