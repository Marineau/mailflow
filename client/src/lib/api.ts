import { OP_HEADER } from './progress';

export interface Account {
  id: string;
  label: string;
  email: string;
  authMode: 'password' | 'oauth2';
  /** OAuth provider, `null` for a password account. Absent from an older server. */
  provider?: 'microsoft' | 'google' | null;
  /** `env`: declared in `.env`, read-only here. `app`: added from the interface. */
  source?: 'env' | 'app';
  authorized: boolean;
}

/** What the « add an account » form learns from the server. No secret in it. */
export interface AccountSetupInfo {
  microsoftClientId: string;
  googleClientId: string;
  googleSecretConfigured: boolean;
  redirectUri: string;
}

export interface ServerSettings {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
}

export interface AccountInput {
  email: string;
  label?: string;
  fromName?: string;
  authMode: 'password' | 'oauth2';
  password?: string;
  provider?: 'microsoft' | 'google';
  clientId?: string;
  clientSecret?: string;
  tenant?: string;
  imap: ServerSettings;
  smtp: ServerSettings;
}

/** Each part is `null` when it logged in, else the reason it did not. */
export interface AccountTest {
  imap: string | null;
  smtp: string | null;
}

export interface Folder {
  path: string;
  name: string;
  delimiter: string | null;
  specialUse: string | null;
  total: number;
  unseen: number;
}

export interface MessageSummary {
  uid: number;
  folder: string;
  account: string;
  subject: string;
  from: { name: string; address: string };
  to: { name?: string; address?: string }[];
  date: number;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  hasAttachments: boolean;
  snippet: string;
  size: number | null;
  /** L'expéditeur est dans la liste de blocage de ce compte. */
  senderBlocked?: boolean;
  /**
   * Phrase(s) du corps contenant les termes cherchés. Les occurrences sont
   * encadrées par U+0001 et U+0002 — des caractères de contrôle, jamais du
   * HTML : le contenu vient d'un mail, il ne doit pas pouvoir injecter de balise.
   */
  excerpt?: string | null;
}

export const MARK_START = '\u0001';
export const MARK_END = '\u0002';

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
  blockedImages: number;
  /** Photos laissées hors du HTML. `0` si le serveur ne le dit pas encore. */
  inlineImages?: number;
  attachments: { filename: string; contentType: string; size: number; cid: string | null }[];
}

export interface Sender {
  email: string;
  name: string | null;
  lastSeen: number;
}

export interface BlockedSender {
  email: string;
  blockedAt: number;
}

export interface SpamResult {
  email: string;
  alreadyBlocked: boolean;
  moved: boolean;
  /** Le message reste dans les indésirables, où il n'est plus listé. */
  hidden?: boolean;
  alreadyInBanned: boolean;
  bannedFolder: string | null;
  submitted: boolean;
  warning: string | null;
}

export interface IndexState {
  account: string;
  folder: string;
  phase: 'idle' | 'headers' | 'bodies' | 'done' | 'error';
  headersDone: number;
  headersTotal: number;
  bodiesDone: number;
  bodiesTotal: number;
  error: string | null;
}

export type SearchScope = 'local' | 'folder' | 'all';

export interface SearchResult {
  messages: MessageSummary[];
  scope: SearchScope;
  /** Dossiers réellement interrogés sur le serveur IMAP. */
  searchedFolders: string[];
  /** Dossiers ayant refusé la recherche — le reste des résultats reste valide. */
  errors: string[];
  /** Couverture de l'index local, pour ne pas faire passer un index vide pour une absence de résultats. */
  coverage: { indexed: number; total: number };
}

/** Names a request so the server can report its progress (lib/progress.ts). */
function opHeaders(op?: string | null): Record<string, string> {
  return op ? { [OP_HEADER]: op } : {};
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  accounts: () => request<Account[]>('/api/accounts'),

  accountSetup: () => request<AccountSetupInfo>('/api/account-setup'),

  testAccount: (input: AccountInput, op?: string | null) =>
    request<AccountTest>('/api/accounts/test', {
      method: 'POST',
      body: JSON.stringify(input),
      headers: opHeaders(op),
    }),

  addAccount: (input: AccountInput, op?: string | null) =>
    request<Account>('/api/accounts', {
      method: 'POST',
      body: JSON.stringify(input),
      headers: opHeaders(op),
    }),

  removeAccount: (accountId: string) =>
    request<{ ok: true }>(`/api/accounts/${accountId}`, { method: 'DELETE' }),

  folders: (accountId: string, refresh = false) =>
    request<Folder[]>(`/api/accounts/${accountId}/folders${refresh ? '?refresh=1' : ''}`),

  senders: (accountId: string) => request<Sender[]>(`/api/accounts/${accountId}/senders`),

  messages: (accountId: string, path: string, offset = 0, limit = 50, op?: string | null) =>
    request<MessageSummary[]>(
      `/api/accounts/${accountId}/messages?path=${encodeURIComponent(path)}&offset=${offset}&limit=${limit}`,
      { headers: opHeaders(op) },
    ),

  message: (accountId: string, path: string, uid: number) =>
    request<FullMessage>(
      `/api/accounts/${accountId}/message?path=${encodeURIComponent(path)}&uid=${uid}`,
    ),

  search: (
    q: string,
    accountId: string | null,
    path: string,
    scope: SearchScope,
    op?: string | null,
  ) => {
    const params = new URLSearchParams({ q, scope, path });
    if (accountId) params.set('account', accountId);
    return request<SearchResult>(`/api/search?${params.toString()}`, { headers: opHeaders(op) });
  },

  setFlags: (accountId: string, path: string, uid: number, add: string[], remove: string[]) =>
    request<{ ok: true }>(`/api/accounts/${accountId}/flags`, {
      method: 'POST',
      body: JSON.stringify({ path, uid, add, remove }),
    }),

  move: (accountId: string, path: string, uid: number, target: string) =>
    request<{ ok: true }>(`/api/accounts/${accountId}/move`, {
      method: 'POST',
      body: JSON.stringify({ path, uid, target }),
    }),

  remove: (accountId: string, path: string, uid: number) =>
    request<{ ok: true }>(
      `/api/accounts/${accountId}/message?path=${encodeURIComponent(path)}&uid=${uid}`,
      { method: 'DELETE' },
    ),

  blockedSenders: (accountId: string) =>
    request<BlockedSender[]>(`/api/accounts/${accountId}/blocked`),

  unblockSender: (accountId: string, email: string) =>
    request<{ ok: true; removed: boolean }>(`/api/accounts/${accountId}/blocked`, {
      method: 'DELETE',
      body: JSON.stringify({ email }),
    }),

  /** Bloque l'expéditeur et signale le message, même s'il est déjà dans les indésirables. */
  reportSpam: (accountId: string, path: string, uid: number) =>
    request<SpamResult>(`/api/accounts/${accountId}/spam`, {
      method: 'POST',
      body: JSON.stringify({ path, uid }),
    }),

  send: (
    accountId: string,
    mail: {
      to: string;
      cc?: string;
      bcc?: string;
      subject: string;
      text: string;
      html?: string;
      inReplyTo?: string | null;
      references?: string[];
      attachments?: { filename: string; contentType: string; content: string; cid?: string }[];
    },
    op?: string | null,
  ) =>
    request<{
      ok: true;
      accepted: string[];
      rejected: string[];
      copiedTo: string | null;
      /** `server` : la boîte range elle-même la copie (Outlook.com), mailFlow n'en dépose pas. */
      copiedBy?: 'mailflow' | 'server' | null;
      copyError: string | null;
    }>(`/api/accounts/${accountId}/send`, {
      method: 'POST',
      body: JSON.stringify(mail),
      headers: opHeaders(op),
    }),

  indexStatus: (accountId: string) => request<IndexState[]>(`/api/accounts/${accountId}/index`),

  startIndex: (accountId: string, path?: string) =>
    request<IndexState[]>(`/api/accounts/${accountId}/index`, {
      method: 'POST',
      body: JSON.stringify(path ? { path } : {}),
    }),

  cancelIndex: (accountId: string, path: string) =>
    request<{ ok: true }>(
      `/api/accounts/${accountId}/index?path=${encodeURIComponent(path)}`,
      { method: 'DELETE' },
    ),

  attachmentUrl: (accountId: string, path: string, uid: number, index: number) =>
    `/api/accounts/${accountId}/attachment?path=${encodeURIComponent(path)}&uid=${uid}&index=${index}`,
};
