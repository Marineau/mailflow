import { CACHE_MAX_BYTES } from './config.js';
import { db, deleteBody } from './db.js';
import { attachmentUsage, dropAllAttachments, dropMessageAttachments } from './attachments.js';
import { SANITIZER_VERSION } from './sanitize.js';

/**
 * Size ceiling for the cache of opened messages: the `bodies` rows plus the
 * attachment files under `data/attachments`. Headers and the search index are
 * not part of it — they are what makes the list and the search work offline,
 * and evicting a body does not touch them.
 *
 * Over the ceiling, whole messages leave, least recently opened first, until
 * the cache is back under `LOW_WATER` of the ceiling. An evicted message is
 * simply downloaded again the next time it is opened.
 */

/** Evicting down to the ceiling exactly would run a pass on every later check. */
const LOW_WATER = 0.9;

/**
 * A message opened this recently may still be on screen, with attachments about
 * to be requested: those are served with the name and type kept in `bodies`.
 */
const KEEP_RECENT_MS = 60 * 60 * 1000;

const CHECK_EVERY_MS = 60 * 60 * 1000;

interface Entry {
  account: string;
  folder: string;
  uid: number;
  bytes: number;
  /** Last opening, or last file write for attachments left without a body row. */
  at: number;
}

function collect(): Entry[] {
  const entries = new Map<string, Entry>();
  const key = (account: string, folder: string, uid: number) => `${account}\0${folder}\0${uid}`;

  const rows = db
    .prepare(
      `SELECT account, folder, uid,
              COALESCE(opened_at, fetched_at) AS at,
              length(CAST(COALESCE(html, '') AS BLOB))
                + length(CAST(COALESCE(text, '') AS BLOB))
                + length(CAST(COALESCE(attachments, '') AS BLOB))
                + length(CAST(COALESCE(headers, '') AS BLOB)) AS bytes
       FROM bodies`,
    )
    .all() as Entry[];
  for (const row of rows) entries.set(key(row.account, row.folder, row.uid), row);

  for (const usage of attachmentUsage()) {
    const id = key(usage.accountId, usage.folder, usage.uid);
    const entry = entries.get(id);
    if (entry) {
      entry.bytes += usage.bytes;
    } else {
      entries.set(id, {
        account: usage.accountId,
        folder: usage.folder,
        uid: usage.uid,
        bytes: usage.bytes,
        at: usage.modifiedAt,
      });
    }
  }

  return [...entries.values()];
}

export interface CacheLimitReport {
  /** Bytes held before the pass. */
  before: number;
  /** Bytes held after it. */
  after: number;
  messages: number;
  evicted: number;
}

export function enforceCacheLimit(now = Date.now()): CacheLimitReport {
  const entries = collect();
  const before = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const report: CacheLimitReport = { before, after: before, messages: entries.length, evicted: 0 };
  if (before <= CACHE_MAX_BYTES) return report;

  const target = CACHE_MAX_BYTES * LOW_WATER;
  entries.sort((a, b) => a.at - b.at);

  for (const entry of entries) {
    if (report.after <= target) break;
    if (now - entry.at < KEEP_RECENT_MS) break;
    deleteBody.run(entry.account, entry.folder, entry.uid);
    dropMessageAttachments(entry.account, entry.folder, entry.uid);
    report.after -= entry.bytes;
    report.evicted += 1;
  }
  return report;
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} Mo`;
}

function check(announce: boolean) {
  try {
    const report = enforceCacheLimit();
    if (report.evicted > 0) {
      console.log(
        `[cache] ${report.evicted} mail(s) ouvert(s) retiré(s) du cache : ` +
          `${megabytes(report.before)} → ${megabytes(report.after)} ` +
          `(plafond ${megabytes(CACHE_MAX_BYTES)})`,
      );
    } else if (announce) {
      console.log(
        `[cache] ${report.messages} mail(s) ouvert(s) en cache, ${megabytes(report.before)} ` +
          `sur ${megabytes(CACHE_MAX_BYTES)}`,
      );
    }
  } catch (err) {
    console.error(`[cache] contrôle du plafond impossible — ${(err as Error).message}`);
  }
}

/**
 * A cached body is HTML that was sanitised when the message was opened. When
 * the sanitiser gains a rule, the bodies cleaned before it still carry what
 * the older version let through. They are emptied rather than patched: each
 * message is downloaded and cleaned again the next time it is opened.
 *
 * Attachment files go with them — a file is served under the name and type
 * kept in its body row, and a missing body downloads the whole message again
 * anyway. Headers, the search index and its `snippet` markers are untouched.
 *
 * Has to run before the server answers its first request.
 */
export function dropOutdatedBodies(): number {
  const stored = db.prepare(`SELECT value FROM cache_meta WHERE key = 'sanitizer'`).get() as
    | { value: string }
    | undefined;
  if (stored && Number(stored.value) === SANITIZER_VERSION) return 0;

  const { count } = db.prepare('SELECT COUNT(*) AS count FROM bodies').get() as { count: number };
  db.transaction(() => {
    db.prepare('DELETE FROM bodies').run();
    db.prepare(
      `INSERT INTO cache_meta (key, value) VALUES ('sanitizer', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run(String(SANITIZER_VERSION));
  })();
  // After the rows: files left behind by a crash here are counted, then
  // evicted, by the ceiling above. Rows without the version would not be.
  dropAllAttachments();

  if (count > 0) {
    console.log(
      `[cache] ${count} mail(s) ouvert(s) retiré(s) du cache : nettoyage HTML passé en ` +
        `version ${SANITIZER_VERSION}, ils seront renettoyés à leur prochaine ouverture`,
    );
  }
  return count;
}

/** One pass at startup, then one an hour. Reads the disk and the database, never the network. */
export function watchCacheLimit() {
  check(true);
  setInterval(() => check(false), CHECK_EVERY_MS).unref();
}
