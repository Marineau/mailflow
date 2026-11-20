import { db } from './db.js';

export interface SenderRecord {
  email: string;
  name: string | null;
  lastSeen: number;
}

/** One mailbox address: a single @, a dotted domain, no spaces. */
function usableEmailSql(column: string): string {
  return `${column} GLOB '*@*.*'
    AND ${column} NOT GLOB '* *'
    AND ${column} NOT GLOB '@*'
    AND ${column} NOT GLOB '*@.*'
    AND ${column} NOT GLOB '*.'
    AND instr(substr(${column}, instr(${column}, '@') + 1), '@') = 0`;
}

/**
 * Fills the sender index from headers already cached. Idempotent: a later
 * message keeps the newer display name. New mail is recorded by the
 * `messages_ai_sender` trigger, so this only has to catch up at startup.
 */
export function backfillSenders(): number {
  db.prepare(`DELETE FROM senders WHERE NOT (${usableEmailSql('email')})`).run();
  db.prepare(
      `INSERT INTO senders (account, email, name, last_seen)
       SELECT account, email, name, last_seen
       FROM (
         SELECT
           account,
           lower(trim(from_addr)) AS email,
           NULLIF(trim(from_name), '') AS name,
           date AS last_seen,
           ROW_NUMBER() OVER (
             PARTITION BY account, lower(trim(from_addr))
             ORDER BY date DESC, uid DESC
           ) AS rn
         FROM messages
         WHERE ${usableEmailSql("lower(trim(from_addr))")}
       )
       WHERE rn = 1
       ON CONFLICT (account, email) DO UPDATE SET
         last_seen = MAX(senders.last_seen, excluded.last_seen),
         name = CASE
           WHEN excluded.last_seen >= senders.last_seen AND excluded.name IS NOT NULL
             THEN excluded.name
           ELSE COALESCE(senders.name, excluded.name)
         END`,
  ).run();
  const row = db.prepare('SELECT COUNT(*) AS n FROM senders').get() as { n: number };
  return row.n;
}

/** Every sender seen in the mailbox, except the account's own address. */
export function listSenders(accountId: string, ownEmail: string): SenderRecord[] {
  const own = ownEmail.trim().toLowerCase();
  return db
    .prepare(
      `SELECT email, name, last_seen AS lastSeen
       FROM senders
       WHERE account = ? AND email != ? AND ${usableEmailSql('email')}
       ORDER BY last_seen DESC`,
    )
    .all(accountId, own) as SenderRecord[];
}
