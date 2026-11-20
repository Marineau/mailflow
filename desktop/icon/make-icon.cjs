// Draws mailflow.ico from mailflow.svg. Run with Electron, which is the only
// SVG renderer already in the project:
//
//   npm run desktop:icon
//
// Each size is rendered from the vector, not scaled down from the largest:
// a 16 px icon reduced from 256 px turns to blur. The .ico holds the PNGs as
// they are, which Windows has read since Vista.

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const svg = fs.readFileSync(path.join(__dirname, 'mailflow.svg'), 'utf8');

async function render(size) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });
  const page = `<!doctype html><style>html,body{margin:0;background:transparent;overflow:hidden}
svg{display:block;width:${size}px;height:${size}px}</style>${svg}`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  let image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  win.destroy();
  // A scaled display captures more pixels than asked for.
  if (image.getSize().width !== size) image = image.resize({ width: size, height: size, quality: 'best' });
  return image.toPNG();
}

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size === 256 ? 0 : size, 0); // 0 stands for 256
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

app.disableHardwareAcceleration();
// Each size has its own window: closing one must not end the run.
app.on('window-all-closed', () => undefined);
app
  .whenReady()
  .then(async () => {
    const images = [];
    for (const size of SIZES) images.push({ size, png: await render(size) });
    fs.writeFileSync(path.join(__dirname, 'mailflow.ico'), ico(images));
    // The largest, on its own: what to look at after a change to the drawing.
    fs.writeFileSync(path.join(__dirname, 'mailflow.png'), images[images.length - 1].png);
    console.log(`mailflow.ico: ${SIZES.join(', ')} px`);
    app.exit(0);
  })
  .catch((error) => {
    console.error(error.message.slice(0, 300));
    app.exit(1);
  });
