import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { accounts, PORT, PROJECT_ROOT } from './config.js';
import { loadStoredAccounts } from './accountStore.js';
import { router } from './routes.js';
import { requireSession } from './session.js';
import { closeAllConnections, warmUpIdle } from './imap.js';
import { closeTransports } from './send.js';
import { syncFolders } from './mailbox.js';
import { resumeIndexing } from './indexer.js';
import { watchBlockedMail } from './spam.js';
import { dropOutdatedBodies, watchCacheLimit } from './cacheLimit.js';
import { backfillSenders } from './senders.js';

// Accounts added from the interface join the `.env` ones before anything syncs.
const storedAccounts = loadStoredAccounts();
if (storedAccounts) console.log(`mailFlow — ${storedAccounts} compte(s) ajouté(s) depuis l'interface`);

const app = express();

// First, so that nothing answers before it: packaged app only (session.ts).
app.use(requireSession);

// Le client Vite tourne sur un autre port en dev ; en prod tout est servi
// derrière la même origine, donc CORS reste cantonné au localhost de dev.
app.use(cors({ origin: [/^http:\/\/localhost:\d+$/], credentials: true }));
// 32 Mo : un envoi avec pièces jointes voyage en JSON base64 (20 Mo de fichiers).
app.use(express.json({ limit: '32mb' }));
app.use('/api', router);

app.get('/health', (_req, res) => {
  res.json({ ok: true, accounts: accounts.map((a) => a.id) });
});

/**
 * En production, l'API sert aussi le client compilé : une seule origine, un seul
 * processus à lancer, et l'URI de redirection OAuth reste celle déclarée chez
 * Microsoft. En dev, ce dossier n'existe pas et Vite prend le relais sur :5180.
 */
const CLIENT_DIST = path.join(PROJECT_ROOT, 'client', 'dist');
const CLIENT_INDEX = path.join(CLIENT_DIST, 'index.html');

// La présence du build est testée à chaque requête, pas au démarrage : sinon
// compiler pendant que le serveur tourne laisse un « Cannot GET / » jusqu'au
// prochain redémarrage, ce qui n'a rien d'évident à diagnostiquer.
//
// index.html n'est jamais mis en cache. Avec le défaut de `serve-static`
// (`public, max-age=0`), le navigateur garde la coquille et, au redémarrage
// du PC, réaffiche l'ancienne page — qui pointe vers d'anciens fichiers.
// Les fichiers de assets/ ont un hash dans le nom : eux peuvent rester.
app.use(
  express.static(CLIENT_DIST, {
    fallthrough: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store');
        return;
      }
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }),
);

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();

  // Un asset disparu (ancien hash) ne doit pas renvoyer index.html : le
  // navigateur l'exécuterait comme un script et la page resterait blanche.
  if (req.path.startsWith('/assets/')) {
    res.status(404).end();
    return;
  }

  if (fs.existsSync(CLIENT_INDEX)) {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(CLIENT_INDEX);
    return;
  }

  res
    .status(503)
    .type('html')
    .send(
      `<!doctype html><meta charset="utf-8"><title>mailFlow</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#14161c;color:#e7e9ee;font:15px/1.6 system-ui,'Segoe UI',sans-serif">
<div style="max-width:30rem;padding:2rem;text-align:center">
<h1 style="font-size:1.1rem;margin:0 0 .5rem">Interface non compilée</h1>
<p style="margin:0;color:#9aa1ae">Lancez <code>npm run build</code> à la racine du projet, puis rechargez cette page.</p>
</div></body>`,
    );
});

watchBlockedMail();

// Avant d'écouter : un corps nettoyé par une version précédente de
// `sanitize.ts` ne doit pas pouvoir être servi une dernière fois.
dropOutdatedBodies();

const indexedSenders = backfillSenders();
console.log(`mailFlow — ${indexedSenders} expéditeur(s) indexé(s)`);

// Loopback only: the API has no authentication, so listening on every
// interface would hand the mailbox to anyone on the same network.
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`mailFlow — API sur http://localhost:${PORT}`);

  if (accounts.length === 0) {
    console.warn("Aucun compte configuré : ajoutez-en un depuis l'interface, ou dans .env (MAIL_1_*).");
    return;
  }

  void (async () => {
    for (const account of accounts) {
      await syncFolders(account).catch((err) =>
        console.error(`[sync:${account.id}] dossiers — ${err.message}`),
      );
    }
    await warmUpIdle();
    resumeIndexing(accounts);
  })();

  watchCacheLimit();
});

async function shutdown() {
  console.log('\nArrêt…');
  closeTransports();
  await closeAllConnections();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Packaged app: this server is an Electron utility process, and Windows has
// no signal to send it. The main process asks over the parent port instead
// (`desktop/main.ts`). Absent everywhere else.
const parentPort = (
  process as NodeJS.Process & {
    parentPort?: { on(event: 'message', listener: (message: { data: unknown }) => void): void };
  }
).parentPort;
parentPort?.on('message', (message) => {
  if (message.data === 'shutdown') void shutdown();
});
