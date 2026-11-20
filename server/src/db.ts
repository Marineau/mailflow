import fs from 'node:fs';
import Database from 'better-sqlite3';
import { DATA_DIR, DB_PATH } from './config.js';

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS folders (
  account      TEXT NOT NULL,
  path         TEXT NOT NULL,
  name         TEXT NOT NULL,
  delimiter    TEXT,
  special_use  TEXT,
  subscribed   INTEGER NOT NULL DEFAULT 1,
  uid_validity TEXT,
  total        INTEGER NOT NULL DEFAULT 0,
  unseen       INTEGER NOT NULL DEFAULT 0,
  synced_at    INTEGER,
  PRIMARY KEY (account, path)
);

CREATE TABLE IF NOT EXISTS messages (
  account      TEXT NOT NULL,
  folder       TEXT NOT NULL,
  uid          INTEGER NOT NULL,
  message_id   TEXT,
  in_reply_to  TEXT,
  references_  TEXT,
  subject      TEXT,
  from_name    TEXT,
  from_addr    TEXT,
  to_addrs     TEXT,
  cc_addrs     TEXT,
  date         INTEGER NOT NULL,
  size         INTEGER,
  seen         INTEGER NOT NULL DEFAULT 0,
  flagged      INTEGER NOT NULL DEFAULT 0,
  answered     INTEGER NOT NULL DEFAULT 0,
  draft        INTEGER NOT NULL DEFAULT 0,
  has_attach   INTEGER NOT NULL DEFAULT 0,
  snippet      TEXT,
  PRIMARY KEY (account, folder, uid)
);

CREATE INDEX IF NOT EXISTS idx_messages_date ON messages (account, folder, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_msgid ON messages (message_id);

-- Corps complets : séparés de la liste pour que le tri/scroll ne charge jamais
-- des mégaoctets de HTML.
CREATE TABLE IF NOT EXISTS bodies (
  account     TEXT NOT NULL,
  folder      TEXT NOT NULL,
  uid         INTEGER NOT NULL,
  html        TEXT,
  text        TEXT,
  attachments TEXT,
  headers     TEXT,
  fetched_at  INTEGER NOT NULL,
  PRIMARY KEY (account, folder, uid)
);

-- Avancement de l'indexation, pour reprendre là où on s'est arrêté après un
-- redémarrage plutôt que de retélécharger 24 000 mails.
CREATE TABLE IF NOT EXISTS index_state (
  account       TEXT NOT NULL,
  folder        TEXT NOT NULL,
  headers_done  INTEGER NOT NULL DEFAULT 0,
  headers_total INTEGER NOT NULL DEFAULT 0,
  bodies_done   INTEGER NOT NULL DEFAULT 0,
  bodies_total  INTEGER NOT NULL DEFAULT 0,
  phase         TEXT NOT NULL DEFAULT 'idle',
  error         TEXT,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (account, folder)
);

-- Carnet des expéditeurs déjà vus. La boîte reste la source : cette table
-- n'est qu'un index dérivé des en-têtes, pour la suggestion à la saisie.
CREATE TABLE IF NOT EXISTS senders (
  account    TEXT NOT NULL,
  email      TEXT NOT NULL,
  name       TEXT,
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (account, email)
);

CREATE INDEX IF NOT EXISTS idx_senders_seen ON senders (account, last_seen DESC);

-- Expéditeurs que l'utilisateur a bloqués. La boîte ne connaît pas cette liste :
-- c'est mailFlow qui déplace les messages suivants vers Banned, et qui masque
-- ceux que le serveur a déjà classés dans les indésirables.
CREATE TABLE IF NOT EXISTS blocked_senders (
  account     TEXT NOT NULL,
  email       TEXT NOT NULL,
  blocked_at  INTEGER NOT NULL,
  PRIMARY KEY (account, email)
);

-- Version des règles qui ont produit ce qui est en cache. Les corps sont du
-- HTML déjà nettoyé : ceux d'une version précédente sont vidés au démarrage
-- (dropOutdatedBodies), pas corrigés sur place.
CREATE TABLE IF NOT EXISTS cache_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  subject, from_addr, from_name, body,
  account UNINDEXED, folder UNINDEXED, uid UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
`);

/**
 * La structure MIME est déjà téléchargée pendant la passe d'en-têtes. La
 * mémoriser évite de la redemander pendant l'indexation des corps, où elle
 * représentait un tiers à la moitié du temps.
 */
const existingColumns = new Set(
  (db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name),
);

for (const [column, type] of [
  ['text_part', 'TEXT'],
  ['text_type', 'TEXT'],
  ['text_encoding', 'TEXT'],
  ['text_charset', 'TEXT'],
  ['text_size', 'INTEGER'],
] as const) {
  if (!existingColumns.has(column)) {
    db.exec(`ALTER TABLE messages ADD COLUMN ${column} ${type}`);
  }
}

// Dernière ouverture d'un corps en cache. C'est elle, et non la date de
// téléchargement, qui décide de l'ordre d'éviction (`cacheLimit.ts`) : un mail
// relu hier ne doit pas partir avant un mail ouvert une fois il y a trois mois.
const bodyColumns = new Set(
  (db.prepare('PRAGMA table_info(bodies)').all() as { name: string }[]).map((c) => c.name),
);
if (!bodyColumns.has('opened_at')) {
  db.exec('ALTER TABLE bodies ADD COLUMN opened_at INTEGER');
}

// Chaque nouveau mail enregistre son expéditeur. Les mails déjà en cache
// sont repris par `backfillSenders` au démarrage : le trigger ne voit que
// les insertions suivantes. Une enveloppe illisible (`@.missing-host-name.`)
// a un @ mais n'est pas une adresse : on l'écarte.
db.exec(`
DROP TRIGGER IF EXISTS messages_ai_sender;
CREATE TRIGGER messages_ai_sender
AFTER INSERT ON messages
FOR EACH ROW
WHEN NEW.from_addr IS NOT NULL
 AND lower(trim(NEW.from_addr)) GLOB '*@*.*'
 AND lower(trim(NEW.from_addr)) NOT GLOB '* *'
 AND lower(trim(NEW.from_addr)) NOT GLOB '@*'
 AND lower(trim(NEW.from_addr)) NOT GLOB '*@.*'
 AND lower(trim(NEW.from_addr)) NOT GLOB '*.'
 AND instr(substr(lower(trim(NEW.from_addr)), instr(lower(trim(NEW.from_addr)), '@') + 1), '@') = 0
BEGIN
  INSERT INTO senders (account, email, name, last_seen)
  VALUES (
    NEW.account,
    lower(trim(NEW.from_addr)),
    NULLIF(trim(COALESCE(NEW.from_name, '')), ''),
    NEW.date
  )
  ON CONFLICT (account, email) DO UPDATE SET
    last_seen = MAX(senders.last_seen, excluded.last_seen),
    name = CASE
      WHEN excluded.last_seen >= senders.last_seen AND excluded.name IS NOT NULL
        THEN excluded.name
      ELSE senders.name
    END;
END;
`);

export interface MessageRow {
  account: string;
  folder: string;
  uid: number;
  message_id: string | null;
  in_reply_to: string | null;
  references_: string | null;
  subject: string | null;
  from_name: string | null;
  from_addr: string | null;
  to_addrs: string | null;
  cc_addrs: string | null;
  date: number;
  size: number | null;
  seen: number;
  flagged: number;
  answered: number;
  draft: number;
  has_attach: number;
  snippet: string | null;
  text_part: string | null;
  text_type: string | null;
  text_encoding: string | null;
  text_charset: string | null;
  text_size: number | null;
}

export const upsertMessage = db.prepare<MessageRow>(`
INSERT INTO messages (
  account, folder, uid, message_id, in_reply_to, references_, subject,
  from_name, from_addr, to_addrs, cc_addrs, date, size,
  seen, flagged, answered, draft, has_attach, snippet,
  text_part, text_type, text_encoding, text_charset, text_size
) VALUES (
  @account, @folder, @uid, @message_id, @in_reply_to, @references_, @subject,
  @from_name, @from_addr, @to_addrs, @cc_addrs, @date, @size,
  @seen, @flagged, @answered, @draft, @has_attach, @snippet,
  @text_part, @text_type, @text_encoding, @text_charset, @text_size
)
ON CONFLICT (account, folder, uid) DO UPDATE SET
  seen = excluded.seen,
  flagged = excluded.flagged,
  answered = excluded.answered,
  draft = excluded.draft,
  text_part = COALESCE(excluded.text_part, messages.text_part),
  text_type = COALESCE(excluded.text_type, messages.text_type),
  text_encoding = COALESCE(excluded.text_encoding, messages.text_encoding),
  text_charset = COALESCE(excluded.text_charset, messages.text_charset),
  text_size = COALESCE(excluded.text_size, messages.text_size)
`);

export const deleteMessage = db.prepare(
  'DELETE FROM messages WHERE account = ? AND folder = ? AND uid = ?',
);

export const deleteBody = db.prepare(
  'DELETE FROM bodies WHERE account = ? AND folder = ? AND uid = ?',
);

/** Un mail réindexé ne doit pas apparaître deux fois dans la recherche. */
export function indexForSearch(row: {
  account: string;
  folder: string;
  uid: number;
  subject: string | null;
  from_addr: string | null;
  from_name: string | null;
  body: string;
}) {
  db.prepare('DELETE FROM messages_fts WHERE account = ? AND folder = ? AND uid = ?').run(
    row.account,
    row.folder,
    row.uid,
  );
  db.prepare(
    `INSERT INTO messages_fts (subject, from_addr, from_name, body, account, folder, uid)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.subject ?? '',
    row.from_addr ?? '',
    row.from_name ?? '',
    row.body,
    row.account,
    row.folder,
    row.uid,
  );
}
