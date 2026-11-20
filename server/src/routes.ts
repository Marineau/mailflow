import { Router, type Request, type Response } from 'express';
import { accounts, getAccount, OAUTH_REDIRECT_URI, oauthDefaults, type AccountConfig } from './config.js';
import {
  buildAccount,
  deleteStoredAccount,
  saveAccount,
  testPasswordAccount,
  type AccountInput,
} from './accountStore.js';
import { closeAccountConnections, warmUpAccount } from './imap.js';
import { db } from './db.js';
import { onAppEvent } from './events.js';
import { progressFor } from './progress.js';
import { cancelIndexing, indexStatus, resetBodyIndex, startIndexing } from './indexer.js';
import {
  deleteMessagePermanently,
  downloadAttachment,
  getMessageBody,
  moveMessage,
  searchOnServer,
  setFlags,
  syncFolders,
  syncMessages,
} from './mailbox.js';
import { closeTransport, parseOutgoingAttachments, sendMail, verifySmtp } from './send.js';
import { listSenders } from './senders.js';
import {
  fileBlockedSenders,
  hiddenCounts,
  isHiddenMessage,
  isSenderBlocked,
  listBlockedSenders,
  reportSpam,
  unblockSender,
  visibleMailSql,
} from './spam.js';
import { buildAuthorizeUrl, exchangeCode, forgetToken, hasToken, resolvePending } from './oauth.js';

export const router = Router();

/** Petit helper : sans lui, chaque `await` qui rejette laisse la requête pendante. */
function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: Error & { status?: number }) => {
      console.error(`[api] ${req.method} ${req.originalUrl} — ${err.message}`);
      res.status(err.status ?? 500).json({ error: err.message });
    });
  };
}

function requiredQuery(req: Request, key: string): string {
  const value = req.query[key];
  if (typeof value !== 'string' || !value) {
    throw Object.assign(new Error(`Paramètre « ${key} » manquant`), { status: 400 });
  }
  return value;
}

/** What the interface may know of an account: never a password, token or secret. */
function publicAccount(a: AccountConfig) {
  return {
    id: a.id,
    label: a.label,
    email: a.email,
    authMode: a.authMode,
    provider: a.oauth?.provider ?? null,
    source: a.source,
    // Le client affiche un bouton « Autoriser » tant que c'est faux.
    authorized: a.authMode === 'password' || hasToken(a.id),
  };
}

router.get(
  '/accounts',
  handle(async (_req, res) => {
    res.json(accounts.map(publicAccount));
  }),
);

/**
 * What the « add an account » form needs to know of the server: which OAuth
 * clients are already set up. Ids are public; the Google secret is only
 * reported as present or not.
 */
router.get(
  '/account-setup',
  handle(async (_req, res) => {
    res.json({
      microsoftClientId: oauthDefaults.microsoftClientId,
      googleClientId: oauthDefaults.googleClientId,
      googleSecretConfigured: Boolean(oauthDefaults.googleClientSecret),
      redirectUri: OAUTH_REDIRECT_URI,
    });
  }),
);

/** Tries the IMAP and SMTP logins of a password account, without saving anything. */
router.post(
  '/accounts/test',
  handle(async (req, res) => {
    const account = buildAccount(req.body as AccountInput);
    if (account.authMode !== 'password') {
      res.json({ imap: null, smtp: null });
      return;
    }
    res.json(await testPasswordAccount(account, progressFor(req)));
  }),
);

/**
 * Adds an account from the interface. A password account must log in first;
 * an OAuth account is saved unauthorized, and the interface sends the user to
 * its consent right after.
 */
router.post(
  '/accounts',
  handle(async (req, res) => {
    const account = buildAccount(req.body as AccountInput);
    if (account.authMode === 'password') {
      const report = progressFor(req);
      const check = await testPasswordAccount(account, report);
      if (check.imap || check.smtp) {
        res.status(400).json({ error: check.imap ?? check.smtp, ...check });
        return;
      }
    }
    saveAccount(account);
    res.status(201).json(publicAccount(account));

    if (account.authMode === 'password') {
      void syncFolders(account)
        .then(() => warmUpAccount(account))
        .catch((err: Error) => console.error(`[sync:${account.id}] dossiers — ${err.message}`));
    }
  }),
);

router.delete(
  '/accounts/:id',
  handle(async (req, res) => {
    const account = getAccount(req.params.id);
    if (account.source !== 'app') {
      throw Object.assign(new Error('Ce compte est déclaré dans .env : retirez-le de ce fichier.'), {
        status: 400,
      });
    }
    const folders = db.prepare('SELECT path FROM folders WHERE account = ?').all(account.id) as {
      path: string;
    }[];
    for (const folder of folders) cancelIndexing(account.id, folder.path);
    await closeAccountConnections(account.id);
    closeTransport(account.id);
    deleteStoredAccount(account.id);
    res.json({ ok: true });
  }),
);

/** Démarre le consentement (Microsoft ou Google) : redirige le navigateur vers l'écran de login. */
router.get(
  '/accounts/:id/oauth',
  handle(async (req, res) => {
    const account = getAccount(req.params.id);
    res.redirect(buildAuthorizeUrl(account));
  }),
);

router.get(
  '/accounts/:id/oauth/forget',
  handle(async (req, res) => {
    const account = getAccount(req.params.id);
    forgetToken(account.id);
    res.json({ ok: true });
  }),
);

router.get(
  '/oauth/callback',
  handle(async (req, res) => {
    const { code, state, error, error_description: description } = req.query;

    if (error) {
      res.status(400).send(page('Autorisation refusée', String(description ?? error)));
      return;
    }
    if (typeof code !== 'string' || typeof state !== 'string') {
      res.status(400).send(page('Réponse incomplète', 'Le fournisseur n’a renvoyé ni code ni état.'));
      return;
    }

    const { accountId, verifier } = resolvePending(state);
    const account = getAccount(accountId);
    await exchangeCode(account, code, verifier);

    res.send(
      page(
        'Compte autorisé',
        `${account.email} est connecté. Vous pouvez fermer cet onglet et revenir à mailFlow.`,
        // Opened by the « add an account » window with window.open: it may close itself.
        true,
      ),
    );

    // First authorization of an account added from the interface: nothing is
    // connected for it yet. Harmless on a re-authorization.
    void syncFolders(account)
      .then(() => warmUpAccount(account))
      .catch((err: Error) => console.error(`[sync:${account.id}] dossiers — ${err.message}`));
  }),
);

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(rawTitle: string, rawMessage: string, closeSoon = false): string {
  const title = escapeHtml(rawTitle);
  const message = escapeHtml(rawMessage);
  const script = closeSoon ? '<script>setTimeout(() => window.close(), 1500)</script>' : '';
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title>${script}
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#14161c;color:#e7e9ee;
font:15px/1.6 system-ui,'Segoe UI',sans-serif}div{max-width:28rem;padding:2rem;text-align:center}
h1{font-size:1.1rem;margin:0 0 .5rem}p{margin:0;color:#9aa1ae}</style></head>
<body><div><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

router.get(
  '/accounts/:id/folders',
  handle(async (req, res) => {
    const account = getAccount(req.params.id);
    const cached = db
      .prepare('SELECT * FROM folders WHERE account = ? ORDER BY path')
      .all(account.id) as Record<string, unknown>[];

    if (cached.length && req.query.refresh !== '1') {
      res.json(cached.map(toFolderDto));
      return;
    }

    await syncFolders(account);
    const fresh = db
      .prepare('SELECT * FROM folders WHERE account = ? ORDER BY path')
      .all(account.id) as Record<string, unknown>[];
    res.json(fresh.map(toFolderDto));
  }),
);

function toFolderDto(row: Record<string, unknown>) {
  // Les compteurs viennent du serveur IMAP, qui compte aussi les mails masqués.
  const hidden = hiddenCounts(row.account as string, row.path as string);
  return {
    path: row.path as string,
    name: row.name as string,
    delimiter: row.delimiter as string | null,
    specialUse: row.special_use as string | null,
    total: Math.max(0, (row.total as number) - hidden.total),
    unseen: Math.max(0, (row.unseen as number) - hidden.unseen),
  };
}

router.get(
  '/accounts/:id/senders',
  handle(async (req, res) => {
    const account = getAccount(req.params.id);
    res.json(listSenders(account.id, account.email));
  }),
);

router.get(
  '/accounts/:id/messages',
  handle(async (req, res) => {
    const account = getAccount(req.params.id);
    const path = requiredQuery(req, 'path');
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Number(req.query.offset ?? 0);
    const report = progressFor(req);

    if (req.query.sync === '1' || offset === 0) {
      await syncMessages(account, path, Math.max(limit * 2, 100), report).catch((err) => {
        console.error(`[sync:${account.id}] ${path} — ${err.message}`);
      });
      report(0.85, 0.97);
      // Les expéditeurs bloqués quittent le dossier affiché pour Banned. Envoyés,
      // brouillons, corbeille, indésirables et Banned sont exclus.
      await fileBlockedSenders(account, path).catch((err) => {
        console.error(`[spam:${account.id}] ${path} — ${err.message}`);
      });
    }

    // Dans les indésirables, rien n'est déplacé : les mails d'expéditeurs
    // bloqués y restent sur le serveur et sortent seulement de la liste.
    const rows = db
      .prepare(
        `SELECT m.* FROM messages m WHERE m.account = ? AND m.folder = ?
         ${visibleMailSql(account.id, path, 'm')}
         ORDER BY m.date DESC LIMIT ? OFFSET ?`,
      )
      .all(account.id, path, limit, offset) as Record<string, unknown>[];

    res.json(rows.map(toMessageDto));
  }),
);

function toMessageDto(row: Record<string, unknown>) {
  return {
    uid: row.uid as number,
    folder: row.folder as string,
    account: row.account as string,
    subject: (row.subject as string) ?? '(sans objet)',
    from: { name: (row.from_name as string) ?? '', address: (row.from_addr as string) ?? '' },
    to: JSON.parse((row.to_addrs as string) || '[]'),
    date: row.date as number,
    seen: Boolean(row.seen),
    flagged: Boolean(row.flagged),
    answered: Boolean(row.answered),
    draft: Boolean(row.draft),
    hasAttachments: Boolean(row.has_attach),
    snippet: (row.snippet as string) ?? '',
    size: row.size as number | null,
    senderBlocked: isSenderBlocked(row.account as string, (row.from_addr as string) ?? ''),
  };
}

router.get(
  '/accounts/:id/message',
  handle(async (req, res) => {
    const account = getAccount(req.params.id);
    const path = requiredQuery(req, 'path');
    const uid = Number(requiredQuery(req, 'uid'));
    res.json(await getMessageBody(account, path, uid));
  }),
);

router.get(
  '/accounts/:id/attachment',
  handle(async (req, res) => {
    const account = getAccount(req.params.id);
    const path = requiredQuery(req, 'path');
    const uid = Number(requiredQuery(req, 'uid'));
    const index = Number(requiredQuery(req, 'index'));

    const attachment = await downloadAttachment(account, path, uid, index);
    const filename = encodeURIComponent(attachment.filename || 'piece-jointe');
    const type = attachment.contentType || 'application/octet-stream';
    // Une image réaffichée dans le corps doit se peindre dans l'`<img>`.
    // Le téléchargement, lui, passe par un blob : cet en-tête ne le décide pas.
    const disposition = type.startsWith('image/') ? 'inline' : 'attachment';

    res.setHeader('Content-Type', type);
    res.setHeader('Content-Length', attachment.content.length);
    res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${filename}`);
    res.end(attachment.content);
  }),
);

router.get(
  '/accounts/:id/blocked',
  handle(async (req, res) => {
    const account = getAccount(req.params.id);
    res.json(listBlockedSenders(account.id));
  }),
);

router.delete(
  '/accounts/:id/blocked',
  handle(async (req, res) => {
    const account = getAccount(req.params.id);
    const email = req.body?.email;
    if (typeof email !== 'string' || !email.trim()) {
      throw Object.assign(new Error('`email` est requis'), { status: 400 });
    }
    res.json({ ok: true, removed: unblockSender(account.id, email) });
  }),
);

router.post(
  '/accounts/:id/spam',
  handle(async (req, res) => {
    const account = getAccount(req.params.id);
    const { path, uid } = req.body ?? {};
    const parsed = Number(uid);
    if (typeof path !== 'string' || !path || !Number.isInteger(parsed) || parsed <= 0) {
      throw Object.assign(new Error('`path` et `uid` sont requis'), { status: 400 });
    }
    res.json(await reportSpam(account, path, parsed));
  }),
);

router.post(
  '/accounts/:id/flags',
  handle(async (req, res) => {
    const account = getAccount(req.params.id);
    const { path, uid, add = [], remove = [] } = req.body ?? {};
    if (!path || uid == null) {
      throw Object.assign(new Error('`path` et `uid` sont requis'), { status: 400 });
    }
    await setFlags(account, path, Number(uid), add, remove);
    res.json({ ok: true });
  }),
);

router.post(
  '/accounts/:id/move',
  handle(async (req, res) => {
    const account = getAccount(req.params.id);
    const { path, uid, target } = req.body ?? {};
    if (!path || uid == null || !target) {
      throw Object.assign(new Error('`path`, `uid` et `target` sont requis'), { status: 400 });
    }
    await moveMessage(account, path, Number(uid), target);
    res.json({ ok: true });
  }),
);

router.delete(
  '/accounts/:id/message',
  handle(async (req, res) => {
    const account = getAccount(req.params.id);
    const path = requiredQuery(req, 'path');
    const uid = Number(requiredQuery(req, 'uid'));
    await deleteMessagePermanently(account, path, uid);
    res.json({ ok: true });
  }),
);

router.post(
  '/accounts/:id/send',
  handle(async (req, res) => {
    const account = getAccount(req.params.id);
    const body = req.body ?? {};
    const result = await sendMail(
      account,
      {
      to: toAddressArray(body.to),
      cc: toAddressArray(body.cc),
      bcc: toAddressArray(body.bcc),
      subject: String(body.subject ?? ''),
      text: body.text ? String(body.text) : undefined,
      html: body.html ? String(body.html) : undefined,
      inReplyTo: body.inReplyTo ?? null,
      references: Array.isArray(body.references) ? body.references : [],
      attachments: parseOutgoingAttachments(body.attachments),
      },
      progressFor(req),
    );
    res.json(result);
  }),
);

function toAddressArray(input: unknown): string[] {
  if (Array.isArray(input)) return input.map(String).filter(Boolean);
  if (typeof input === 'string') {
    return input
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

router.get(
  '/accounts/:id/verify',
  handle(async (req, res) => {
    const account = getAccount(req.params.id);
    await verifySmtp(account);
    res.json({ ok: true });
  }),
);

router.get(
  '/accounts/:id/index',
  handle(async (req, res) => {
    const account = getAccount(req.params.id);
    res.json(indexStatus(account.id));
  }),
);

/**
 * Lance l'indexation d'un dossier — ou de tous, si `path` est absent. Les
 * travaux se mettent en file : une seule connexion IMAP par compte.
 */
router.post(
  '/accounts/:id/index',
  handle(async (req, res) => {
    const account = getAccount(req.params.id);
    const path = typeof req.body?.path === 'string' ? req.body.path : null;
    const reset = req.body?.reset === true;

    const targets = path
      ? [path]
      : (
          db.prepare('SELECT path FROM folders WHERE account = ? ORDER BY path').all(account.id) as {
            path: string;
          }[]
        ).map((f) => f.path);

    if (reset) for (const target of targets) resetBodyIndex(account.id, target);

    res.json(targets.map((target) => startIndexing(account, target)));
  }),
);

router.delete(
  '/accounts/:id/index',
  handle(async (req, res) => {
    const account = getAccount(req.params.id);
    const path = requiredQuery(req, 'path');
    cancelIndexing(account.id, path);
    res.json({ ok: true });
  }),
);

/**
 * Recherche hybride. La base locale répond tout de suite (plein texte du dossier,
 * plus les en-têtes en cache, destinataires compris). Le serveur IMAP couvre
 * toute la boîte, en-têtes inclus, mais coûte un aller-retour. On fusionne.
 *
 *   scope=folder — dossier courant, sur le serveur
 *   scope=all    — tous les dossiers du compte, sur le serveur
 *   scope=local  — cache local du dossier courant (`path`), instantané.
 *                  Sans `path`, tout le cache du compte.
 */
router.get(
  '/search',
  handle(async (req, res) => {
    const q = requiredQuery(req, 'q').trim();
    if (q.length < 2) {
      res.json({ messages: [], scope: 'local', searchedFolders: [], errors: [] });
      return;
    }

    const scope = (req.query.scope as string) ?? 'folder';
    const accountId = typeof req.query.account === 'string' ? req.query.account : null;
    const path = typeof req.query.path === 'string' ? req.query.path : null;

    const found = new Map<string, Record<string, unknown>>();
    const key = (row: Record<string, unknown>) => `${row.account}:${row.folder}:${row.uid}`;

    // Hors « tous les dossiers », le dossier affiché borne aussi l'index local :
    // une recherche depuis la réception ne doit pas ramener les envoyés.
    const folder = scope === 'all' ? null : path;
    for (const row of searchLocal(q, accountId, folder)) found.set(key(row), row);
    // L'index FTS ne contient pas les destinataires : un « À expert-batiment »
    // absent du corps restait invisible, même avec les en-têtes déjà en cache.
    for (const row of searchHeaders(q, accountId, folder)) found.set(key(row), row);

    const searchedFolders: string[] = [];
    const errors: string[] = [];

    if (accountId && scope !== 'local') {
      const account = getAccount(accountId);
      const targets =
        scope === 'all'
          ? (
              db
                .prepare('SELECT path FROM folders WHERE account = ? ORDER BY path')
                .all(account.id) as { path: string }[]
            ).map((f) => f.path)
          : path
            ? [path]
            : ['INBOX'];

      // One checkpoint per folder: SEARCH has no progress of its own.
      const report = progressFor(req);
      for (const [done, target] of targets.entries()) {
        report(done / targets.length, (done + 1) / targets.length);
        try {
          const uids = await searchOnServer(account, target, q);
          searchedFolders.push(target);
          if (uids.length === 0) continue;

          const rows = db
            .prepare(
              `SELECT * FROM messages WHERE account = ? AND folder = ?
               AND uid IN (${uids.map(() => '?').join(',')})`,
            )
            .all(account.id, target, ...uids) as Record<string, unknown>[];

          for (const row of rows) found.set(key(row), row);
        } catch (err) {
          // Un dossier qui refuse SEARCH ne doit pas faire échouer toute la requête.
          errors.push(`${target} : ${(err as Error).message}`);
        }
      }
    }

    const excerpts = excerptsFor(accountId, folder, q);

    const messages = [...found.values()]
      .filter(
        (row) =>
          !isHiddenMessage(
            row.account as string,
            row.folder as string,
            row.from_addr as string | null,
          ),
      )
      .sort((a, b) => (b.date as number) - (a.date as number))
      .slice(0, 200)
      .map((row) => ({
        ...toMessageDto(row),
        excerpt: excerpts.get(`${row.folder}:${row.uid}`) ?? null,
      }));

    // La couverture de l'index local est renvoyée avec les résultats : sans
    // elle, « 1 résultat » se lit comme « un seul mail correspond », alors que
    // la vraie réponse est « un seul mail correspond parmi les 8 indexés ».
    const coverageWhere: string[] = [];
    const coverageParams: string[] = [];
    if (accountId) {
      coverageWhere.push('account = ?');
      coverageParams.push(accountId);
    }
    if (folder) {
      coverageWhere.push('folder = ?');
      coverageParams.push(folder);
    }
    const coverage = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN snippet IS NOT NULL THEN 1 ELSE 0 END) AS indexed
         FROM messages${coverageWhere.length ? ` WHERE ${coverageWhere.join(' AND ')}` : ''}`,
      )
      .get(...coverageParams) as { total: number; indexed: number | null };

    res.json({
      messages,
      scope,
      searchedFolders,
      errors,
      coverage: { indexed: coverage.indexed ?? 0, total: coverage.total },
    });
  }),
);

/** FTS5 traite la ponctuation comme des opérateurs : on requote chaque terme. */
function ftsQuery(q: string): string {
  return q
    .split(/\s+/)
    .map((term) => `"${term.replace(/"/g, '')}"*`)
    .join(' ');
}

/**
 * Extraits de contexte autour des termes trouvés, fabriqués par FTS5 lui-même.
 * Les bornes sont des caractères de contrôle plutôt que du HTML : le client
 * reconstruit la surbrillance sans jamais interpréter de balise venue d'un mail.
 */
function excerptsFor(
  accountId: string | null,
  folder: string | null,
  q: string,
): Map<string, string> {
  const found = new Map<string, string>();
  const clauses = ['messages_fts MATCH ?'];
  const params: string[] = [ftsQuery(q)];
  if (accountId) {
    clauses.push('account = ?');
    params.push(accountId);
  }
  if (folder) {
    clauses.push('folder = ?');
    params.push(folder);
  }

  try {
    const rows = db
      .prepare(
        `SELECT folder, uid, snippet(messages_fts, 3, char(1), char(2), '…', 28) AS excerpt
         FROM messages_fts
         WHERE ${clauses.join(' AND ')}
         LIMIT 500`,
      )
      .all(...params) as {
      folder: string;
      uid: number;
      excerpt: string;
    }[];

    for (const row of rows) {
      if (row.excerpt?.trim()) found.set(`${row.folder}:${row.uid}`, row.excerpt);
    }
  } catch (err) {
    console.error(`[search] extraits indisponibles — ${(err as Error).message}`);
  }

  return found;
}

/**
 * Correspondances dans les en-têtes mis en cache. Le plein texte indexe l'objet,
 * l'expéditeur et le corps, pas le champ À ni le Cc : sans ce passage, chercher
 * une adresse ne remonte que les mails qui la répètent dans le texte.
 */
function searchHeaders(
  q: string,
  account: string | null,
  folder: string | null,
): Record<string, unknown>[] {
  const terms = q
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
  if (terms.length === 0) return [];

  const clauses: string[] = [];
  const params: string[] = [];
  if (account) {
    clauses.push('account = ?');
    params.push(account);
  }
  if (folder) {
    clauses.push('folder = ?');
    params.push(folder);
  }

  for (const term of terms) {
    const pattern = `%${escapeLike(term.toLowerCase())}%`;
    clauses.push(
      `(lower(coalesce(subject, '')) LIKE ? ESCAPE '\\'
        OR lower(coalesce(from_addr, '')) LIKE ? ESCAPE '\\'
        OR lower(coalesce(from_name, '')) LIKE ? ESCAPE '\\'
        OR lower(coalesce(to_addrs, '')) LIKE ? ESCAPE '\\'
        OR lower(coalesce(cc_addrs, '')) LIKE ? ESCAPE '\\')`,
    );
    params.push(pattern, pattern, pattern, pattern, pattern);
  }

  return db
    .prepare(
      `SELECT * FROM messages
       WHERE ${clauses.join(' AND ')}
       ORDER BY date DESC LIMIT 200`,
    )
    .all(...params) as Record<string, unknown>[];
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function searchLocal(
  q: string,
  account: string | null,
  folder: string | null,
): Record<string, unknown>[] {
  const clauses = ['messages_fts MATCH ?'];
  const params: string[] = [ftsQuery(q)];
  if (account) {
    clauses.push('f.account = ?');
    params.push(account);
  }
  if (folder) {
    clauses.push('f.folder = ?');
    params.push(folder);
  }

  try {
    return db
      .prepare(
        `SELECT m.* FROM messages_fts f
         JOIN messages m ON m.account = f.account AND m.folder = f.folder AND m.uid = f.uid
         WHERE ${clauses.join(' AND ')}
         ORDER BY m.date DESC LIMIT 200`,
      )
      .all(...params) as Record<string, unknown>[];
  } catch {
    // Requête FTS malformée (guillemets déséquilibrés, opérateur isolé) : la
    // recherche serveur reste utilisable, inutile de tout faire tomber.
    return [];
  }
}

/** Flux SSE : l'arrivée d'un mail pousse un événement au lieu d'être sondée. */
router.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let closed = false;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: () => void = () => undefined;
  const stop = () => {
    if (closed) return;
    closed = true;
    if (keepAlive) clearInterval(keepAlive);
    unsubscribe();
  };

  unsubscribe = onAppEvent((event) => {
    if (closed || res.writableEnded || res.destroyed) {
      stop();
      return;
    }
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  keepAlive = setInterval(() => {
    if (closed || res.writableEnded || res.destroyed) {
      stop();
      return;
    }
    try {
      res.write(': ping\n\n');
    } catch {
      stop();
    }
  }, 25_000);

  req.on('close', stop);
  res.on('close', stop);
  res.on('error', stop);
});
