import type { ImapFlow } from 'imapflow';
import type { AccountConfig } from './config.js';
import { closeWorkerConnections, connectionFor } from './imap.js';
import { db, indexForSearch, upsertMessage } from './db.js';
import { FETCH_HEADERS, toMessageRow } from './mailbox.js';
import { htmlToText, makeSnippet } from './sanitize.js';
import { findTextPart, type TextPart } from './bodyparts.js';
import { emitAppEvent } from './events.js';

/**
 * Indexation de fond, en deux passes.
 *
 *  1. `headers` — un FETCH d'enveloppes sur toute la boîte. C'est léger et
 *     rapide : c'est ce qui permet de remonter des années en arrière dans la
 *     liste, là où la synchro courante ne ramène que les ~100 derniers.
 *  2. `bodies`  — télécharge la partie texte de chaque mail pour alimenter
 *     l'index FTS. Beaucoup plus lourd, donc exécuté par petits lots, et
 *     reprenable : on ne réindexe jamais ce qui l'est déjà.
 *
 * Le point structurant : la connexion IMAP est partagée avec l'interface. Un
 * FETCH monolithique garderait le verrou de boîte pendant des minutes et
 * figerait l'app. On travaille donc par tranches, en relâchant le verrou entre
 * chaque, quitte à être un peu plus lent.
 */

const HEADER_CHUNK = 1000;
/**
 * Un lot large est payant depuis qu'on récupère les parties texte groupées par
 * identifiant : le coût est en allers-retours réseau, plus en nombre de mails.
 */
const BODY_CHUNK = 400;
/**
 * Taille max d'un lot tenu en mémoire. Un corps indexable fait jusqu'à 1 Mo :
 * à 25, le pic reste autour de 25 Mo par connexion, pas de la centaine.
 */
const TEXT_BATCH = 25;
/** Au-delà, c'est une pièce jointe déguisée : rien à indexer pour le prix. */
const MAX_PART_BYTES = 1_000_000;

/**
 * Nombre de connexions IMAP dédiées à l'indexation, en plus de celle qui sert
 * l'interface. Mesuré le 2026-07-31 : le temps est dominé par le coût par
 * message côté Outlook, pas par le volume — plafonner les octets récupérés à
 * 32 Ko n'avait rien changé (16,9 s contre 16,4 s pour 200 mails). Seul le
 * parallélisme paie. Exchange Online tolère une quinzaine de connexions
 * simultanées ; on en prend quatre, largement sous la limite.
 */
const WORKERS = 4;

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

const cancelled = new Set<string>();
const queues = new Map<string, Promise<unknown>>();
/** Travaux réellement en cours dans ce processus — la base, elle, survit aux redémarrages. */
const live = new Map<string, IndexState>();

const key = (accountId: string, folder: string) => `${accountId}:${folder}`;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Rejoue une tranche jusqu'à trois fois, en espaçant les tentatives. Sur
 * 28 000 mails, une coupure réseau est certaine ; abandonner tout le travail au
 * premier incident revient à ne jamais finir. Les tranches étant idempotentes,
 * les rejouer ne coûte que du temps.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const delays = [2000, 5000, 15000];

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= delays.length) throw err;
      console.warn(
        `[index] ${label} — ${(err as Error).message} ; nouvelle tentative dans ${
          delays[attempt] / 1000
        } s`,
      );
      await wait(delays[attempt]);
    }
  }
}

function saveState(state: IndexState) {
  db.prepare(
    `INSERT INTO index_state
       (account, folder, headers_done, headers_total, bodies_done, bodies_total, phase, error, updated_at)
     VALUES (@account, @folder, @headersDone, @headersTotal, @bodiesDone, @bodiesTotal, @phase, @error, @updatedAt)
     ON CONFLICT (account, folder) DO UPDATE SET
       headers_done = excluded.headers_done,
       headers_total = excluded.headers_total,
       bodies_done = excluded.bodies_done,
       bodies_total = excluded.bodies_total,
       phase = excluded.phase,
       error = excluded.error,
       updated_at = excluded.updated_at`,
  ).run({ ...state, updatedAt: Date.now() });

  emitAppEvent({
    type: 'index',
    account: state.account,
    path: state.folder,
    index: {
      phase: state.phase,
      done: state.phase === 'bodies' ? state.bodiesDone : state.headersDone,
      total: state.phase === 'bodies' ? state.bodiesTotal : state.headersTotal,
      message: state.error ?? undefined,
    },
  });
}

export function indexStatus(accountId: string): IndexState[] {
  const rows = db
    .prepare('SELECT * FROM index_state WHERE account = ? ORDER BY folder')
    .all(accountId) as Record<string, unknown>[];

  return rows.map((row) => ({
    account: row.account as string,
    folder: row.folder as string,
    phase: row.phase as IndexState['phase'],
    headersDone: row.headers_done as number,
    headersTotal: row.headers_total as number,
    bodiesDone: row.bodies_done as number,
    bodiesTotal: row.bodies_total as number,
    error: (row.error as string) ?? null,
  }));
}

export function cancelIndexing(accountId: string, folder: string) {
  cancelled.add(key(accountId, folder));
}

/**
 * Remet un dossier à zéro côté corps : les en-têtes restent, les extraits et
 * l'index plein texte sont effacés pour être refabriqués. Nécessaire quand la
 * façon d'extraire le texte change — sinon l'ancien index, silencieusement
 * incomplet, reste en place.
 */
export function resetBodyIndex(accountId: string, folder: string) {
  db.transaction(() => {
    db.prepare('UPDATE messages SET snippet = NULL WHERE account = ? AND folder = ?').run(
      accountId,
      folder,
    );
    db.prepare('DELETE FROM messages_fts WHERE account = ? AND folder = ?').run(accountId, folder);
    db.prepare(
      'UPDATE index_state SET bodies_done = 0, bodies_total = 0 WHERE account = ? AND folder = ?',
    ).run(accountId, folder);
  })();
}

/**
 * Les travaux d'un même compte s'exécutent en file : ils partagent une unique
 * connexion IMAP, les paralléliser ne ferait que se disputer le même verrou.
 */
function enqueue<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(accountId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  // La file ne garde que le dernier maillon, et le lâche une fois le compte
  // au repos : sinon la chaîne des promesses retient tout le travail passé.
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  queues.set(accountId, settled);
  void settled.then(() => {
    if (queues.get(accountId) === settled) queues.delete(accountId);
  });
  return next;
}

export function startIndexing(account: AccountConfig, folder: string): IndexState {
  const id = key(account.id, folder);
  cancelled.delete(id);

  if (live.has(id)) return live.get(id) as IndexState;

  // Un travail interrompu par un arrêt du serveur a laissé sa phase en base ;
  // on repart de son avancement plutôt que de tout retélécharger.
  const previous = indexStatus(account.id).find((s) => s.folder === folder);

  const state: IndexState = {
    account: account.id,
    folder,
    phase: 'headers',
    headersDone: previous?.headersDone ?? 0,
    headersTotal: previous?.headersTotal ?? 0,
    bodiesDone: 0,
    bodiesTotal: 0,
    error: null,
  };
  live.set(id, state);
  saveState(state);

  void enqueue(account.id, async () => {
    try {
      await indexHeaders(account, folder, state);
      if (!cancelled.has(id)) await indexBodies(account, folder, state);
      if (!cancelled.has(id)) {
        state.phase = 'done';
        saveState(state);
      }
    } catch (err) {
      state.phase = 'error';
      state.error = (err as Error).message;
      saveState(state);
      console.error(`[index:${account.id}] ${folder} — ${state.error}`);
    } finally {
      cancelled.delete(id);
      live.delete(id);
      // Les connexions d'indexation ne servent plus à rien une fois le travail
      // de CE compte fini. `live` est global : un autre compte encore en cours
      // ne doit pas empêcher de fermer les sockets de celui-ci.
      const accountBusy = [...live.values()].some((job) => job.account === account.id);
      if (!accountBusy) await closeWorkerConnections(account.id, WORKERS);
    }
  });

  return state;
}

/**
 * Relance au démarrage tout travail que l'arrêt précédent a laissé en plan.
 * Sans ça, tuer le serveur en cours d'indexation gèle définitivement l'index
 * dans un état partiel — et la recherche locale ne trouve plus rien.
 */
export function resumeIndexing(accountsToResume: AccountConfig[]) {
  for (const account of accountsToResume) {
    for (const state of indexStatus(account.id)) {
      // « error » est repris aussi : une coupure réseau ne doit pas condamner
      // définitivement un dossier à rester à moitié indexé.
      if (state.phase === 'headers' || state.phase === 'bodies' || state.phase === 'error') {
        console.log(
          `[index:${account.id}] reprise de ${state.folder} ` +
            `(en-têtes ${state.headersDone}/${state.headersTotal})`,
        );
        startIndexing(account, state.folder);
      }
    }
  }
}

async function indexHeaders(account: AccountConfig, folder: string, state: IndexState) {
  const connection = connectionFor(account);
  const id = key(account.id, folder);

  const total = await connection.withMailbox(folder, async (client) => {
    const mailbox = client.mailbox;
    return !mailbox || typeof mailbox === 'boolean' ? 0 : mailbox.exists;
  });

  state.headersTotal = total;
  state.phase = 'headers';
  saveState(state);

  const write = db.transaction((rows: Parameters<typeof upsertMessage.run>[0][]) => {
    for (const row of rows) upsertMessage.run(row);
  });

  // On descend du plus récent au plus ancien : la liste devient utilisable
  // pendant l'indexation, au lieu de se remplir par le fond. Une reprise repart
  // sous la zone déjà traitée — le recouvrement éventuel est sans effet, les
  // écritures sont idempotentes.
  const resumeFrom = Math.max(1, total - state.headersDone);

  for (let end = resumeFrom; end >= 1; end -= HEADER_CHUNK) {
    if (cancelled.has(id)) return;

    const start = Math.max(1, end - HEADER_CHUNK + 1);

    await withRetry(`${folder} en-têtes ${start}-${end}`, () =>
      connection.withMailbox(folder, async (client: ImapFlow) => {
        const batch: Parameters<typeof upsertMessage.run>[0][] = [];
        for await (const msg of client.fetch(`${start}:${end}`, FETCH_HEADERS)) {
          batch.push(toMessageRow(msg, account.id, folder));
        }
        write(batch);
      }),
    );

    state.headersDone = Math.min(total, total - start + 1);
    saveState(state);

    // Respiration : laisse passer les requêtes de l'interface.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function indexBodies(account: AccountConfig, folder: string, state: IndexState) {
  const id = key(account.id, folder);

  const pending = db
    .prepare(
      'SELECT COUNT(*) AS n FROM messages WHERE account = ? AND folder = ? AND snippet IS NULL',
    )
    .get(account.id, folder) as { n: number };

  state.phase = 'bodies';
  state.bodiesTotal = pending.n;
  state.bodiesDone = 0;
  saveState(state);

  for (;;) {
    if (cancelled.has(id)) return;

    const rows = db
      .prepare(
        `SELECT uid, subject, from_addr, from_name,
                text_part, text_type, text_encoding, text_charset, text_size
         FROM messages
         WHERE account = ? AND folder = ? AND snippet IS NULL
         ORDER BY date DESC LIMIT ?`,
      )
      .all(account.id, folder, BODY_CHUNK) as PendingRow[];

    if (rows.length === 0) return;

    // Le total est recalculé à chaque tour : une réinitialisation ou l'arrivée
    // de nouveaux mails pendant le travail rendrait sinon la barre absurde.
    const remaining = db
      .prepare(
        'SELECT COUNT(*) AS n FROM messages WHERE account = ? AND folder = ? AND snippet IS NULL',
      )
      .get(account.id, folder) as { n: number };
    state.bodiesTotal = state.bodiesDone + remaining.n;

    const tChunk = Date.now();

    // Le lot est réparti entre les connexions : chacune tient sa propre socket
    // et son propre verrou de boîte, donc elles ne s'attendent pas.
    const sliceSize = Math.ceil(rows.length / WORKERS);
    const slices: (typeof rows)[] = [];
    for (let i = 0; i < rows.length; i += sliceSize) slices.push(rows.slice(i, i + sliceSize));

    const timings = await Promise.all(
      slices.map((slice, index) => indexSlice(account, folder, slice, index + 1, state, id)),
    );

    const structuresMs = Math.max(...timings.map((t) => t.structuresMs));
    const textMs = timings.reduce((sum, t) => sum + t.textMs, 0);

    const total = Date.now() - tChunk;
    console.log(
      `[index] ${folder} lot ${rows.length} sur ${slices.length} connexions en ${total} ms — ` +
        `structures ${structuresMs} ms, extraction texte ${textMs} ms`,
    );

    saveState(state);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

type PendingRow = {
  uid: number;
  subject: string | null;
  from_addr: string | null;
  from_name: string | null;
  text_part: string | null;
  text_type: string | null;
  text_encoding: string | null;
  text_charset: string | null;
  text_size: number | null;
};

/** Traite une part du lot sur sa propre connexion IMAP. */
async function indexSlice(
  account: AccountConfig,
  folder: string,
  rows: PendingRow[],
  slot: number,
  state: IndexState,
  id: string,
): Promise<{ structuresMs: number; textMs: number }> {
  if (rows.length > TEXT_BATCH) {
    let structuresMs = 0;
    let textMs = 0;
    for (let offset = 0; offset < rows.length; offset += TEXT_BATCH) {
      if (cancelled.has(id)) break;
      const timing = await indexSlice(
        account,
        folder,
        rows.slice(offset, offset + TEXT_BATCH),
        slot,
        state,
        id,
      );
      structuresMs += timing.structuresMs;
      textMs += timing.textMs;
    }
    return { structuresMs, textMs };
  }

  const connection = connectionFor(account, slot);
  let structuresMs = 0;
  let textMs = 0;

  await withRetry(`${folder} corps (connexion ${slot})`, () =>
    connection.withMailbox(folder, async (client: ImapFlow) => {
      // 1. Où se trouve le texte de chaque mail. La synchro d'en-têtes l'a déjà
      //    noté ; seuls les mails antérieurs à ce changement obligent à
      //    redemander la structure au serveur.
      const t0 = Date.now();
      const parts = new Map<number, TextPart>();
      const unknown: number[] = [];

      for (const row of rows) {
        if (row.text_part) {
          const size = row.text_size ?? 0;
          if (size <= MAX_PART_BYTES) {
            parts.set(row.uid, {
              part: row.text_part,
              type: row.text_type ?? 'text/plain',
              size,
              encoding: row.text_encoding ?? '7bit',
              charset: row.text_charset ?? 'utf-8',
            });
          }
        } else {
          unknown.push(row.uid);
        }
      }

      if (unknown.length > 0) {
        for await (const msg of client.fetch(
          { uid: unknown.join(',') },
          { uid: true, bodyStructure: true },
          { uid: true },
        )) {
          const part = findTextPart(msg.bodyStructure);
          if (part && part.size <= MAX_PART_BYTES) parts.set(msg.uid, part);
        }
      }
      structuresMs = Date.now() - t0;

      // 2. Les parties texte portent presque toujours le même identifiant
      //    (« 1 », « 1.1 »…). En les groupant, cent mails coûtent deux ou trois
      //    allers-retours au lieu de cent.
      const byPartId = new Map<string, number[]>();
      for (const [uid, part] of parts) {
        const bucket = byPartId.get(part.part);
        if (bucket) bucket.push(uid);
        else byPartId.set(part.part, [uid]);
      }

      const texts = new Map<number, string>();
      let lastEmit = 0;

      for (const [partId, uids] of byPartId) {
        if (cancelled.has(id)) return;
        try {
          for await (const msg of client.fetch(
            { uid: uids.join(',') },
            { uid: true, bodyParts: [partId] },
            { uid: true },
          )) {
            const raw = msg.bodyParts?.get(partId);
            const part = parts.get(msg.uid);
            if (!raw || !part) continue;

            const t1 = Date.now();
            const decoded = decodePart(raw, part.encoding, part.charset);
            // `htmlToText` et non `makeSnippet` : ce texte part dans l'index,
            // il ne doit surtout pas être tronqué.
            texts.set(msg.uid, part.type === 'text/html' ? htmlToText(decoded) : decoded);
            textMs += Date.now() - t1;

            // Le compteur avance mail par mail, pas par lot : une barre qui
            // saute de deux cents en deux cents donne l'impression que rien ne
            // se passe.
            state.bodiesDone += 1;
            if (Date.now() - lastEmit > 300) {
              lastEmit = Date.now();
              saveState(state);
            }
          }
        } catch {
          // Une partie illisible ne doit pas bloquer les 28 000 mails suivants :
          // les UID concernés seront marqués traités avec un texte vide.
        }
      }

      const write = db.transaction(() => {
        for (const row of rows) {
          const text = texts.get(row.uid) ?? '';
          db.prepare(
            'UPDATE messages SET snippet = ? WHERE account = ? AND folder = ? AND uid = ?',
          ).run(makeSnippet(text, undefined), account.id, folder, row.uid);

          indexForSearch({
            account: account.id,
            folder,
            uid: row.uid,
            subject: row.subject,
            from_addr: row.from_addr,
            from_name: row.from_name,
            body: text,
          });
        }
      });
      write();

      // Les mails sans partie texte exploitable n'ont pas été comptés plus
      // haut ; ils sont pourtant traités.
      state.bodiesDone += rows.length - texts.size;
    }),
  );

  return { structuresMs, textMs };
}

/**
 * `bodyParts` renvoie l'octet brut du message : contrairement à `download()`,
 * rien n'est décodé. Sans ce traitement, un mail en base64 s'indexerait comme
 * une suite de caractères aléatoires — donc introuvable.
 */
function decodePart(raw: Buffer, encoding: string, charset: string): string {
  let bytes = raw;

  if (encoding === 'base64') {
    bytes = Buffer.from(raw.toString('ascii'), 'base64');
  } else if (encoding === 'quoted-printable') {
    bytes = decodeQuotedPrintable(raw.toString('ascii'));
  }

  // Latin-1 et Windows-1252 restent courants dans les mails français ; les
  // confondre avec de l'UTF-8 produit des accents cassés, donc des mots ratés.
  if (charset.includes('8859') || charset.includes('1252')) return bytes.toString('latin1');
  return bytes.toString('utf8');
}

function decodeQuotedPrintable(input: string): Buffer {
  const joined = input.replace(/=\r?\n/g, '');
  const out: number[] = [];

  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      out.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    out.push(joined.charCodeAt(i) & 0xff);
  }

  return Buffer.from(out);
}
