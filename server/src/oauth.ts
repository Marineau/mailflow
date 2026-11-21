import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, OAUTH_REDIRECT_URI, type AccountConfig } from './config.js';
import { keyIsExternal, open, seal } from './secretBox.js';

/**
 * OAuth2 « client public » avec PKCE : pas de secret client à stocker, ce qui
 * est le bon modèle pour une app qui tourne sur le poste de l'utilisateur — un
 * secret embarqué dans du code local n'en est pas un.
 */

const MICROSOFT_SCOPES = [
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'https://outlook.office.com/SMTP.Send',
  'offline_access',
  'openid',
  'email',
].join(' ');

/**
 * Gmail has a single scope for IMAP and SMTP over XOAUTH2. Google classes it
 * as « restricted »: an app left in « Testing » publishing status gets refresh
 * tokens that expire after 7 days (docs/accounts.md).
 */
const GOOGLE_SCOPES = 'https://mail.google.com/';

const TOKENS_PATH = path.join(DATA_DIR, 'tokens.json');

interface StoredToken {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
}

type TokenStore = Record<string, StoredToken>;

/** A sealed file is one `v1:…` line (secretBox.ts); a plain one is JSON. */
function isSealed(raw: string): boolean {
  return raw.startsWith('v1:');
}

function readStore(): TokenStore {
  if (!fs.existsSync(TOKENS_PATH)) return {};
  try {
    const raw = fs.readFileSync(TOKENS_PATH, 'utf8').trim();
    return JSON.parse(isSealed(raw) ? open(raw) : raw) as TokenStore;
  } catch {
    console.error('[oauth] tokens.json illisible — il sera réécrit au prochain consentement.');
    return {};
  }
}

function writeStore(store: TokenStore) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const json = JSON.stringify(store, null, 2);
  // Les jetons valent un mot de passe : lecture réservée au propriétaire.
  // Sealed when the key lives away from the data folder (packaged app, or
  // MAILFLOW_SECRET_KEY in `.env`): the file alone then gives nothing.
  fs.writeFileSync(TOKENS_PATH, keyIsExternal() ? seal(json) : json, { mode: 0o600 });
}

// A file written in clear before the key moved out is sealed at startup,
// rather than at the next token refresh.
if (keyIsExternal() && fs.existsSync(TOKENS_PATH)) {
  try {
    if (!isSealed(fs.readFileSync(TOKENS_PATH, 'utf8').trim())) writeStore(readStore());
  } catch (err) {
    console.error(`[oauth] tokens.json n'a pas pu être chiffré : ${(err as Error).message}`);
  }
}

export function hasToken(accountId: string): boolean {
  return Boolean(readStore()[accountId]?.refreshToken);
}

export function forgetToken(accountId: string) {
  const store = readStore();
  delete store[accountId];
  writeStore(store);
}

/** État transitoire du consentement en cours, le temps de l'aller-retour navigateur. */
const pending = new Map<string, { accountId: string; verifier: string; createdAt: number }>();

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function endpoints(account: AccountConfig): { authorize: string; token: string } {
  if (account.oauth?.provider === 'google') {
    return {
      authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
      token: 'https://oauth2.googleapis.com/token',
    };
  }
  const base = `https://login.microsoftonline.com/${account.oauth?.tenant || 'consumers'}/oauth2/v2.0`;
  return { authorize: `${base}/authorize`, token: `${base}/token` };
}

export function buildAuthorizeUrl(account: AccountConfig): string {
  if (!account.oauth) {
    throw Object.assign(new Error(`Le compte ${account.id} n'est pas en mode oauth2`), {
      status: 400,
    });
  }

  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));

  pending.set(state, { accountId: account.id, verifier, createdAt: Date.now() });

  // Un consentement abandonné ne doit pas rester en mémoire indéfiniment.
  for (const [key, value] of pending) {
    if (Date.now() - value.createdAt > 10 * 60_000) pending.delete(key);
  }

  const common = {
    client_id: account.oauth.clientId,
    response_type: 'code',
    redirect_uri: OAUTH_REDIRECT_URI,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    login_hint: account.email,
  };

  const params =
    account.oauth.provider === 'google'
      ? new URLSearchParams({
          ...common,
          scope: GOOGLE_SCOPES,
          // Without both, Google hands out no refresh token on a second consent.
          access_type: 'offline',
          prompt: 'consent',
        })
      : new URLSearchParams({
          ...common,
          scope: MICROSOFT_SCOPES,
          response_mode: 'query',
          prompt: 'select_account',
        });

  return `${endpoints(account).authorize}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  error?: string;
  error_description?: string;
}

async function postToken(
  account: AccountConfig,
  body: Record<string, string>,
): Promise<TokenResponse> {
  const oauth = account.oauth!;
  const client: Record<string, string> = { client_id: oauth.clientId };
  if (oauth.provider === 'google') client.client_secret = oauth.clientSecret;

  const res = await fetch(endpoints(account).token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...client, ...body }).toString(),
  });

  const payload = (await res.json()) as TokenResponse;

  if (!res.ok || payload.error) {
    throw Object.assign(
      new Error(payload.error_description ?? payload.error ?? `HTTP ${res.status}`),
      { status: 400 },
    );
  }

  return payload;
}

export function resolvePending(state: string) {
  const entry = pending.get(state);
  if (!entry) {
    throw Object.assign(new Error('Consentement expiré ou inconnu — relancez la connexion.'), {
      status: 400,
    });
  }
  pending.delete(state);
  return entry;
}

export async function exchangeCode(account: AccountConfig, code: string, verifier: string) {
  const payload = await postToken(account, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: OAUTH_REDIRECT_URI,
    code_verifier: verifier,
  });

  if (!payload.refresh_token) {
    throw new Error(
      account.oauth?.provider === 'google'
        ? "Google n'a pas renvoyé de refresh token : retirez l'accès de Pli dans votre compte Google, puis recommencez."
        : "Microsoft n'a pas renvoyé de refresh token : le scope `offline_access` manque.",
    );
  }

  const store = readStore();
  store[account.id] = {
    refreshToken: payload.refresh_token,
    accessToken: payload.access_token,
    expiresAt: Date.now() + payload.expires_in * 1000,
  };
  writeStore(store);
}

/**
 * Jeton d'accès valide, rafraîchi si besoin. La marge de 60 s évite de partir
 * en connexion IMAP avec un jeton qui expire pendant la poignée de main.
 */
export async function getAccessToken(account: AccountConfig): Promise<string> {
  const store = readStore();
  const stored = store[account.id];

  if (!stored) {
    throw Object.assign(
      new Error(`Compte « ${account.id} » non autorisé — ouvrez /api/accounts/${account.id}/oauth`),
      { status: 401 },
    );
  }

  if (stored.accessToken && stored.expiresAt > Date.now() + 60_000) {
    return stored.accessToken;
  }

  const payload = await postToken(account, {
    grant_type: 'refresh_token',
    refresh_token: stored.refreshToken,
  });

  store[account.id] = {
    // Microsoft fait tourner les refresh tokens : garder l'ancien mènerait à
    // une déconnexion silencieuse quelques jours plus tard.
    refreshToken: payload.refresh_token ?? stored.refreshToken,
    accessToken: payload.access_token,
    expiresAt: Date.now() + payload.expires_in * 1000,
  };
  writeStore(store);

  return payload.access_token;
}
