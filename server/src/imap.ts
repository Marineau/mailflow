import { ImapFlow, type MailboxLockObject } from 'imapflow';
import type { AccountConfig } from './config.js';
import { accounts } from './config.js';
import { getAccessToken } from './oauth.js';

/** Mot de passe ou jeton XOAUTH2 selon le mode déclaré dans `.env`. */
export async function imapAuth(account: AccountConfig) {
  if (account.authMode === 'oauth2') {
    return { user: account.imap.user, accessToken: await getAccessToken(account) };
  }
  return { user: account.imap.user, pass: account.pass };
}

import { emitAppEvent } from './events.js';

const emit = emitAppEvent;

/** Panne de transport, par opposition à un refus applicatif du serveur IMAP. */
function isConnectionError(err: unknown): boolean {
  const message = (err as Error)?.message ?? '';
  return /connection not available|connection closed|socket|econnreset|epipe|etimedout|not connected/i.test(
    message,
  );
}

/**
 * Une connexion IMAP par compte, maintenue ouverte pour profiter d'IDLE.
 * imapflow sérialise déjà les commandes derrière `getMailboxLock`, donc une
 * seule socket suffit — en ouvrir une par requête HTTP ferait tomber la plupart
 * des serveurs sur leur limite de connexions simultanées.
 */
class Connection {
  private client: ImapFlow | null = null;
  private connecting: Promise<ImapFlow> | null = null;

  constructor(private readonly account: AccountConfig) {}

  async get(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /**
   * Coupe une socket qui ne sert plus. Sans ça, une reconnexion laisse
   * l'ancienne connexion et ses écouteurs en vie jusqu'au timeout du serveur.
   * `error` sans écouteur fait tomber le processus : on en garde un muet.
   */
  private discard(client: ImapFlow | null) {
    if (!client) return;
    client.removeAllListeners('exists');
    client.removeAllListeners('flags');
    client.removeAllListeners('close');
    client.removeAllListeners('error');
    client.on('error', () => undefined);
    try {
      client.close();
    } catch {
      /* socket déjà fermée */
    }
  }

  private async open(): Promise<ImapFlow> {
    const previous = this.client;
    this.client = null;
    this.discard(previous);

    const client = new ImapFlow({
      host: this.account.imap.host,
      port: this.account.imap.port,
      secure: this.account.imap.secure,
      auth: await imapAuth(this.account),
      logger: false,
      emitLogs: false,
    });

    client.on('error', (err: Error) => {
      console.error(`[imap:${this.account.id}] ${err.message}`);
    });

    client.on('close', () => {
      if (this.client === client) this.client = null;
    });

    // `exists` remonte l'arrivée d'un mail pendant l'IDLE.
    client.on('exists', (data: { path: string }) => {
      emit({ account: this.account.id, type: 'exists', path: data.path });
    });

    client.on('flags', (data: { path?: string }) => {
      emit({ account: this.account.id, type: 'flags', path: data?.path });
    });

    try {
      await client.connect();
    } catch (err) {
      this.discard(client);
      throw err;
    }
    this.client = client;
    return client;
  }

  /**
   * Exécute `fn` avec la boîte `path` verrouillée, puis relâche dans tous les cas.
   *
   * Outlook ferme les connexions longues sous charge soutenue : une commande en
   * vol se retrouve alors rejetée avec « Connection not available ». On rouvre
   * et on rejoue une fois — les traitements appelés ici sont idempotents.
   */
  async withMailbox<T>(
    path: string,
    fn: (client: ImapFlow) => Promise<T>,
    attempt = 0,
  ): Promise<T> {
    const client = await this.get();
    let lock: MailboxLockObject | null = null;

    try {
      lock = await client.getMailboxLock(path);
      return await fn(client);
    } catch (err) {
      if (attempt === 0 && isConnectionError(err)) {
        console.warn(`[imap:${this.account.id}] connexion perdue sur ${path}, reconnexion…`);
        const dead = this.client;
        this.client = null;
        this.discard(dead);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return this.withMailbox(path, fn, 1);
      }
      throw err;
    } finally {
      // Relâcher un verrou sur une socket morte lève à son tour : sans ça,
      // l'erreur de connexion serait masquée par une erreur de nettoyage.
      try {
        lock?.release();
      } catch {
        /* connexion déjà fermée */
      }
    }
  }

  async close() {
    const client = this.client;
    this.client = null;
    if (!client) return;
    client.removeAllListeners('exists');
    client.removeAllListeners('flags');
    client.removeAllListeners('close');
    client.removeAllListeners('error');
    client.on('error', () => undefined);
    if (client.usable) await client.logout().catch(() => undefined);
    this.discard(client);
  }
}

const pool = new Map<string, Connection>();

/**
 * `slot` sépare les usages : 0 est la connexion de l'interface, maintenue en
 * IDLE ; les suivantes sont ouvertes à la demande par l'indexeur. Tout faire
 * passer par une seule socket sérialise l'indexation derrière chaque clic, et
 * réciproquement.
 */
export function connectionFor(account: AccountConfig, slot = 0): Connection {
  const id = `${account.id}#${slot}`;
  let connection = pool.get(id);
  if (!connection) {
    connection = new Connection(account);
    pool.set(id, connection);
  }
  return connection;
}

/**
 * Referme les connexions d'indexation (slots 1…`workerSlots`), une fois le
 * travail terminé. Le slot des pièces jointes reste ouvert : le fermer ici
 * couperait un téléchargement en cours.
 */
export async function closeWorkerConnections(accountId: string, workerSlots = 4) {
  for (const [id, connection] of [...pool]) {
    const hash = id.lastIndexOf('#');
    const owner = hash === -1 ? id : id.slice(0, hash);
    const slot = Number(hash === -1 ? '0' : id.slice(hash + 1));
    if (owner === accountId && slot >= 1 && slot <= workerSlots) {
      pool.delete(id);
      await connection.close().catch(() => undefined);
    }
  }
}

export async function closeAllConnections() {
  await Promise.all([...pool.values()].map((c) => c.close()));
  pool.clear();
}

/** Ouvre l'INBOX de chaque compte au démarrage : sans boîte ouverte, pas d'IDLE. */
export async function warmUpIdle() {
  for (const account of accounts) await warmUpAccount(account);
}

/** Opens the INBOX of one account, for IDLE. Also used right after adding an account. */
export async function warmUpAccount(account: AccountConfig) {
  try {
    const connection = connectionFor(account);
    const client = await connection.get();
    await client.mailboxOpen('INBOX');
    console.log(`[imap:${account.id}] connecté, IDLE sur INBOX`);
  } catch (err) {
    console.error(`[imap:${account.id}] connexion impossible : ${(err as Error).message}`);
  }
}

/** Closes every connection of one account (all slots), before it is removed. */
export async function closeAccountConnections(accountId: string) {
  for (const [id, connection] of [...pool]) {
    if (id.slice(0, id.lastIndexOf('#')) !== accountId) continue;
    pool.delete(id);
    await connection.close().catch(() => undefined);
  }
}
