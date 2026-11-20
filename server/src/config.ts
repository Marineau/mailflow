import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export type AuthMode = 'password' | 'oauth2';
export type OAuthProvider = 'microsoft' | 'google';

export interface OAuthConfig {
  provider: OAuthProvider;
  clientId: string;
  /** Microsoft only: `consumers`, `common`, `organizations` or a tenant id. */
  tenant: string;
  /**
   * Google only. Google's token endpoint wants it even with PKCE; for an app
   * installed on the user's own machine it is not a real secret, but it is
   * still never returned by the API.
   */
  clientSecret: string;
}

export interface AccountConfig {
  id: string;
  label: string;
  /**
   * Nom public de l'en-tête From. Distinct du `label`, qui n'est qu'un surnom
   * dans la barre latérale (« Perso », « Pro »…) et ne doit pas partir chez
   * le destinataire.
   */
  fromName: string;
  email: string;
  authMode: AuthMode;
  /** Renseigné uniquement en `authMode: 'password'`. */
  pass: string;
  /** Renseigné uniquement en `authMode: 'oauth2'`. */
  oauth: OAuthConfig | null;
  /**
   * `env`: declared in `.env`, read-only from the interface. `app`: added from
   * the interface, kept encrypted in `server/data/accounts.json` (accountStore.ts).
   */
  source: 'env' | 'app';
  imap: { host: string; port: number; secure: boolean; user: string };
  smtp: { host: string; port: number; secure: boolean; user: string };
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** Racine du serveur (`server/`), quel que soit l'endroit d'où node est lancé. */
export const SERVER_ROOT = path.resolve(here, '..');
export const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..');

/**
 * Le `.env` vit à la racine du projet, mais npm lance les scripts depuis
 * `server/` : se fier au dossier courant ferait silencieusement démarrer le
 * serveur sans aucun compte. On résout donc le chemin depuis ce fichier.
 */
const ENV_PATH = [path.join(PROJECT_ROOT, '.env'), path.join(SERVER_ROOT, '.env')].find(
  (candidate) => fs.existsSync(candidate),
);

if (ENV_PATH) {
  dotenv.config({ path: ENV_PATH });
} else {
  console.warn(`Aucun .env trouvé (cherché dans ${PROJECT_ROOT} et ${SERVER_ROOT}).`);
}

/**
 * Where the cache, the tokens and the interface accounts live. `server/data`
 * by default. `MAILFLOW_DATA_DIR` (environment or `.env`) moves it: the
 * packaged app points it under %APPDATA%, because its install folder is
 * replaced by every update. Read after `.env` is loaded, for that reason.
 */
const dataDirOverride = process.env.MAILFLOW_DATA_DIR?.trim();
export const DATA_DIR = dataDirOverride
  ? path.resolve(dataDirOverride)
  : path.join(SERVER_ROOT, 'data');
export const DB_PATH = path.join(DATA_DIR, 'mailflow.sqlite');

export const PORT = Number(process.env.PORT ?? 4100);
export const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
export const OAUTH_REDIRECT_URI = `${PUBLIC_URL}/api/oauth/callback`;

/**
 * Plafond du cache des mails ouverts : corps en base plus pièces jointes sur
 * disque. Les en-têtes et l'index de recherche n'en font pas partie.
 * `CACHE_MAX_MB` dans `.env`, 500 par défaut ; une valeur illisible ou
 * inférieure à 50 retombe sur le défaut plutôt que de vider le cache.
 */
const cacheMaxMb = Number(process.env.CACHE_MAX_MB);
export const CACHE_MAX_BYTES =
  (Number.isFinite(cacheMaxMb) && cacheMaxMb >= 50 ? cacheMaxMb : 500) * 1024 * 1024;

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Configuration incomplète : ${key} est vide dans .env`);
  return value;
}

/**
 * Les comptes se déclarent en série indexée (MAIL_1_*, MAIL_2_*…). On s'arrête
 * au premier index sans `_ID` : les trous silencieux coûtent plus cher à
 * diagnostiquer qu'un compte manquant au démarrage.
 */
export function loadAccounts(): AccountConfig[] {
  const accounts: AccountConfig[] = [];

  for (let i = 1; ; i++) {
    const id = process.env[`MAIL_${i}_ID`];
    if (!id) break;

    const user = requireEnv(`MAIL_${i}_USER`);
    const authMode = (process.env[`MAIL_${i}_AUTH`] ?? 'password') as AuthMode;

    if (authMode !== 'password' && authMode !== 'oauth2') {
      throw new Error(`MAIL_${i}_AUTH doit valoir « password » ou « oauth2 ».`);
    }

    accounts.push({
      id,
      label: process.env[`MAIL_${i}_LABEL`] ?? id,
      fromName: process.env[`MAIL_${i}_FROM_NAME`]?.trim() ?? '',
      email: requireEnv(`MAIL_${i}_EMAIL`),
      authMode,
      pass: authMode === 'password' ? requireEnv(`MAIL_${i}_PASS`) : '',
      source: 'env',
      oauth:
        authMode === 'oauth2'
          ? {
              provider:
                process.env[`MAIL_${i}_OAUTH_PROVIDER`] === 'google' ? 'google' : 'microsoft',
              clientId: requireEnv(`MAIL_${i}_OAUTH_CLIENT_ID`),
              clientSecret: process.env[`MAIL_${i}_OAUTH_CLIENT_SECRET`] ?? '',
              // « consumers » = comptes Microsoft personnels. « common » accepte
              // aussi les comptes professionnels.
              tenant: process.env[`MAIL_${i}_OAUTH_TENANT`] ?? 'consumers',
            }
          : null,
      imap: {
        host: requireEnv(`MAIL_${i}_IMAP_HOST`),
        port: Number(process.env[`MAIL_${i}_IMAP_PORT`] ?? 993),
        secure: (process.env[`MAIL_${i}_IMAP_SECURE`] ?? 'true') !== 'false',
        user,
      },
      smtp: {
        host: requireEnv(`MAIL_${i}_SMTP_HOST`),
        port: Number(process.env[`MAIL_${i}_SMTP_PORT`] ?? 587),
        secure: (process.env[`MAIL_${i}_SMTP_SECURE`] ?? 'false') === 'true',
        user,
      },
    });
  }

  return accounts;
}

/**
 * Every account the server knows. Mutable on purpose: accountStore.ts adds and
 * removes the accounts managed from the interface in this same array, so every
 * module that imported it sees them.
 */
export const accounts = loadAccounts();

/**
 * App-level OAuth clients, offered as defaults when an account is added from
 * the interface. A client id is public (it travels in the consent URL); the
 * Google secret never leaves the server. Without `MS_OAUTH_CLIENT_ID`, the id
 * of the first Microsoft account in `.env` is reused: it is the same Entra app.
 */
export const oauthDefaults = {
  microsoftClientId:
    process.env.MS_OAUTH_CLIENT_ID?.trim() ||
    accounts.find((a) => a.oauth?.provider === 'microsoft')?.oauth?.clientId ||
    '',
  googleClientId: process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() ?? '',
  googleClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() ?? '',
};

/**
 * Compte hébergé chez Microsoft (Outlook.com, Exchange Online). Deux choses en
 * dépendent : le signalement d'indésirable à Microsoft, et la copie des envois,
 * que ces serveurs rangent eux-mêmes dans « Envoyés ». OAuth2 n'existe ici que
 * pour Microsoft et Google ; en mot de passe, c'est le nom d'hôte qui le dit.
 */
export function isMicrosoftAccount(account: AccountConfig): boolean {
  if (account.authMode === 'oauth2') return account.oauth?.provider !== 'google';
  const host = `${account.imap.host}\n${account.smtp.host}`.toLowerCase();
  return /outlook\.|office365\.|hotmail\.|live\.com|microsoft\./.test(host);
}

/** Gmail (OAuth2 or app password). */
export function isGoogleAccount(account: AccountConfig): boolean {
  if (account.oauth?.provider === 'google') return true;
  return /(^|\.)gmail\.com$|googlemail\.com$/.test(account.imap.host.toLowerCase());
}

/**
 * The provider files every message submitted over its SMTP into « Envoyés »
 * itself: Exchange does, and so does Gmail. A copy appended by mailFlow would
 * be a duplicate.
 */
export function serverFilesSentMail(account: AccountConfig): boolean {
  return isMicrosoftAccount(account) || isGoogleAccount(account);
}

export function getAccount(id: string): AccountConfig {
  const account = accounts.find((a) => a.id === id);
  if (!account) throw Object.assign(new Error(`Compte inconnu : ${id}`), { status: 404 });
  return account;
}
