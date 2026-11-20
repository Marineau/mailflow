// Stages the packaged app in desktop/app, the folder electron-builder packs:
//
//   desktop/app/dist/main.js          Electron main process (desktop/main.ts)
//   desktop/app/server/dist/index.js  the server, bundled to one file
//   desktop/app/client/dist/          the interface
//   desktop/app/node_modules/         better-sqlite3, the only module left out
//                                     of the bundle (native binary)
//   desktop/app/THIRD-PARTY-NOTICES.txt  licences of the bundled code (notices.mjs)
//
// The client is built straight into the stage: client/dist is the folder the
// daily server is serving, and it is not touched.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { build } from 'esbuild';
import { writeNotices } from './notices.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(root, 'desktop', 'app');
const clientDir = path.join(root, 'client');
const tsc = path.join(root, 'node_modules', 'typescript', 'lib', 'tsc.js');
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

function step(label, run) {
  console.log(`\n— ${label}`);
  const result = run();
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) {
    console.error(`Failed: ${label}`);
    process.exit(result.status ?? 1);
  }
}

function node(script, args, cwd = root) {
  return spawnSync(process.execPath, [script, ...args], { cwd, stdio: 'inherit' });
}

// esbuild does not check types: nothing is bundled from code tsc refuses.
step('Typecheck: server', () => node(tsc, ['-p', 'server/tsconfig.json', '--noEmit']));
step('Typecheck: client', () => node(tsc, ['-b', '--noEmit'], clientDir));
step('Typecheck: desktop', () => node(tsc, ['-p', 'desktop/tsconfig.json', '--noEmit']));

step('Client', () =>
  node(vite, ['build', '--outDir', path.join(appDir, 'client', 'dist'), '--emptyOutDir'], clientDir),
);

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'info',
};

console.log('\n— Server bundle');
fs.rmSync(path.join(appDir, 'server'), { recursive: true, force: true });
const serverBuild = await build({
  ...shared,
  // The list of what went into the bundle, for the licence notices below.
  metafile: true,
  absWorkingDir: root,
  entryPoints: [path.join(root, 'server', 'src', 'index.ts')],
  outfile: path.join(appDir, 'server', 'dist', 'index.js'),
  // The one native module: it is installed in the stage and loaded from there.
  external: ['better-sqlite3'],
  // config.ts finds its folders from `import.meta.url`, which a CommonJS
  // bundle does not have. Same value, taken from the bundle's own path.
  define: { 'import.meta.url': 'importMetaUrl' },
  banner: { js: "const importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
});

/**
 * The Microsoft application the packaged app signs in with, by the rule of
 * `oauthDefaults` in server/src/config.ts: `MS_OAUTH_CLIENT_ID`, else the
 * client id of the first Microsoft account declared in `.env`. A client id is
 * public. Nothing else is taken from `.env`, and no secret is ever written
 * into the build.
 */
function microsoftClientId() {
  const envFile = path.join(root, '.env');
  const env = {
    ...(fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {}),
    ...process.env,
  };
  const explicit = env.MS_OAUTH_CLIENT_ID?.trim();
  if (explicit) return explicit;
  for (let n = 1; env[`MAIL_${n}_ID`]; n++) {
    const id = env[`MAIL_${n}_OAUTH_CLIENT_ID`]?.trim();
    if (env[`MAIL_${n}_AUTH`] === 'oauth2' && env[`MAIL_${n}_OAUTH_PROVIDER`] !== 'google' && id) {
      return id;
    }
  }
  return '';
}

console.log('\n— Electron main');
const msClientId = microsoftClientId();
console.log(
  msClientId
    ? '  Microsoft application: client id written into the build'
    : '  Microsoft application: none found (MS_OAUTH_CLIENT_ID); the app will ask each user for one',
);
await build({
  ...shared,
  entryPoints: [path.join(root, 'desktop', 'main.ts')],
  outfile: path.join(appDir, 'dist', 'main.js'),
  external: ['electron'],
  define: { __MS_OAUTH_CLIENT_ID__: JSON.stringify(msClientId) },
});

// The stage has its own node_modules, apart from the workspace: the packaged
// app may pin another better-sqlite3 than the dev server without touching it.
const wanted = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).dependencies[
  'better-sqlite3'
];
let installed = null;
try {
  installed = JSON.parse(
    fs.readFileSync(path.join(appDir, 'node_modules', 'better-sqlite3', 'package.json'), 'utf8'),
  ).version;
} catch {
  // Not installed yet.
}

if (installed === wanted) {
  console.log(`\n— Runtime dependency: better-sqlite3 ${installed} already in the stage`);
} else {
  const command = fs.existsSync(path.join(appDir, 'package-lock.json')) ? 'ci' : 'install';
  step(`Runtime dependency: npm ${command} in desktop/app (better-sqlite3 ${wanted})`, () =>
    // npm is a .cmd on Windows: it only starts through a shell.
    spawnSync('npm', [command, '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: appDir,
      stdio: 'inherit',
      shell: true,
    }),
  );
}

// After the install above: better-sqlite3's own licence is read from the stage.
console.log('\n— Third-party notices');
const notices = writeNotices({
  root,
  appDir,
  serverInputs: Object.keys(serverBuild.metafile.inputs),
  outFile: path.join(appDir, 'THIRD-PARTY-NOTICES.txt'),
});
console.log(
  `  ${notices.packages} packages, ${notices.fonts} fonts: ${Object.entries(notices.licences)
    .sort((a, b) => b[1] - a[1])
    .map(([licence, count]) => `${licence} ×${count}`)
    .join(', ')}`,
);
if (notices.withoutText.length > 0) {
  console.log(`  No licence file in: ${notices.withoutText.join(', ')}`);
}
// A package that says nothing about its licence grants nothing: not shipped blind.
if (notices.unlicensed.length > 0) {
  console.error(`Failed: no licence declared by ${notices.unlicensed.join(', ')}`);
  process.exit(1);
}

console.log('\nStage ready: desktop/app');
