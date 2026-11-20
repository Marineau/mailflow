# Packaging mailFlow as an installable Windows client

Status, 2026-11-18: phases 2 and 3 are built and run on the development PC;
the installer has not been run on a clean machine, and nobody but the owner
has used the packaged app. What exists is described in §6 (the shell),
§7 (session token, protected key, tray, notifications), §8 (the Microsoft
application shipped in the app) and §9 (closed debugging doors, icon, licence
notices). Sections 1 to 5 are the proposal as written before the work, kept
as the plan for the remaining phases; where §6 to §9 contradict them, they
are right. The owner installed the app on the development PC on 2026-11-18
and signed in to his Outlook.com account with it (§8).
Target: other people download an installer and get a native-window app.

## 1. Stack audit

| Layer | Today | Packaging impact |
|---|---|---|
| Runtime | Node ≥ 20 (22.14 on this PC), npm workspaces | Users have no Node: the runtime must ship inside the app. |
| Server | Express 4, TypeScript run through `tsx` (no compile step in use) | Must be compiled/bundled to plain JS (`tsc` exists, or esbuild). `tsx` is a dev dependency, not a runtime. |
| Native module | `better-sqlite3` 11 (prebuilt `.node` for Node 22's ABI) | Must be rebuilt for the Electron ABI. Only native dependency, so this is the one hard build step. |
| Pure-JS deps | imapflow, mailparser, nodemailer, sanitize-html, cors, dotenv | Ship as-is. |
| Client | React 19, Vite 6, Tailwind v4, TipTap 3, TanStack Query/Virtual; build is 1.7 MB | Already a static bundle served by Express. No change needed. |
| Config | `.env` at project root (`MAIL_x_*`, OAuth client IDs, `CACHE_MAX_MB`) | End users will not edit a `.env`. Accounts already have an in-app path (`accountStore.ts`); OAuth client IDs become build-time constants. |
| Data | `server/data/` resolved from the source file location (`config.ts`: `DATA_DIR`) | Inside an install dir under Program Files this is read-only and wiped on update. Must move to `%APPDATA%\mailFlow`. |
| Secrets | AES-256-GCM, key in `data/secret.key` next to the data (debt register) | Electron `safeStorage` wraps the key with Windows DPAPI, no extra native dependency. Fixes that debt item. |
| Network | `app.listen(PORT)` with no host = all interfaces, port fixed at 4100, no auth | **Blocker for distribution**: on a café Wi-Fi anyone on the LAN can read the mailbox and add/remove accounts. |
| OAuth | Microsoft: public client + PKCE, redirect `http://localhost:4100/api/oauth/callback`. Google: "Web application" client with a secret. Consent in a browser popup. | Works in principle; see §4 for the registration and verification work. |
| Launch | `mailflow.vbs` → `launch.ps1` → `ensure-client.mjs` (rebuilds client from sources) | Developer-only. Replaced entirely by the packaged app. |
| Repo | Not a git repository (a local one since 2026-11-18, no remote) | Release builds, CI and auto-update feeds need one. |

## 2. Recommendation: Electron + electron-builder (NSIS) + electron-updater

Electron is the only option that keeps the server code untouched. Tauri or a
WebView2 shell would still need a Node sidecar for imapflow and better-sqlite3,
which means shipping Node anyway plus a second toolchain (Rust). A plain
"Node in a tray, opens the browser" wrapper was ruled out in favour of a native
window.

Cost: an installer around 90–110 MB and ~150 MB RAM for the shell. Acceptable
for a mail client.

### Process layout

```
Electron main process
├── single-instance lock, tray icon, auto-update, mailto: handler
├── utilityProcess.fork(server bundle)   ← Express + IMAP + SQLite, unchanged code
│     env: MAILFLOW_DATA_DIR, PORT=<free port>, MAILFLOW_SESSION_TOKEN=<random>
│     listens on 127.0.0.1 only
└── BrowserWindow → http://127.0.0.1:<port>/   (contextIsolation, no nodeIntegration)
```

Keeping HTTP between window and server (rather than rewriting routes as IPC)
means the dev workflow (`npm run dev`, Vite on :5180) stays exactly as it is.
The server runs in a `utilityProcess` so a long IMAP fetch never freezes the
window, and a crash can be restarted by the main process.

### Server changes (small, all in `config.ts` / `index.ts`)

1. `DATA_DIR` from `MAILFLOW_DATA_DIR` when set, else today's path.
2. `app.listen(PORT, '127.0.0.1')` — done 2026-11-18.
3. Per-launch session token: main process generates it, passes it to the server
   via env and to the window via a cookie set before load; the server rejects
   requests without it. Blocks other local processes and browser tabs.
4. Secret key passed in by the main process (decrypted with `safeStorage`)
   instead of read from `data/secret.key`. On first run, migrate an existing key.
5. `.env` becomes optional: OAuth client IDs injected at build time.

### Build pipeline

1. `tsc -p server` (or esbuild to one file) → `server/dist`.
2. `vite build` → `client/dist`.
3. `electron-builder` with `npmRebuild` for `better-sqlite3`, `asarUnpack` for
   its `.node` file, NSIS target.
4. NSIS options: per-user install (`perMachine: false`, no admin prompt),
   Start-menu and desktop shortcuts, "launch at login" left as an in-app toggle.
5. Publish to GitHub Releases under `Marineau/mailflow`; `electron-updater`
   checks on start and installs on quit.

## 3. Windows integration (in priority order)

- **Close to tray**, not quit: IDLE connections keep receiving mail.
- **Native notifications** for new mail (Electron `Notification`, needs the
  `appUserModelId` set by the installer).
- **Single instance**: a second launch focuses the existing window.
- **Default mail app**: register the `mailto:` protocol so links open the composer.
- **External links** from mail bodies open in the system browser
  (`setWindowOpenHandler`), never inside the app window.

## 4. What blocks a public release (not code)

- **Code signing.** An unsigned installer gets the SmartScreen "Windows protected
  your PC" wall, which most non-technical users will not click through.
  Options: Azure Trusted Signing (cheapest, but eligibility for an individual
  outside the US/Canada is unverified) or an OV certificate on a hardware token.
- **Microsoft app registration.** Change the Entra app to "Mobile and desktop"
  platform, multi-tenant + personal accounts. Microsoft documents that the port
  of a loopback redirect is ignored for that platform, which would allow a random
  port; **unverified in practice**, so keep 4100 as the preferred port with a
  fallback until tested. Publisher verification removes the "unverified" banner
  on the consent screen.
- **Google.** Switch to a "Desktop app" OAuth client (its secret is not treated
  as confidential). The `https://mail.google.com/` scope is *restricted*: past
  100 users, Google requires app verification plus a paid third-party security
  assessment (CASA). Until then, Gmail users connect with an app password
  (password mode already exists).
- **OAuth popups.** Google refuses consent inside embedded webviews. Open
  consent in the system browser (`shell.openExternal`) and let the existing
  loopback callback finish the flow; the form already polls for completion.
- **Privacy notice / support address**: required by both OAuth consent screens
  for external users.

## 5. Suggested phasing

1. `git init`, bind to 127.0.0.1, `MAILFLOW_DATA_DIR` — usable today, no Electron.
   All three done 2026-11-18. The repository is local: no remote yet.
2. Electron shell + unsigned NSIS build, tested on a clean Windows VM.
   Built 2026-11-18 (§6). The test on a clean VM is still to do.
3. Session token, `safeStorage`, tray/notifications/single instance.
   Built 2026-11-18 (§7). Of §3, `mailto:` registration is not done: it was
   not in this phase's list.
4. Signing, auto-update via GitHub Releases, Entra platform change.
5. Google verification, only if Gmail OAuth demand justifies the assessment cost.

Item 5 of the server changes (OAuth client ids injected at build time) was
assigned to no phase. Done for Microsoft on 2026-11-18, after the first
install showed the form asking an ordinary user for an Entra application
(§8). Not done for Google, which is not a matter of code (§8).

## 6. Phase 2 as built (2026-11-18)

### Layout

```
desktop/
├── main.ts                      Electron main process
├── mailWatch.ts                 new-mail notifications (phase 3, §7)
├── build.mjs                    stages desktop/app
├── electron-builder.config.cjs  NSIS, per-user, unsigned, x64
├── tsconfig.json                typecheck only
├── app/                         what electron-builder packs
│   ├── package.json             the only runtime dependency: better-sqlite3
│   ├── package-lock.json
│   ├── dist/main.js             generated
│   ├── server/dist/index.js     generated: the server in one CommonJS file
│   ├── client/dist/             generated: the interface
│   └── node_modules/            installed by build.mjs
└── release/                     generated: win-unpacked/ and the installer
```

### Commands (from the repository root)

| Command | Does |
|---|---|
| `npm run desktop:stage` | Typechecks server, client and `desktop/`, then fills `desktop/app`. |
| `npm run desktop:start` | Stage, then runs it with the Electron of `node_modules`. |
| `npm run desktop:pack` | Stage, then `desktop/release/win-unpacked/mailFlow.exe`. |
| `npm run desktop:dist` | Stage, then `desktop/release/mailFlow-Setup-<version>.exe`. |

The version is the one of the root `package.json`.

### What differs from the proposal

- **No native rebuild.** better-sqlite3 11 has prebuilt binaries up to
  Electron 36 only. Version 13 is an N-API addon whose binary runs under any
  recent Node or Electron, so `npmRebuild` is off and nothing is compiled. The
  packaged app pins 13.2.0 in `desktop/app/package.json`; the dev server is
  still on 11.10 (debt register).
- **The stage has its own `node_modules`**, outside the npm workspaces. The
  module the daily server has loaded is never touched by a desktop build.
- **The client is built straight into the stage**, not into `client/dist`,
  which the daily server is serving.
- **The server is one esbuild bundle**, CommonJS, with better-sqlite3 left
  out. `import.meta.url` in `config.ts` is replaced by the bundle's own path,
  and the stage mirrors the repository (`server/dist` next to `client/dist`),
  so `config.ts` and `index.ts` find the interface without a packaged-only
  branch. Only `lib/` and the Windows x64 binary of better-sqlite3 are packed.

### Behaviour of the shell

- **Data**: `%APPDATA%\mailFlow\data` (`MAILFLOW_DATA_DIR`, which the shell
  sets unless it is already in the environment). The Chromium profile is next
  to it in `%APPDATA%\mailFlow`. Server output goes to
  `%APPDATA%\mailFlow\logs\server.log`; the previous launch is kept as
  `server.previous.log`.
- **Port**: 4100, then 4101 to 4109, then any free one. Fixed candidates keep
  the window's origin, hence the theme in `localStorage`, across restarts. On
  a fallback port the OAuth redirect URI names that port, which Microsoft
  accepts (§8).
- **Start**: a splash page while the server starts; the window loads the
  interface once `/health` answers. A server that exits or stays silent for
  90 s gives an error box with the log path. A server that dies later gives
  a box offering to restart it.
- **Quit**: the main process asks the server to shut down over the parent
  port (`index.ts`), and ends it after 5 s. Since phase 3 closing the window
  no longer quits (§7).
- **Single instance**: a second launch shows and focuses the first window,
  and exits. Listed under phase 3, done here because two instances mean two
  servers on one data folder, both rotating the same refresh tokens.
- **Nothing opens inside the app.** `window.open` is always denied; `http`,
  `https` and `mailto` addresses go to the system, any other scheme is
  dropped. The window cannot navigate away from the server's origin, by a
  link or by a redirect.
- **OAuth consent** therefore runs in the system browser (§7).
- **Menu**: Electron's default menu, hidden until Alt. Kept for zoom, reload
  and DevTools while this is a test build.

### Checked on the development PC

With a temporary profile (`--user-data-dir`), no account, the daily server
running on 4100:

- the server bundle under plain Node 22 and under Electron 45.3.4, packaged
  (`win-unpacked`) and unpackaged (`desktop:start`): database and FTS tables
  created in the data folder, `/health`, `/api/accounts`, the interface and
  its hashed assets served from inside `app.asar`;
- the window on `http://127.0.0.1:4101/` showing the welcome screen, theme
  attributes set, Inter loaded, no `require` or `process` in the page;
- `window.open` returns `null`; a navigation to another origin leaves the
  window on the app;
- a second launch exits and starts no second server;
- closing the window: the server logs its shutdown, no process is left.

### Not checked

- **The installer was not run on a clean machine.** It was run once by hand
  on the development PC (the app started; the desktop shortcut `mailFlow.lnk`
  of the daily launcher was replaced by the app's). Not looked at: uninstall,
  and an install over a previous version.
- No account was added in the packaged app: IMAP, SMTP, the OAuth round trip
  through the system browser and attachment downloads are untested there.
- The hand-off to the system browser was triggered once, not observed.
- The error box of a failed start. (Server death and the second launch were
  exercised in phase 3, §7.)
- Preferred port 4100: it was taken, so only the fallback was exercised.

## 7. Phase 3 as built (2026-11-18)

### Session token

- The main process draws 32 random bytes at each launch. The server gets them
  as `MAILFLOW_SESSION_TOKEN`; the window gets them as the cookie
  `mailflow_session`, set on the server's origin before the interface loads:
  `HttpOnly`, `SameSite=Strict`, no expiry, so it is never written to disk.
  The main process sends the same cookie on its own requests.
- `server/src/session.ts` is the first middleware. With the variable set it
  answers 401 to everything without the cookie: the API, the event stream,
  `/health` and the interface's files. Without the variable (`npm run dev`,
  the daily launcher) it lets everything through, as before.
- One exception: `GET /api/oauth/callback`. The provider sends the system
  browser there, which holds no cookie; the route only accepts the one-time
  `state` it issued.
- The page needs no change and cannot read the token. The sandboxed mail
  frame is another site as far as cookies go: what a mail loads from the
  app's address arrives without the cookie. Not so for the hidden measuring
  copy that `MailBody` builds in the app's page (debt register).

### Secrets key and tokens

- The key of `secretBox.ts` no longer lives in the data folder. The main
  process keeps it in `%APPDATA%\mailFlow\secret.key.bin`, encrypted by
  `safeStorage` (DPAPI, bound to the Windows account), and hands it to the
  server as `MAILFLOW_SECRET_KEY`.
- A `data\secret.key` written by an earlier build is adopted, then deleted.
- A `secret.key.bin` that cannot be decrypted (other Windows account, other
  PC) is renamed `secret.key.bin.unreadable` and a new key is drawn. What the
  old key sealed is then lost: accounts with a stored secret are skipped at
  load, tokens are asked for again. Only the logs say so (debt register).
- `tokens.json` is sealed with the same key when it comes from outside the
  data folder (`keyIsExternal`), so in the packaged app only. A plain file is
  sealed at startup. The daily server, whose key would sit next to the file,
  keeps it plain.
- Without `safeStorage`, or with `MAILFLOW_SECRET_KEY` already in the
  environment, the shell does nothing and the server behaves as in dev.

### Tray and close

- A tray icon (the executable's own icon) with « Ouvrir mailFlow » and
  « Quitter »; a click shows the window.
- Closing the window hides it; the server and its IMAP connections stay. The
  first time, a balloon says so (`shell.json` remembers it was said).
  Quitting is the tray menu, or the default menu's Quit.
- If the tray cannot be created, closing the window quits, as in phase 2.

### Notifications (`desktop/mailWatch.ts`)

- The shell reads the server's event stream. On `exists` for INBOX it lists
  the folder and announces unread messages above the highest UID it had seen
  for that account. The first listing of an account only sets the mark.
- It also lists every authorized account's INBOX every 5 minutes, and when
  the window is closed to the tray. The server keeps one IMAP connection per
  account, idling on the last folder used, and nothing else brings it back
  to INBOX or reopens it after the provider drops it.
- Nothing is announced while the window is visible and focused. One message:
  sender as title, subject as body. Several: their count and up to three
  senders. A click shows the window.
- Mail from a blocked sender is filed away by the listing itself, before the
  comparison: it is never announced.
- `shell.log` records the count of each notification, never a sender or a
  subject.

### Consent

- The start of a consent (`/api/accounts/<id>/oauth`), whether opened as a
  window or followed as a link, is fetched by the main process, which hands
  the provider's address (https only) to the system browser.
- The add-account form opens it without a second click in the app
  (`client/src/lib/desktopApp.ts` reads the user agent), and both waiting
  screens say the consent is in the browser. The « Connexion à … » screen
  now watches the account list, in the browser too, instead of asking for a
  reload.

### Checked on the development PC

Temporary profile, daily server on 4100, no real mailbox.

- Server bundle under Node, token set: 401 without the cookie on `/health`,
  `/`, `/api/accounts`, `/api/events` and a POST; 401 with a wrong, truncated
  or misnamed cookie; 200 with the right one; the callback reaches its route
  (400 for want of a valid `state`). Token unset: everything open.
- `oauth.ts` in a temporary data folder: a plain `tokens.json` is sealed at
  import and read back; a wrong key reads nothing and does not throw; without
  an external key the file stays plain and no `secret.key` appears.
- Packaged app (`win-unpacked`): the interface loads, the cookie is
  `HttpOnly`, strict, session-only and invisible to `document.cookie`;
  `secret.key.bin` is written and no key in clear; an account with a sealed
  secret is read back after a relaunch; a planted `data\secret.key` is
  adopted (the secret sealed afterwards opens with it) and removed; a damaged
  `secret.key.bin` is set aside and the app still starts.
- Closing the window hides it, server still answering; a second launch shows
  and focuses it; quitting logs the server's shutdown and leaves no process.
- The server process killed: the box offers to relaunch, and « Relancer »
  (answered by the test) brings the interface back.
- Consent, with `shell.openExternal` replaced by a recorder: from the welcome
  form, from the « Autoriser » link and by direct navigation, the Microsoft
  authorize address is handed over and the window stays on the app. Another
  app address opened as a window goes nowhere; `file:` is dropped.
- `mailWatch.ts`, unpackaged, against a stand-in server: nothing announced
  for the mail already there, for a focused window, for an event without new
  mail, for a message already read; one notification for one message, one for
  two at once, and again after the numbering restarted lower. Windows
  reported each as shown.

### Not checked

- Everything §6 lists, the installer first. The notifications of an
  installed app depend on the shortcut the installer writes.
- No one looked at the screen: the tray icon, its menu, the balloon and the
  notifications were not seen, and none was clicked.
- A real mailbox: an `exists` event from a real IDLE, the 5-minute check
  (the timer was not waited for), the watcher after a server relaunch.
- A real consent: the system browser was never actually opened, so the
  provider's return on `http://localhost:<port>/api/oauth/callback` and the
  screen updating by itself are untested.
- The waiting screen of an account added from « Comptes »: it takes an
  authorized account to get there.
- `safeStorage` unavailable, Windows shutting down with the app in the tray,
  and the redirect guard (no route of the app redirects outside any more).

## 8. Signing in without registering anything (2026-11-18)

Someone who installs a mail client does not register an OAuth application:
the client ships its own. Thunderbird does exactly that.

### Microsoft: built in

- `desktop/build.mjs` writes mailFlow's Microsoft client id into
  `desktop/app/dist/main.js`. It takes `MS_OAUTH_CLIENT_ID` from the
  environment or `.env`, else the client id of the first Microsoft account in
  `.env`: the rule of `oauthDefaults` in `server/src/config.ts`. A client id
  is public. No other value of `.env` goes into the build.
- `desktop/main.ts` passes it to the server as `MS_OAUTH_CLIENT_ID`, unless
  the environment already sets one. The server needs no change: the form no
  longer asks for an identifier, and the field stays under « Réglages
  avancés » for someone who has their own application.
- Anyone with a personal Microsoft account can then consent: the application
  answers on the `consumers` endpoint, which has no list of allowed users.
  This is deduced from how Entra works, not tried with a second account. The
  consent page will name the application as unverified (§4).
- **The port of the loopback redirect is ignored by Microsoft**, checked on
  2026-11-18 against the authorize endpoint with this application: ports
  4100, 4101 and a random one all reach the sign-in form, while another path
  or another host is refused (`redirect_uri is not valid`). The fallback
  ports of the shell are therefore usable. The token exchange on a port other
  than 4100 was not run.

### Google: not built in

Signing in with Google needs a Google Cloud project of mailFlow's own, and
the scope `https://mail.google.com/` is restricted (§4): unverified, the
application is capped at 100 users behind a warning page, and in « Testing »
each user must be listed by hand and signs in again every 7 days. Nothing was
created at Google, so nothing is shipped.

Until then the form offers Gmail through an app password first whenever no
Google application is known (`AccountSetup.tsx`): it needs a Google account
with 2-step verification, and nothing else. Signing in with Google stays
available to someone who declared their own application.

### Checked

The rebuilt `win-unpacked` with a temporary profile and no variable set: the
Outlook form shows the address and the two optional names only, « Continuer
avec Microsoft » hands the system browser Microsoft's authorize address
carrying the client id of `.env`; the Gmail form opens on the app password.

Reported by the owner the same day, in the installed app, with his own
Outlook.com account: the consent in the browser and the return to the app,
the waiting screen updating by itself, the message list and a message opened.

### Not checked

Anyone else's Microsoft account; a work or school account (tenant `common`);
sending from the installed app; Gmail with an app password.

## 9. Before handing it to someone else (2026-11-18)

### Debugging doors closed

Electron leaves several ways for another program to run code inside the
executable. Each one gave what the session token and the protected key are
there to withhold; the phase 3 checks used two of them.

- `electronFuses` in `desktop/electron-builder.config.cjs`: the executable
  does not become a plain Node with `ELECTRON_RUN_AS_NODE`, ignores
  `NODE_OPTIONS` and `--inspect`, loads its code from `app.asar` only, and
  gives `file://` pages no extra rights.
- `--remote-debugging-port` and `--remote-debugging-pipe` have no fuse:
  `desktop/main.ts` exits at once when the packaged app is given either.
- DevTools are off in the packaged window (`devTools: false`).
- None of this applies unpackaged: `npm run desktop:start` runs the Electron
  of `node_modules`, where `app.isPackaged` is false. That is now the build
  to inspect.

What this does not do: a program running as the same Windows user can still
replace `app.asar` (integrity validation is off, debt register), read the
profile folder, or ask Windows to decrypt the key as that user. The token
and the fuses keep out web pages and casual local access, not malware
already running in the session.

### Icon

`desktop/icon/mailflow.svg` is the drawing; `npm run desktop:icon` renders it
with Electron at nine sizes into `mailflow.ico` (and `mailflow.png`, the
256 px one, to look at). The executable, the installer, the shortcuts, the
window and the tray icon all take it from there.

### Licence notices

`desktop/notices.mjs`, called at the end of `build.mjs`, writes
`desktop/app/THIRD-PARTY-NOTICES.txt`, packed as `LICENSES.mailflow.txt` next
to Electron's own notices: the packages esbuild bundled into the server, every
package reachable from the client's dependencies, better-sqlite3, and the two
embedded fonts. 193 packages on 2026-11-18, all MIT, ISC or BSD (one offers
MIT or EUPL). The build stops if a package declares no licence at all.

### Checked

On the rebuilt `win-unpacked`, from outside, with a temporary profile:

- the fuses read back from the executable as set;
- with `--inspect`: the app starts, answers 401 without the cookie, and no
  inspector listens;
- with `--remote-debugging-port`: it exits with code 1, no port, no server;
- with `ELECTRON_RUN_AS_NODE=1` and a script: the script does not run;
- controls, same probes on the Electron of `node_modules`: the inspector
  listens and the script runs;
- the icon extracted from the executable is the drawing; the notices file is
  in the package.

### Not checked

The rebuilt installer was not run: the icon on the shortcuts and in the tray,
and an install over the previous one. The DevTools menu entry of the packaged
app. `NODE_OPTIONS` was tried only with `--inspect`, which may be ignored for
other reasons: the fuse is read back as off, its effect was not shown.
