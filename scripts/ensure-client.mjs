// Publishes client/dist when sources are newer than the last published build.
// The desktop shortcut serves that folder on :4100. A reboot restarts the
// process but does not rebuild, so the UI stayed on the previous snapshot.
//
// Exit codes: 0 published or already current, 2 build failed and the previous
// dist is still in place, 1 build failed and there is nothing to serve.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientDir = path.join(root, 'client');
const distDir = path.join(clientDir, 'dist');
const stagingDir = path.join(clientDir, 'dist-staging');
const previousDir = path.join(clientDir, 'dist-previous');
const stampName = '.source-mtime';

const inputFiles = ['index.html', 'vite.config.ts', 'package.json', 'tsconfig.json'].map((name) =>
  path.join(clientDir, name),
);

function latestMtime(target) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return 0;
  }

  if (!stat.isDirectory()) return stat.mtimeMs;

  let latest = stat.mtimeMs;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === 'dist-staging' ||
      entry.name === 'dist-previous'
    ) {
      continue;
    }
    latest = Math.max(latest, latestMtime(path.join(target, entry.name)));
  }
  return latest;
}

function sourceStamp() {
  let latest = latestMtime(path.join(clientDir, 'src'));
  latest = Math.max(latest, latestMtime(path.join(clientDir, 'public')));
  for (const file of inputFiles) latest = Math.max(latest, latestMtime(file));
  return Math.round(latest);
}

function readStamp() {
  try {
    const value = Number(fs.readFileSync(path.join(distDir, stampName), 'utf8').trim());
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function hasIndex(dir) {
  return fs.existsSync(path.join(dir, 'index.html'));
}

const lockPath = path.join(root, 'server', 'data', 'client-build.lock');

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (err) {
      if (!(err instanceof Error) || !('code' in err) || err.code !== 'EEXIST') throw err;
      const holder = Number(fs.readFileSync(lockPath, 'utf8'));
      if (!pidAlive(holder)) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      Atomics.wait(pause, 0, 0, 500);
    }
  }
  console.error('Timed out waiting for another client build.');
  process.exit(hasIndex(distDir) ? 2 : 1);
}

function releaseLock() {
  try {
    if (Number(fs.readFileSync(lockPath, 'utf8')) === process.pid) fs.rmSync(lockPath, { force: true });
  } catch {
    // Another run already cleared the lock.
  }
}

function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: clientDir,
    stdio: 'inherit',
    windowsHide: true,
    env: process.env,
  });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

function fail() {
  fs.rmSync(stagingDir, { recursive: true, force: true });
  process.exit(hasIndex(distDir) ? 2 : 1);
}

acquireLock();
process.on('exit', releaseLock);

const sources = sourceStamp();
const built = readStamp() || Math.round(latestMtime(path.join(distDir, 'index.html')));

if (sources > 0 && sources <= built && hasIndex(distDir)) {
  if (!readStamp()) fs.writeFileSync(path.join(distDir, stampName), String(sources));
  console.log('Pli client is up to date.');
  process.exit(0);
}

console.log('Pli client is older than the sources. Rebuilding.');
fs.rmSync(stagingDir, { recursive: true, force: true });

const tsc = path.join(root, 'node_modules', 'typescript', 'lib', 'tsc.js');
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

if (run(tsc, ['-b']) !== 0) fail();
if (
  run(vite, ['build', '--outDir', 'dist-staging', '--emptyOutDir', 'true']) !== 0
) {
  fail();
}

if (!hasIndex(stagingDir)) {
  console.error('Client build produced no index.html.');
  fail();
}

fs.writeFileSync(path.join(stagingDir, stampName), String(sources));

try {
  fs.rmSync(previousDir, { recursive: true, force: true });
  if (fs.existsSync(distDir)) fs.renameSync(distDir, previousDir);
  fs.renameSync(stagingDir, distDir);
  fs.rmSync(previousDir, { recursive: true, force: true });
} catch (err) {
  // Windows refuses to rename a directory the running API has open. Copying
  // into the live folder still publishes: the server re-reads each request.
  if (hasIndex(stagingDir)) {
    try {
      fs.cpSync(stagingDir, distDir, { recursive: true });
      fs.rmSync(stagingDir, { recursive: true, force: true });
      if (hasIndex(distDir) && fs.existsSync(previousDir)) {
        fs.rmSync(previousDir, { recursive: true, force: true });
      }
      console.log('Pli client published in place.');
      process.exit(0);
    } catch (copyErr) {
      console.error(
        `Could not copy the client build into place: ${copyErr instanceof Error ? copyErr.message : copyErr}`,
      );
    }
  }
  console.error(`Could not publish the client build: ${err instanceof Error ? err.message : err}`);
  if (!hasIndex(distDir) && fs.existsSync(previousDir)) {
    try {
      fs.renameSync(previousDir, distDir);
    } catch (rollbackErr) {
      console.error(
        `Could not restore the previous client: ${rollbackErr instanceof Error ? rollbackErr.message : rollbackErr}`,
      );
    }
  }
  process.exit(hasIndex(distDir) ? 2 : 1);
}

console.log('Pli client published.');
