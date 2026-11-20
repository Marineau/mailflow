import fs from 'node:fs';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import type { AccountConfig } from './config.js';
import { DATA_DIR } from './config.js';
import { db } from './db.js';
import { connectionFor } from './imap.js';

/**
 * Slot kept off the interface connection. Slot 0 stays in IDLE and serves
 * the message list; a download waiting on it sits behind every prefetch.
 * The indexer uses slots 1–4.
 */
const ATTACHMENT_SLOT = 7;

const ROOT = path.join(DATA_DIR, 'attachments');

export interface StoredAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

interface AttachmentMeta {
  filename?: string;
  contentType?: string;
}

const inflight = new Map<string, Promise<void>>();

function folderKey(folder: string): string {
  return Buffer.from(folder, 'utf8').toString('base64url');
}

function filePath(accountId: string, folder: string, uid: number, index: number): string {
  return path.join(ROOT, accountId, folderKey(folder), String(uid), String(index));
}

function readMeta(accountId: string, folder: string, uid: number, index: number): AttachmentMeta | null {
  const row = db
    .prepare('SELECT attachments FROM bodies WHERE account = ? AND folder = ? AND uid = ?')
    .get(accountId, folder, uid) as { attachments: string } | undefined;
  if (!row) return null;
  try {
    const list = JSON.parse(row.attachments) as AttachmentMeta[];
    return list[index] ?? null;
  } catch {
    return null;
  }
}

/** Writes the bytes already parsed while opening a message. */
export function storeAttachmentBytes(
  accountId: string,
  folder: string,
  uid: number,
  files: { index: number; content: Buffer }[],
): void {
  for (const file of files) {
    if (!Buffer.isBuffer(file.content) || file.content.length === 0) continue;
    const target = filePath(accountId, folder, uid, file.index);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp`;
    fs.writeFileSync(temporary, file.content);
    fs.renameSync(temporary, target);
  }
}

/** Drops every stored file of one folder, once its UIDs no longer name the same messages. */
export function dropFolderAttachments(accountId: string, folder: string): void {
  fs.rmSync(path.join(ROOT, accountId, folderKey(folder)), { recursive: true, force: true });
}

/** Drops the stored files of one message: it was moved, deleted, or evicted from the cache. */
export function dropMessageAttachments(accountId: string, folder: string, uid: number): void {
  fs.rmSync(path.join(ROOT, accountId, folderKey(folder), String(uid)), {
    recursive: true,
    force: true,
  });
}

/** Drops every stored file: the bodies that name them are gone. */
export function dropAllAttachments(): void {
  fs.rmSync(ROOT, { recursive: true, force: true });
}

export interface AttachmentUsage {
  accountId: string;
  folder: string;
  uid: number;
  bytes: number;
  /** Most recent write among the message's files. */
  modifiedAt: number;
}

function subdirectories(directory: string): string[] {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** What the attachment store holds on disk, one entry per message. */
export function attachmentUsage(): AttachmentUsage[] {
  const usage: AttachmentUsage[] = [];
  for (const accountId of subdirectories(ROOT)) {
    for (const key of subdirectories(path.join(ROOT, accountId))) {
      const folder = Buffer.from(key, 'base64url').toString('utf8');
      for (const name of subdirectories(path.join(ROOT, accountId, key))) {
        const uid = Number(name);
        if (!Number.isInteger(uid) || uid < 1) continue;

        const directory = path.join(ROOT, accountId, key, name);
        let bytes = 0;
        let modifiedAt = 0;
        try {
          for (const file of fs.readdirSync(directory)) {
            const stat = fs.statSync(path.join(directory, file));
            if (!stat.isFile()) continue;
            bytes += stat.size;
            modifiedAt = Math.max(modifiedAt, stat.mtimeMs);
          }
        } catch {
          // A file removed while the store is being walked: count what was read.
        }
        usage.push({ accountId, folder, uid, bytes, modifiedAt });
      }
    }
  }
  return usage;
}

export function readAttachmentFile(
  accountId: string,
  folder: string,
  uid: number,
  index: number,
): Buffer | null {
  const target = filePath(accountId, folder, uid, index);
  if (!fs.existsSync(target)) return null;
  return fs.readFileSync(target);
}

async function fetchAndStore(account: AccountConfig, folder: string, uid: number): Promise<void> {
  const connection = connectionFor(account, ATTACHMENT_SLOT);
  await connection.withMailbox(folder, async (client) => {
    const downloaded = await client.download(String(uid), undefined, { uid: true });
    if (!downloaded?.content) {
      throw Object.assign(new Error('Message introuvable'), { status: 404 });
    }
    const parsed = await simpleParser(downloaded.content, { skipImageLinks: true });
    storeAttachmentBytes(
      account.id,
      folder,
      uid,
      parsed.attachments.map((attachment, index) => ({
        index,
        content: Buffer.isBuffer(attachment.content)
          ? attachment.content
          : Buffer.from(attachment.content ?? []),
      })),
    );
  });
}

function ensureStored(account: AccountConfig, folder: string, uid: number): Promise<void> {
  const key = `${account.id}\0${folder}\0${uid}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const job = fetchAndStore(account, folder, uid).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, job);
  return job;
}

/**
 * Serves one attachment. Bytes saved when the message was opened come back
 * from disk. A miss uses its own IMAP connection, then fills the cache for
 * the other files of the same message.
 */
export async function loadAttachment(
  account: AccountConfig,
  folder: string,
  uid: number,
  index: number,
): Promise<StoredAttachment> {
  if (!Number.isInteger(uid) || uid < 1 || !Number.isInteger(index) || index < 0) {
    throw Object.assign(new Error('Pièce jointe introuvable'), { status: 404 });
  }

  let content = readAttachmentFile(account.id, folder, uid, index);
  if (!content) {
    await ensureStored(account, folder, uid);
    content = readAttachmentFile(account.id, folder, uid, index);
  }
  if (!content) throw Object.assign(new Error('Pièce jointe introuvable'), { status: 404 });

  const meta = readMeta(account.id, folder, uid, index);
  return {
    filename: meta?.filename || 'piece-jointe',
    contentType: meta?.contentType || 'application/octet-stream',
    content,
  };
}
