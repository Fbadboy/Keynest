'use strict';

/**
 * 生成应用图标（不参与打包）
 * 用法：electron tools/make-icon.js
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SIZE = 256;
const OUT_DIR = path.join(__dirname, '..', 'build');

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent;width:${SIZE}px;height:${SIZE}px;overflow:hidden}
  svg{display:block}
</style></head><body>
<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#9db0ff"/>
      <stop offset="0.55" stop-color="#6f8cff"/>
      <stop offset="1" stop-color="#4f68d8"/>
    </linearGradient>
  </defs>
  <rect x="2" y="2" width="60" height="60" rx="17" fill="url(#g)"/>
  <circle cx="32" cy="25.4" r="6.4" fill="#0b0d10"/>
  <path d="M29.5 28.6h5l1.4 12.4a2.5 2.5 0 0 1-2.5 2.8h-2.8a2.5 2.5 0 0 1-2.5-2.8z" fill="#0b0d10"/>
</svg>
</body></html>`;

function pngToIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);

  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0); // 256px
  entry.writeUInt8(0, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);

  return Buffer.concat([header, entry, png]);
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML));
  await new Promise((r) => setTimeout(r, 600));

  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  const png = image.toPNG();

  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png);
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), pngToIco(png));
  console.log('图标已生成：build/icon.png, build/icon.ico');

  app.quit();
});
