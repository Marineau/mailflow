// electron-builder configuration. Run from the repository root:
//   npm run desktop:pack   unpacked app in desktop/release/win-unpacked
//   npm run desktop:dist   NSIS installer in desktop/release
//
// The app it packs is desktop/app, staged by desktop/build.mjs.

const { version } = require('../package.json');

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.marineau.mailflow',
  productName: 'mailFlow',
  // One version for the whole project: the root package.json.
  extraMetadata: { version },
  directories: { app: 'desktop/app', output: 'desktop/release' },
  files: [
    'package.json',
    'dist/**/*',
    'server/dist/**/*',
    'client/dist/**/*',
    // better-sqlite3 ships its C sources and one binary per platform (27 MB).
    // Only `lib/` and the Windows x64 binary run here; node-addon-api is
    // headers for compiling. An arm64 target would need its binary back.
    '!node_modules/node-addon-api/**',
    '!node_modules/better-sqlite3/{deps,src}/**',
    '!node_modules/better-sqlite3/{binding.gyp,README.md}',
    '!node_modules/better-sqlite3/prebuilds/{darwin,linux,linuxmusl}-*.node',
    '!node_modules/better-sqlite3/prebuilds/win32-arm64.node',
  ],
  asar: true,
  // A native binary cannot be loaded from inside the archive.
  asarUnpack: ['node_modules/better-sqlite3/**'],
  // better-sqlite3 13 is an N-API addon: the binary shipped in its package
  // runs under Electron as it is. Nothing to compile against Electron's ABI.
  npmRebuild: false,
  // Licences of the code bundled into the server and the client (notices.mjs),
  // next to Electron's own in the install folder.
  extraFiles: [{ from: 'desktop/app/THIRD-PARTY-NOTICES.txt', to: 'LICENSES.mailflow.txt' }],
  // Doors Electron leaves open by default, each a way for another program to
  // run code inside mailFlow.exe and read what the session token and the
  // protected key keep from it. The executable then: does not turn into a
  // plain Node with ELECTRON_RUN_AS_NODE, ignores NODE_OPTIONS, ignores
  // --inspect, and loads its code from app.asar only. `--remote-debugging-port`
  // has no fuse: main.ts refuses it. None of this applies to `desktop:start`,
  // which runs the Electron of node_modules and stays debuggable.
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    onlyLoadAppFromAsar: true,
    // Nothing is served from file://.
    grantFileProtocolExtraPrivileges: false,
  },
  // Unsigned, and not published anywhere: both belong to phase 4.
  publish: null,
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    // Drawn from desktop/icon/mailflow.svg by `npm run desktop:icon`. The
    // installer, the shortcuts and the tray icon all take it from the exe.
    icon: 'desktop/icon/mailflow.ico',
  },
  nsis: {
    // Per-user install: no administrator prompt.
    oneClick: true,
    perMachine: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'mailFlow',
    artifactName: 'mailFlow-Setup-${version}.${ext}',
  },
};
