import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

/**
 * Encryption at rest for the secrets of accounts added from the interface
 * (IMAP/SMTP passwords, a Google client secret). AES-256-GCM, one random IV
 * per value.
 *
 * The key comes from `MAILFLOW_SECRET_KEY` (32 bytes, base64) when set: in
 * `.env`, or handed over by the packaged app, which keeps it encrypted by
 * Windows for the user's account (`desktop/main.ts`). Otherwise it is
 * generated once into `secret.key` in the data folder (mode 600). That default
 * protects `accounts.json` copied or backed up on its own, not a reader of
 * the whole data folder.
 */

const KEY_PATH = path.join(DATA_DIR, 'secret.key');
let cachedKey: Buffer | null = null;

/**
 * True when the key is kept away from the data folder. Only then is sealing
 * the OAuth tokens worth it (oauth.ts): with the key next to them, the file
 * would be as readable as before, and harder to repair.
 */
export function keyIsExternal(): boolean {
  return Boolean(process.env.MAILFLOW_SECRET_KEY?.trim());
}

function key(): Buffer {
  if (cachedKey) return cachedKey;

  const fromEnv = process.env.MAILFLOW_SECRET_KEY?.trim();
  if (fromEnv) {
    const decoded = Buffer.from(fromEnv, 'base64');
    if (decoded.length !== 32) {
      throw new Error('MAILFLOW_SECRET_KEY doit contenir 32 octets encodés en base64.');
    }
    cachedKey = decoded;
    return decoded;
  }

  if (fs.existsSync(KEY_PATH)) {
    cachedKey = Buffer.from(fs.readFileSync(KEY_PATH, 'utf8').trim(), 'base64');
    return cachedKey;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const generated = crypto.randomBytes(32);
  fs.writeFileSync(KEY_PATH, generated.toString('base64'), { mode: 0o600 });
  cachedKey = generated;
  return generated;
}

/** `v1:<iv>:<tag>:<ciphertext>`, each part base64. */
export function seal(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data].map((part) =>
    typeof part === 'string' ? part : part.toString('base64'),
  ).join(':');
}

export function open(sealed: string): string {
  const [version, iv, tag, data] = sealed.split(':');
  if (version !== 'v1' || !iv || !tag || data === undefined) {
    throw new Error('Secret chiffré illisible.');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}
