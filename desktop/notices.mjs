// Licence notices of the third-party code the packaged app carries.
//
// The server bundle and the client bundle inline their dependencies, and a
// bundler keeps almost none of the licence texts, which most packages ship as
// a separate file. Nearly all of these licences (MIT, ISC, BSD, Apache-2.0)
// require the text to travel with the code: this collects them in one file.
//
// Three sources:
//   - the server: the packages esbuild actually bundled (its metafile);
//   - the client: every package reachable from client/package.json's
//     `dependencies`. Vite gives no list of what it bundled, so this lists a
//     little more than what ships, which costs nothing;
//   - the stage: better-sqlite3 and what it depends on.
// Plus the licences of the embedded fonts, kept next to them in the sources.
//
// Electron's own notices (LICENSE.electron.txt, LICENSES.chromium.html) are
// put in the package by electron-builder.

import fs from 'node:fs';
import path from 'node:path';

const LICENCE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

/** `…/node_modules/@scope/name/lib/x.js` → `…/node_modules/@scope/name`. */
function packageDirOf(file) {
  const parts = file.split(/[\\/]/);
  const at = parts.lastIndexOf('node_modules');
  if (at === -1) return null;
  const scoped = parts[at + 1]?.startsWith('@');
  return parts.slice(0, at + (scoped ? 3 : 2)).join('/');
}

/** Node's lookup: `node_modules/<name>` in `from`, then in each folder above it. */
function resolvePackage(name, from, stopAt) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.resolve(dir) === path.resolve(stopAt) || path.dirname(dir) === dir) return null;
  }
}

/** Every package reachable from the `dependencies` of the package in `start`. */
function closure(start, stopAt) {
  const found = new Set();
  const visit = (dir) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    // Optional ones may be absent on this platform; peers are someone's dependency already.
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      const resolved = resolvePackage(name, dir, stopAt);
      if (!resolved || found.has(resolved)) continue;
      found.add(resolved);
      visit(resolved);
    }
  };
  visit(start);
  return found;
}

function describe(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const licence =
    typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? pkg.licenses?.[0]?.type ?? '');
  const repository = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? '');
  const texts = fs
    .readdirSync(dir)
    .filter((name) => LICENCE_FILE.test(name) && fs.statSync(path.join(dir, name)).isFile())
    .sort()
    .map((name) => fs.readFileSync(path.join(dir, name), 'utf8').trim());
  return {
    name: pkg.name,
    version: pkg.version,
    licence,
    source: (pkg.homepage || repository).replace(/^git\+/, '').replace(/\.git$/, ''),
    text: texts.join('\n\n'),
  };
}

/**
 * Writes the notices file and returns what it holds:
 * `{ packages, withoutText: string[], unlicensed: string[] }`.
 */
export function writeNotices({ root, appDir, serverInputs, outFile }) {
  const dirs = new Set();
  for (const input of serverInputs) {
    const dir = packageDirOf(input);
    if (dir) dirs.add(path.resolve(root, dir));
  }
  for (const dir of closure(path.join(root, 'client'), root)) dirs.add(path.resolve(dir));
  for (const dir of closure(appDir, appDir)) dirs.add(path.resolve(dir));

  // One entry per name and version: a package installed twice says the same thing twice.
  const packages = new Map();
  for (const dir of dirs) {
    const entry = describe(dir);
    const key = `${entry.name}@${entry.version}`;
    if (!packages.has(key) || (!packages.get(key).text && entry.text)) packages.set(key, entry);
  }
  const sorted = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));

  const rule = '-'.repeat(78);
  const sections = sorted.map((p) =>
    [
      rule,
      `${p.name} ${p.version}`,
      `Licence: ${p.licence || 'not declared'}`,
      ...(p.source ? [p.source] : []),
      rule,
      p.text || `(The package ships no licence file. Declared licence: ${p.licence || 'none'}.)`,
    ].join('\n'),
  );

  const fontsDir = path.join(root, 'client', 'src', 'assets', 'fonts');
  const fonts = fs
    .readdirSync(fontsDir)
    .filter((name) => /licen[cs]e/i.test(name))
    .sort()
    .map((name) =>
      [rule, `Font: ${name.replace(/[-_]?licen[cs]e.*$/i, '')}`, rule, fs.readFileSync(path.join(fontsDir, name), 'utf8').trim()].join('\n'),
    );

  const header = [
    'mailFlow — third-party notices',
    '',
    'mailFlow includes the software and fonts listed below, each under its own',
    'licence. The notices of Electron and Chromium are in LICENSE.electron.txt and',
    'LICENSES.chromium.html, next to this file. SQLite, compiled into',
    'better-sqlite3, is in the public domain.',
    '',
    `${sorted.length} packages, ${fonts.length} fonts.`,
  ].join('\n');

  fs.writeFileSync(outFile, `${[header, ...sections, ...fonts].join('\n\n')}\n`);
  return {
    packages: sorted.length,
    fonts: fonts.length,
    withoutText: sorted.filter((p) => !p.text).map((p) => `${p.name}@${p.version} (${p.licence || 'none'})`),
    unlicensed: sorted.filter((p) => !p.text && !p.licence).map((p) => `${p.name}@${p.version}`),
    licences: sorted.reduce((count, p) => {
      const key = p.licence || 'not declared';
      count[key] = (count[key] ?? 0) + 1;
      return count;
    }, {}),
  };
}
