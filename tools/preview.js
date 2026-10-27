'use strict';

/**
 * 开发期 UI 预览脚本（不参与打包）
 * 通过 CDP 驱动真实界面完成一遍完整流程并截图。
 *
 * 用法：
 *   KEYNEST_DATA_DIR=./.preview-data electron . --dev --remote-debugging-port=9222
 *   node tools/preview.js
 */

const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

const OUT = path.join(__dirname, '..', '.preview');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch('http://127.0.0.1:9222/json/list');
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url));
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 等待调试端口就绪 */
    }
    await sleep(400);
  }
  throw new Error('未能连接到 Electron 调试端口');
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const url = await connect();
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  let seq = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.result && res.result.exceptionDetails) {
      throw new Error(res.result.exceptionDetails.exception?.description || 'evaluate 失败');
    }
    return res.result?.result?.value;
  };

  const shot = async (name) => {
    const res = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(res.result.data, 'base64'));
    console.log('  →', name);
  };

  const clickFolder = (name) =>
    evaluate(`
      const row = [...document.querySelectorAll('.tree-row')]
        .find(r => r.querySelector('.folder-name').textContent.trim() === ${JSON.stringify(name)});
      if (!row) throw new Error('未找到目录 ' + ${JSON.stringify(name)});
      row.click();
    `);

  const addFolder = async (parentName, name) => {
    if (parentName) {
      await evaluate(`
        const row = [...document.querySelectorAll('.tree-row')]
          .find(r => r.querySelector('.folder-name').textContent.trim() === ${JSON.stringify(parentName)});
        row.querySelector('.row-add').click();
      `);
    } else {
      await evaluate(`document.getElementById('add-folder-btn').click();`);
    }
    await sleep(120);
    await evaluate(`
      document.getElementById('m-input').value = ${JSON.stringify(name)};
      document.getElementById('m-ok').click();
    `);
    await sleep(420);
  };

  const addEntry = async (folderName, entry) => {
    await clickFolder(folderName);
    await sleep(120);
    await evaluate(`document.getElementById('new-entry-btn').click();`);
    await sleep(120);
    await evaluate(`
      document.getElementById('f-title').value = ${JSON.stringify(entry.title)};
      document.getElementById('f-username').value = ${JSON.stringify(entry.username)};
      document.getElementById('f-password').value = ${JSON.stringify(entry.password)};
      document.getElementById('f-url').value = ${JSON.stringify(entry.url || '')};
      document.getElementById('f-notes').value = ${JSON.stringify(entry.notes || '')};
      document.getElementById('entry-form').requestSubmit();
    `);
    await sleep(420);
  };

  await sleep(900);
  await shot('01-setup.png');

  await evaluate(`
    document.getElementById('setup-password').value = 'Keynest#2026';
    document.getElementById('setup-password').dispatchEvent(new Event('input'));
    document.getElementById('setup-confirm').value = 'Keynest#2026';
    document.getElementById('setup-form').requestSubmit();
  `);
  await sleep(1200);
  await shot('02-empty.png');

  await addFolder('办公', '邮箱');
  await addFolder('邮箱', '客户系统');
  await addFolder('社交', '论坛');

  await addEntry('邮箱', {
    title: 'Gmail',
    username: 'fxy@gmail.com',
    password: 'q7#Lm2vX!pZr9a',
    url: 'https://mail.google.com',
    notes: '备用验证器已绑定',
  });
  await addEntry('办公', { title: 'GitHub', username: 'fxy-dev', password: 'Gh!8xQ2mWn4#Tk', url: 'https://github.com' });
  await addEntry('金融', {
    title: '招商银行',
    username: '6225 **** 8891',
    password: 'Cmb@2026#8891',
    notes: '手机银行登录密码',
  });
  await addEntry('社交', { title: '微博', username: '138****6621', password: 'Wb@2026#6621' });

  await clickFolder('办公');
  await sleep(300);
  await shot('03-tree.png');

  await evaluate(`
    const row = [...document.querySelectorAll('.entry-row')]
      .find(r => r.querySelector('.entry-title').textContent.trim() === 'Gmail');
    row.click();
  `);
  await sleep(2600); // 等待 toast 消失，便于截图
  await shot('04-detail.png');

  await evaluate(`
    const btn = document.querySelector('[data-reveal]');
    if (btn) btn.click();
  `);
  await sleep(300);
  await shot('05-reveal.png');

  await evaluate(`document.getElementById('settings-btn').click();`);
  await sleep(400);
  await shot('06-settings.png');

  // 浅色主题（设置面板此时仍开着）
  await evaluate(`document.querySelector('#theme-seg .seg-btn[data-theme="light"]').click();`);
  await sleep(600);
  await shot('06b-settings-light.png');
  await evaluate(`document.getElementById('m-close').click();`);
  await sleep(500);
  await shot('10-light-main.png');
  await evaluate(`document.getElementById('lock-btn').click();`);
  await sleep(800);
  await shot('11-light-lock.png');

  if (process.env.SKIP_HELLO === '1') {
    ws.close();
    console.log('\n预览截图已生成：', OUT);
    return;
  }

  // 恢复深色后继续验证生物识别
  await evaluate(`
    document.getElementById('master-password').value = 'Keynest#2026';
    document.getElementById('unlock-form').requestSubmit();
  `);
  await sleep(1200);
  await evaluate(`document.getElementById('settings-btn').click();`);
  await sleep(600);
  await evaluate(`document.querySelector('#theme-seg .seg-btn[data-theme="dark"]').click();`);
  await sleep(500);

  // 启用 Windows Hello
  await evaluate(`document.getElementById('bio-switch').click();`);
  await sleep(1800);
  await shot('07-biometric-on.png');
  await evaluate(`document.getElementById('m-close').click();`);
  await sleep(200);

  await evaluate(`document.getElementById('lock-btn').click();`);
  await sleep(700);
  await shot('08-locked.png');

  // 尝试用 Windows Hello 解锁（会弹系统验证窗口）
  const started = Date.now();
  await evaluate(`document.getElementById('hello-btn').click();`);
  let unlocked = false;
  for (let i = 0; i < 30; i += 1) {
    await sleep(1000);
    unlocked = await evaluate(`return !document.getElementById('app-view').classList.contains('hidden');`);
    if (unlocked) break;
  }
  await shot('09-after-hello.png');
  console.log(`\nWindows Hello 解锁：${unlocked ? '通过' : '未完成'}（${Math.round((Date.now() - started) / 1000)}s）`);

  ws.close();
  console.log('预览截图已生成：', OUT);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
