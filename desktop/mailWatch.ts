/**
 * New-mail notifications of the packaged app.
 *
 * The shell knows mail only through the server's API, like the window does.
 * It listens to the event stream, and when a reception folder changes it
 * lists that folder and announces what is above the highest UID it had seen.
 *
 * A slow periodic check runs besides the events, because the events alone go
 * quiet without telling: the server keeps one IMAP connection per account,
 * idling on the last folder used, and nothing reopens it when the provider
 * drops it. Listing INBOX does both: it reconnects, and it puts the
 * connection back on INBOX.
 */
import { Notification } from 'electron';

const INBOX = 'INBOX';
const CHECK_EVERY_MS = 5 * 60_000;
const RECONNECT_MAX_MS = 30_000;

interface Account {
  id: string;
  authorized: boolean;
}

interface Message {
  uid: number;
  subject: string;
  from: { name: string; address: string };
  seen: boolean;
}

export interface MailWatchOptions {
  /** Authenticated request to the server; `pathname` starts with `/api/`. */
  api: (pathname: string, init?: RequestInit) => Promise<Response>;
  /** False while the user is looking at the window: the list says it already. */
  shouldNotify: () => boolean;
  onClick: () => void;
  note: (line: string) => void;
}

export interface MailWatch {
  /** Lists every account's INBOX now. */
  checkAll(): void;
  stop(): void;
}

export function watchMail({ api, shouldNotify, onClick, note }: MailWatchOptions): MailWatch {
  /** Highest UID seen in each account's INBOX. Absent until the first listing. */
  const lastUid = new Map<string, number>();
  const checking = new Set<string>();
  const again = new Set<string>();
  // A notification that is collected stops answering clicks.
  const shown: Notification[] = [];
  const abort = new AbortController();
  let stopped = false;

  function announce(fresh: Message[]): void {
    if (!Notification.isSupported()) return;
    const only = fresh.length === 1 ? fresh[0] : null;
    const senders = [...new Set(fresh.map((m) => m.from.name || m.from.address).filter(Boolean))];

    const notification = new Notification({
      title: only
        ? only.from.name || only.from.address || 'Nouveau message'
        : `${fresh.length} nouveaux messages`,
      body: only ? only.subject : senders.slice(0, 3).join(', '),
    });
    notification.on('click', onClick);
    notification.on('failed', (_event, error) => note(`notification failed: ${error}`));
    shown.push(notification);
    if (shown.length > 20) shown.shift();
    notification.show();
    // The count only: senders and subjects stay out of the log.
    note(`notification: ${fresh.length} message(s)`);
  }

  async function check(accountId: string): Promise<void> {
    if (stopped) return;
    if (checking.has(accountId)) {
      again.add(accountId);
      return;
    }
    checking.add(accountId);
    try {
      // Offset 0 makes the server sync the folder first (routes.ts), and file
      // mail from blocked senders away: they never reach this list.
      const response = await api(
        `/api/accounts/${encodeURIComponent(accountId)}/messages?path=${INBOX}&limit=20`,
        { signal: abort.signal },
      );
      if (!response.ok) return;
      const messages = (await response.json()) as Message[];

      // An empty folder still sets the mark, at 0: its first mail is news.
      const top = Math.max(0, ...messages.map((m) => m.uid));
      const known = lastUid.get(accountId);
      // Assigned, not raised: after a UIDVALIDITY reset the numbers start
      // over, and a mark left high would silence the account for good.
      lastUid.set(accountId, top);
      // First listing: this is the mail that was already there.
      if (known === undefined) return;

      const fresh = messages.filter((m) => m.uid > known && !m.seen);
      if (fresh.length > 0 && shouldNotify()) announce(fresh);
    } catch (error) {
      if (!stopped) note(`mail check failed (${accountId}): ${(error as Error).message}`);
    } finally {
      checking.delete(accountId);
      if (again.delete(accountId)) void check(accountId);
    }
  }

  async function checkAll(): Promise<void> {
    if (stopped) return;
    try {
      const response = await api('/api/accounts', { signal: abort.signal });
      if (!response.ok) return;
      for (const account of (await response.json()) as Account[]) {
        if (account.authorized) void check(account.id);
      }
    } catch (error) {
      if (!stopped) note(`account list failed: ${(error as Error).message}`);
    }
  }

  function handle(block: string): void {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const event = JSON.parse(line.slice(5)) as { type?: string; account?: string; path?: string };
        if (event.type === 'exists' && event.account && event.path?.toUpperCase() === INBOX) {
          void check(event.account);
        }
      } catch {
        // Not an event of ours.
      }
    }
  }

  /** Reads the server's event stream until it ends, then opens it again. */
  async function listen(): Promise<void> {
    let delay = 1000;
    while (!stopped) {
      try {
        const response = await api('/api/events', { signal: abort.signal });
        if (response.ok && response.body) {
          delay = 1000;
          const decoder = new TextDecoder();
          let buffer = '';
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            buffer += decoder.decode(chunk, { stream: true });
            let end = buffer.indexOf('\n\n');
            while (end !== -1) {
              handle(buffer.slice(0, end));
              buffer = buffer.slice(end + 2);
              end = buffer.indexOf('\n\n');
            }
          }
        }
      } catch {
        // Server gone or restarting: try again below.
      }
      if (stopped) return;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(RECONNECT_MAX_MS, delay * 2);
    }
  }

  void listen();
  void checkAll();
  const timer = setInterval(() => void checkAll(), CHECK_EVERY_MS);

  return {
    checkAll: () => void checkAll(),
    stop() {
      stopped = true;
      clearInterval(timer);
      abort.abort();
    },
  };
}
