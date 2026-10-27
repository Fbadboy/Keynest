'use strict';

/**
 * 开发辅助：抓取 Keynest 窗口（含系统标题栏按钮）用于核对配色。
 * 用法：electron tools/capture.js <输出路径> [窗口标题关键字]
 */

const { app, desktopCapturer } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const out = process.argv[2] || 'window.png';
const keyword = process.argv[3] || 'Keynest';

app.setPath('userData', path.join(os.tmpdir(), 'keynest-capture-profile'));

app.whenReady().then(async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 1400, height: 1000 },
    fetchWindowIcons: false,
  });
  const names = sources.map((s) => s.name);
  const target = sources.find((s) => s.name.includes(keyword));
  if (!target) {
    console.error('未找到窗口，可用窗口：', names.join(' | '));
    app.quit();
    return;
  }
  fs.writeFileSync(out, target.thumbnail.toPNG());
  console.log('saved', out, 'from', target.name);
  app.quit();
});
