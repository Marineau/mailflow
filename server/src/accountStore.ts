import fs from 'node:fs';
import path from 'node:path';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import {
  accounts,
  DATA_DIR,
  oauthDefaults,
  type AccountConfig,
  type OAuthProvider,
} from './config.js';
import { db } from './db.js';
import { dropFolderAttachments } from './attachments.js';
import { forgetToken } from './oauth.js';
import { open, seal } from './secretBox.js';
import { noProgress, type ProgressReporter } from './progress.js';

/**
 * Accounts added from the interface, next to the ones declared in `.env`.
 *
 * They live in `server/data/accounts.json`. Everything a reader could use to
 * log in (password, Google client secret) is sealed with secretBox.ts; host
 * names, ports and addresses stay readable. OAuth tokens keep living in
 * `tokens.json`, as for `.env` accounts.
 *
 * Loaded accounts are pushed into the shared `accounts` array of config.ts:
 * every module that imported it sees them without a restart.
 */

const STORE_PATH = path.join(DATA_DIR, 'accounts.json');

interface StoredAccount {
  id: string;
  label: string;
  fromName: string;
  email: string;
  authMode: 'password' | 'oauth2';
  passSealed?: string;
  oauth?: {
    provider: OAuthProvider;
    clientId: string;
    tenant: string;
    clientSecretSealed?: string;
  };
  imap: { host: string; port: number; secure: boolean; user: string };
  smtp: { host: string; port: number; secure: boolean; user: string };
}

function readStore(): StoredAccount[] {
  if (!fs.existsSync(STORE_PATH)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as unknown;
    return Array.isArray(parsed) ? (parsed as StoredAccount[]) : [];
  } catch (err) {
    // Refuse to go on rather than overwrite a file someone could still repair.
    throw new Error(`accounts.json illisible : ${(err as Error).message}`);
  }
}

function writeStore(list: StoredAccount[]) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(list, null, 2), { mode: 0o600 });
}

function toConfig(stored: StoredAccount): AccountConfig {
  return {
    id: stored.id,
    label: stored.label,
    fromName: stored.fromName,
    email: stored.email,
    authMode: stored.authMode,
    pass: stored.passSealed ? open(stored.passSealed) : '',
    source: 'app',
    oauth: stored.oauth
      ? {
          provider: stored.oauth.provider,
          clientId: stored.oauth.clientId,
          tenant: stored.oauth.tenant,
          clientSecret: stored.oauth.clientSecretSealed
            ? open(stored.oauth.clientSecretSealed)
            : '',
        }
      : null,
    imap: stored.imap,
    smtp: stored.smtp,
  };
}

/** Called once at startup, before the first sync. An `.env` id wins over a stored one. */
export function loadStoredAccounts(): number {
  let added = 0;
  for (const stored of readStore()) {
    if (accounts.some((a) => a.id === stored.id)) {
      console.warn(`[accounts] ${stored.id} existe déjà dans .env : la copie enregistrée est ignorée.`);
      continue;
    }
    try {
      accounts.push(toConfig(stored));
      added += 1;
    } catch (err) {
      console.error(`[accounts] ${stored.id} illisible (${(err as Error).message}) : ignoré.`);
    }
  }
  return added;
}

/** What the interface sends to test or add an account. */
export interface AccountInput {
  email: string;
  label?: string;
  fromName?: string;
  authMode: 'password' | 'oauth2';
  password?: string;
  provider?: OAuthProvider;
  clientId?: string;
  clientSecret?: string;
  tenant?: string;
  imap: { host: string; port: number; secure: boolean; user?: string };
  smtp: { host: string; port: number; secure: boolean; user?: string };
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function server(
  input: AccountInput['imap'] | undefined,
  name: string,
  user: string,
): AccountConfig['imap'] {
  const host = String(input?.host ?? '').trim().toLowerCase();
  const port = Number(input?.port);
  if (!HOST.test(host)) throw badRequest(`Serveur ${name} invalide : « ${host || 'vide'} ».`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw badRequest(`Port ${name} invalide.`);
  }
  return {
    host,
    port,
    secure: Boolean(input?.secure),
    user: String(input?.user ?? '').trim() || user,
  };
}

function slug(email: string): string {
  const base =
    email
      .toLowerCase()
      .replace(/@.*/, '')
      .normalize('NFD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'compte';
  let id = base;
  for (let n = 2; accounts.some((a) => a.id === id); n++) id = `${base}-${n}`;
  return id;
}

/** Validates the form into a full account, not yet saved nor connected. */
export function buildAccount(input: AccountInput): AccountConfig {
  const email = String(input?.email ?? '').trim();
  if (!EMAIL.test(email)) throw badRequest('Adresse e-mail invalide.');
  if (accounts.some((a) => a.email.toLowerCase() === email.toLowerCase())) {
    throw badRequest(`${email} est déjà configuré dans mailFlow.`);
  }

  const imap = server(input.imap, 'IMAP', email);
  const smtp = server(input.smtp, 'SMTP', imap.user);
  const base = {
    id: slug(email),
    label: String(input.label ?? '').trim().slice(0, 40) || email,
    fromName: String(input.fromName ?? '').trim().slice(0, 80),
    email,
    source: 'app' as const,
    imap,
    smtp,
  };

  if (input.authMode === 'password') {
    const pass = String(input.password ?? '');
    if (!pass) throw badRequest('Le mot de passe est vide.');
    return { ...base, authMode: 'password', pass, oauth: null };
  }

  if (input.authMode !== 'oauth2') throw badRequest('Mode de connexion inconnu.');

  const provider: OAuthProvider = input.provider === 'google' ? 'google' : 'microsoft';
  const clientId =
    String(input.clientId ?? '').trim() ||
    (provider === 'google' ? oauthDefaults.googleClientId : oauthDefaults.microsoftClientId);
  const clientSecret =
    provider === 'google'
      ? String(input.clientSecret ?? '').trim() || oauthDefaults.googleClientSecret
      : '';
  if (!clientId) throw badRequest("L'identifiant de l'application OAuth est vide.");
  if (provider === 'google' && !clientSecret) {
    throw badRequest("Le secret client de l'application Google est vide.");
  }

  return {
    ...base,
    authMode: 'oauth2',
    pass: '',
    oauth: {
      provider,
      clientId,
      clientSecret,
      tenant: provider === 'microsoft' ? String(input.tenant ?? '').trim() || 'consumers' : '',
    },
  };
}

/**
 * Logs in once to IMAP and SMTP with a password account, without keeping
 * either connection. OAuth accounts are tested by their consent instead.
 */
export async function testPasswordAccount(
  account: AccountConfig,
  report: ProgressReporter = noProgress,
): Promise<{ imap: string | null; smtp: string | null }> {
  // Two logins of a few seconds each; saving afterwards is instant.
  report(0, 0.5, 2500);
  const result: { imap: string | null; smtp: string | null } = { imap: null, smtp: null };

  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: { user: account.imap.user, pass: account.pass },
    logger: false,
    emitLogs: false,
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
    await client.logout();
  } catch (err) {
    result.imap = describeFailure(err);
    try {
      client.close();
    } catch {
      /* already closed */
    }
  }

  report(0.5, 0.97, 2500);
  const transport = nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: { user: account.smtp.user, pass: account.pass },
    connectionTimeout: 15_000,
  });
  try {
    await transport.verify();
  } catch (err) {
    result.smtp = describeFailure(err);
  } finally {
    transport.close();
  }

  return result;
}

/** A server's refusal, in words a user can act on; the raw reply stays attached. */
function describeFailure(err: unknown): string {
  const e = err as Error & {
    code?: string;
    authenticationFailed?: boolean;
    responseText?: string;
    response?: string;
  };
  const raw = e.responseText || e.response || e.message || String(err);
  if (e.authenticationFailed || /auth|535|login|credentials|password/i.test(raw)) {
    return `Identifiant ou mot de passe refusé (${raw}).`;
  }
  // nodemailer reports DNS failures as `EDNS`, with ENOTFOUND in the message.
  if (e.code === 'ENOTFOUND' || e.code === 'EDNS' || /ENOTFOUND|EAI_AGAIN/.test(raw)) {
    return 'Serveur introuvable : vérifiez son nom.';
  }
  if (e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT' || /timeout/i.test(raw)) {
    return 'Le serveur ne répond pas sur ce port : vérifiez le port et le chiffrement.';
  }
  if (/wrong version number|ssl|tls/i.test(raw)) {
    return 'Chiffrement incompatible : essayez l’autre réglage SSL/TLS pour ce port.';
  }
  return raw;
}

/** Saves the account and makes it live in the shared list. */
export function saveAccount(account: AccountConfig) {
  const list = readStore();
  list.push({
    id: account.id,
    label: account.label,
    fromName: account.fromName,
    email: account.email,
    authMode: account.authMode,
    passSealed: account.authMode === 'password' ? seal(account.pass) : undefined,
    oauth: account.oauth
      ? {
          provider: account.oauth.provider,
          clientId: account.oauth.clientId,
          tenant: account.oauth.tenant,
          clientSecretSealed: account.oauth.clientSecret
            ? seal(account.oauth.clientSecret)
            : undefined,
        }
      : undefined,
    imap: account.imap,
    smtp: account.smtp,
  });
  writeStore(list);
  accounts.push(account);
}

/**
 * Forgets an account added from the interface: its entry, its OAuth token and
 * everything cached for it. The mailbox on the server is not touched.
 * Connections must be closed by the caller first (imap.ts).
 */
export function deleteStoredAccount(id: string) {
  const account = accounts.find((a) => a.id === id);
  if (!account) throw Object.assign(new Error(`Compte inconnu : ${id}`), { status: 404 });
  if (account.source !== 'app') {
    throw badRequest('Ce compte est déclaré dans .env : retirez-le de ce fichier.');
  }

  writeStore(readStore().filter((entry) => entry.id !== id));
  accounts.splice(accounts.indexOf(account), 1);
  forgetToken(id);

  const folders = db.prepare('SELECT path FROM folders WHERE account = ?').all(id) as {
    path: string;
  }[];
  db.transaction(() => {
    for (const table of [
      'messages',
      'bodies',
      'messages_fts',
      'index_state',
      'senders',
      'blocked_senders',
      'folders',
    ]) {
      db.prepare(`DELETE FROM ${table} WHERE account = ?`).run(id);
    }
  })();
  for (const folder of folders) dropFolderAttachments(id, folder.path);
}
