/**
 * Electron main process of the packaged app.
 *
 * It holds no mail logic. It starts the same Express server as `npm run start`
 * in a utility process, waits for it to answer, and shows it in a window.
 * Window and server keep talking HTTP on the loopback interface, so the
 * browser workflow (`npm run dev`) and the packaged app run the same code.
 *
 * What it adds around that server: a session token only its window holds, the
 * key of the stored secrets kept encrypted by Windows, a tray icon the app
 * retires to when the window closes, and new-mail notifications (mailWatch.ts).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  safeStorage,
  session,
  shell,
  Tray,
  utilityProcess,
  type UtilityProcess,
} from 'electron';
import { watchMail, type MailWatch } from './mailWatch';

/** Same as `appId` in electron-builder.config.cjs: Windows files the notifications under it. */
const APP_ID = 'com.marineau.mailflow';
/** Same name in `server/src/session.ts`: rename both together. */
const SESSION_COOKIE = 'mailflow_session';

/**
 * The app was called mailFlow before it became Pli. Electron names the data
 * folder after the product, so an install from before the rename would open
 * on an empty profile: no accounts, no secret key, no theme. Such an install
 * keeps its folder; a new one gets `%APPDATA%\Pli`. Must run before anything
 * reads `userData`, the single-instance lock included.
 */
const LEGACY_DATA_DIR = path.join(app.getPath('appData'), 'mailFlow');
if (fs.existsSync(LEGACY_DATA_DIR)) app.setPath('userData', LEGACY_DATA_DIR);

/**
 * Client id of Pli's own Microsoft application, written in by
 * `build.mjs`. It is what lets someone who installs the app sign in to
 * Outlook.com without registering an application of their own. Public by
 * nature: it travels in the address of the consent page. Empty when the build
 * found none; the add-account form then asks for one.
 */
declare const __MS_OAUTH_CLIENT_ID__: string;
const MS_OAUTH_CLIENT_ID = __MS_OAUTH_CLIENT_ID__;

/** The OAuth redirect URI registered at Microsoft names this port. */
const PREFERRED_PORT = 4100;
/**
 * Ports tried in order when it is taken. Fixed rather than random: the port is
 * part of the window's origin, and the theme lives in that origin's
 * localStorage.
 */
const PORT_ATTEMPTS = 10;
/** A first start may empty an outdated body cache before it listens. */
const START_TIMEOUT_MS = 90_000;
/** The server gives itself 3 s to close IMAP and SMTP (`shutdown` in index.ts). */
const STOP_TIMEOUT_MS = 5_000;

/** Same layout as the repository: `server/dist` next to `client/dist`. */
const SERVER_ENTRY = path.join(__dirname, '..', 'server', 'dist', 'index.js');

const SPLASH = `data:text/html;charset=utf-8,${encodeURIComponent(
  `<!doctype html><meta charset="utf-8"><title>Pli</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#14161c;color:#9aa1ae;font:15px/1.6 system-ui,'Segoe UI',sans-serif">Démarrage de Pli…</body>`,
)}`;

/**
 * Drawn at each launch, never written to disk. The server refuses any request
 * that does not carry it, so the mailbox answers this app's window and
 * nothing else on the machine: no other program, no page open in a browser.
 */
const sessionToken = crypto.randomBytes(32).toString('base64url');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let server: UtilityProcess | null = null;
let watch: MailWatch | null = null;
let origin = '';
let quitting = false;

function userFile(...parts: string[]): string {
  return path.join(app.getPath('userData'), ...parts);
}

function serverLogPath(): string {
  return userFile('logs', 'server.log');
}

/**
 * The install folder is replaced by every update: the data lives with the
 * user's profile. An explicit MAILFLOW_DATA_DIR still wins.
 */
function dataDir(): string {
  return process.env.MAILFLOW_DATA_DIR?.trim() || userFile('data');
}

/** One line in `logs/shell.log`: what this process did, next to what the server says. */
function note(line: string): void {
  try {
    const file = userFile('logs', 'shell.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) {
      fs.renameSync(file, file.replace(/\.log$/, '.previous.log'));
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // A log that cannot be written must not stop the app.
  }
}

/** Request to the server, as the window makes them: with the session cookie. */
function api(pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${origin}${pathname}`, {
    ...init,
    headers: { cookie: `${SESSION_COOKIE}=${sessionToken}` },
  });
}

/**
 * The key that seals stored passwords and OAuth tokens (server/src/secretBox.ts),
 * in base64, or null to let the server keep its own in the data folder.
 *
 * It is stored encrypted by Windows for the user's account (DPAPI, through
 * `safeStorage`), outside the data folder: the data copied elsewhere, or read
 * from another Windows account, opens nothing.
 */
function accountKey(): string | null {
  // Already supplied: it reaches the server with the rest of the environment.
  if (process.env.MAILFLOW_SECRET_KEY?.trim()) return null;

  try {
    if (!safeStorage.isEncryptionAvailable()) {
      note('safeStorage unavailable: the secrets key stays in the data folder');
      return null;
    }

    const sealedPath = userFile('secret.key.bin');
    const plainPath = path.join(dataDir(), 'secret.key');

    if (fs.existsSync(sealedPath)) {
      try {
        return safeStorage.decryptString(fs.readFileSync(sealedPath));
      } catch {
        // Another Windows account or machine. What this key sealed cannot be
        // read here either way; the file is kept in case the profile goes back.
        fs.renameSync(sealedPath, `${sealedPath}.unreadable`);
        note('secrets key unreadable for this Windows account: a new one is drawn');
      }
    }

    // A key the server wrote in clear, before this existed, is taken over.
    let key = fs.existsSync(plainPath) ? fs.readFileSync(plainPath, 'utf8').trim() : '';
    if (Buffer.from(key, 'base64').length !== 32) key = crypto.randomBytes(32).toString('base64');

    fs.writeFileSync(sealedPath, safeStorage.encryptString(key));
    fs.rmSync(plainPath, { force: true });
    return key;
  } catch (error) {
    note(`secrets key not protected: ${(error as Error).message}`);
    return null;
  }
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function pickPort(): Promise<number> {
  for (let port = PREFERRED_PORT; port < PREFERRED_PORT + PORT_ATTEMPTS; port++) {
    if (await portIsFree(port)) return port;
  }
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** Resolves once the server answers on `origin`; rejects if it exits or stays silent. */
async function startServer(): Promise<void> {
  const port = await pickPort();
  origin = `http://127.0.0.1:${port}`;

  const logFile = serverLogPath();
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  // The log of the previous launch is the one that explains a crash: keep it.
  if (fs.existsSync(logFile)) fs.renameSync(logFile, logFile.replace(/\.log$/, '.previous.log'));
  const log = fs.createWriteStream(logFile);

  const key = accountKey();
  const child = utilityProcess.fork(SERVER_ENTRY, [], {
    serviceName: 'Pli server',
    stdio: 'pipe',
    env: {
      // First, so that a value set in the environment still wins.
      ...(MS_OAUTH_CLIENT_ID ? { MS_OAUTH_CLIENT_ID } : {}),
      ...process.env,
      MAILFLOW_DATA_DIR: dataDir(),
      PORT: String(port),
      MAILFLOW_SESSION_TOKEN: sessionToken,
      ...(key ? { MAILFLOW_SECRET_KEY: key } : {}),
    },
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  server = child;

  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + START_TIMEOUT_MS;
    let starting = true;
    let answered = false;
    const settle = (error?: Error) => {
      if (!starting) return;
      starting = false;
      answered = !error;
      if (error) reject(error);
      else resolve();
    };

    child.once('exit', (code) => {
      log.end();
      if (server === child) server = null;
      watch?.stop();
      watch = null;
      if (starting) settle(new Error(`Le serveur s’est arrêté pendant son démarrage (code ${code}).`));
      // Only a server that was running: one that timed out is ended by
      // `startFailed`, which has already told the user.
      else if (answered && !quitting) void serverDied(code);
    });

    const poll = async () => {
      if (!starting) return;
      try {
        const response = await api('/health');
        if (response.ok) {
          settle();
          return;
        }
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline) {
        settle(new Error(`Le serveur n’a pas répondu en ${START_TIMEOUT_MS / 1000} secondes.`));
        return;
      }
      setTimeout(() => void poll(), 200);
    };
    void poll();
  });
}

/** Asks the server to close its connections, and ends it if it does not. */
function stopServer(): Promise<void> {
  const child = server;
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => child.kill(), STOP_TIMEOUT_MS);
    child.once('exit', () => {
      clearTimeout(force);
      resolve();
    });
    child.postMessage('shutdown');
  });
}

function showMessage(options: Electron.MessageBoxOptions) {
  return win?.isVisible() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}

async function startFailed(error: Error): Promise<void> {
  // A server that never answered may still be running.
  server?.kill();
  const { response } = await showMessage({
    type: 'error',
    title: 'Pli',
    message: 'Pli n’a pas pu démarrer.',
    detail: `${error.message}\n\nJournal : ${serverLogPath()}`,
    buttons: ['Ouvrir le journal', 'Quitter'],
    defaultId: 1,
    cancelId: 1,
  });
  if (response === 0) shell.showItemInFolder(serverLogPath());
  app.quit();
}

async function serverDied(code: number): Promise<void> {
  const { response } = await showMessage({
    type: 'error',
    title: 'Pli',
    message: 'Le serveur de Pli s’est arrêté.',
    detail: `Code ${code}.\n\nJournal : ${serverLogPath()}`,
    buttons: ['Relancer', 'Quitter'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) await boot();
  else app.quit();
}

function isAppUrl(url: string): boolean {
  try {
    return origin !== '' && new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** Path of the route that starts an OAuth consent (server/src/routes.ts). */
const CONSENT_START = /^\/api\/accounts\/[^/]+\/oauth$/;

function isConsentStart(url: string): boolean {
  return isAppUrl(url) && CONSENT_START.test(new URL(url).pathname);
}

/**
 * Hands an address to the system. Only web and mail addresses: a link in a
 * mail must not be able to start a local program through another scheme.
 */
function openInBrowser(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') {
    void shell.openExternal(url.href);
  }
}

/**
 * An address of the app itself, asked for in a new window. The browser holds
 * no session, so sending it there would only show a refusal. One such address
 * is meant for the browser: the start of an OAuth consent, which answers with
 * a redirect to the provider. The shell asks for it and hands over where it
 * leads; the provider then comes back to `/api/oauth/callback`.
 */
async function openAppLink(raw: string): Promise<void> {
  const { pathname } = new URL(raw);
  if (!CONSENT_START.test(pathname)) return;
  try {
    const response = await api(pathname, { redirect: 'manual' });
    const target = response.headers.get('location') ?? '';
    if (response.status >= 300 && response.status < 400 && target.startsWith('https://')) {
      void shell.openExternal(target);
    } else {
      note(`consent not opened: the server answered ${response.status}`);
    }
  } catch (error) {
    note(`consent not opened: ${(error as Error).message}`);
  }
}

function showWindow(): void {
  if (!win) {
    if (origin) void createWindow().loadURL(`${origin}/`).catch(() => undefined);
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Said once, the first time the window closes: the app is still there. */
function trayHint(): void {
  const file = userFile('shell.json');
  try {
    if ((JSON.parse(fs.readFileSync(file, 'utf8')) as { trayHintShown?: boolean }).trayHintShown) return;
  } catch {
    // No file yet.
  }
  tray?.displayBalloon({
    iconType: 'info',
    title: 'Pli reste ouvert',
    content: 'Le courrier continue d’arriver. Pour quitter : clic droit sur l’icône, près de l’horloge.',
  });
  try {
    fs.writeFileSync(file, JSON.stringify({ trayHintShown: true }));
  } catch {
    // Said again next time, at worst.
  }
}

async function createTray(): Promise<void> {
  if (tray) return;
  try {
    // The executable's own icon: whatever icon the build carries, the tray follows.
    tray = new Tray(await app.getFileIcon(process.execPath, { size: 'normal' }));
  } catch (error) {
    // Without a tray the window closes for good, as it did before.
    note(`tray unavailable: ${(error as Error).message}`);
    return;
  }
  tray.setToolTip('Pli');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Ouvrir Pli', click: showWindow },
      { type: 'separator' },
      { label: 'Quitter', click: () => app.quit() },
    ]),
  );
  tray.on('click', showWindow);
}

function createWindow(): BrowserWindow {
  const created = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 720,
    minHeight: 480,
    title: 'Pli',
    backgroundColor: '#14161c',
    // The default menu stays reachable with Alt, for zoom and reload. Its
    // DevTools entry does nothing in the packaged app (`devTools` below).
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });

  // Nothing the page opens becomes a window of the app: a link in a mail goes
  // to the browser. The OAuth consent goes there too, since Google refuses
  // embedded views, and comes back through the loopback redirect.
  created.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) void openAppLink(url);
    else openInBrowser(url);
    return { action: 'deny' };
  });
  // The window itself never leaves the app.
  created.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) {
      // A consent started by a plain link (the « Autoriser » screen): followed
      // here, the provider's pages would replace the app in its own window.
      if (isConsentStart(url)) {
        event.preventDefault();
        void openAppLink(url);
      }
      return;
    }
    event.preventDefault();
    openInBrowser(url);
  });
  // `will-navigate` sees what the page asks for, not where the server sends
  // it next: an answer of the app that redirects outside stops here.
  created.webContents.on('will-redirect', (event, url) => {
    if (event.isMainFrame && !isAppUrl(url)) event.preventDefault();
  });
  // Closing the window leaves the app in the tray: the server keeps its IMAP
  // connections, so mail keeps arriving and being announced.
  created.on('close', (event) => {
    if (quitting || !tray) return;
    event.preventDefault();
    created.hide();
    // The connections idle on the last folder shown: back to INBOX.
    watch?.checkAll();
    trayHint();
  });
  created.on('closed', () => {
    if (win === created) win = null;
  });

  win = created;
  return created;
}

async function boot(): Promise<void> {
  await createTray();
  const target = win ?? createWindow();
  // `loadURL` rejects when the window closes meanwhile; nothing to do then.
  await target.loadURL(SPLASH).catch(() => undefined);

  try {
    await startServer();
    // Before the interface loads: its very first request must carry it. No
    // expiry, so it is never written to the profile on disk.
    await session.defaultSession.cookies.set({
      url: origin,
      name: SESSION_COOKIE,
      value: sessionToken,
      httpOnly: true,
      sameSite: 'strict',
    });
  } catch (error) {
    if (!quitting) await startFailed(error as Error);
    return;
  }

  watch?.stop();
  watch = watchMail({
    api,
    shouldNotify: () => !win || !win.isVisible() || win.isMinimized() || !win.isFocused(),
    onClick: showWindow,
    note,
  });

  await win?.loadURL(`${origin}/`).catch(() => undefined);
}

/**
 * Chromium's remote debugging hands the page, its cookies included, to
 * whatever connects to the port. The other such doors are closed in the
 * executable itself (`electronFuses` in electron-builder.config.cjs); this
 * one has no fuse. Checked before anything starts: the port opens when the
 * app is ready. Unpackaged (`desktop:start`), debugging stays possible.
 */
const debugged =
  app.isPackaged &&
  ['remote-debugging-port', 'remote-debugging-pipe'].some((name) => app.commandLine.hasSwitch(name));

if (debugged) {
  app.exit(1);
}
// Two instances would run two servers on one data folder: two IMAP
// connections per account, and two processes rotating the same refresh tokens.
else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Unpackaged, Windows knows no shortcut carrying the app's id and would
  // drop the notifications: the executable's path stands in for it.
  app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath);

  app.on('second-instance', showWindow);

  // Only reached without a tray: with one, the window hides instead of closing.
  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', (event) => {
    quitting = true;
    if (!server) return;
    // Give the server the time to log out of IMAP before the process goes.
    event.preventDefault();
    void stopServer().then(() => app.quit());
  });

  app.on('will-quit', () => tray?.destroy());

  void app.whenReady().then(boot);
}
