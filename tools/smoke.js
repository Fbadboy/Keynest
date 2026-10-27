'use strict';

/**
 * 端到端冒烟测试（驱动真实界面）
 *
 * 用法：
 *   KEYNEST_DATA_DIR=./.smoke-data electron . --dev --remote-debugging-port=9223
 *   node tools/smoke.js
 */

const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

const PORT = process.env.CDP_PORT || 9223;
const MASTER = 'Smoke#2026';
const OUT = path.join(__dirname, '..', '.preview');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;

function report(name, ok, extra) {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name}${extra ? ` → ${extra}` : ''}`);
  }
}

async function connect() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url));
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 等待端口 */
    }
    await sleep(400);
  }
  throw new Error('未能连接到调试端口');
}

async function main() {
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
  const js = async (body) => {
    const res = await send('Runtime.evaluate', {
      expression: `(() => { ${body} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.result && res.result.exceptionDetails) {
      throw new Error(res.result.exceptionDetails.exception?.description || '脚本异常');
    }
    return res.result?.result?.value;
  };
  const jsAsync = async (body) => {
    const res = await send('Runtime.evaluate', {
      expression: `(async () => { ${body} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.result && res.result.exceptionDetails) {
      throw new Error(res.result.exceptionDetails.exception?.description || '脚本异常');
    }
    return res.result?.result?.value;
  };
  const shot = async (name) => {
    const res = await send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(res.result.data, 'base64'));
  };

  const helpers = `
    window.__row = (name) => [...document.querySelectorAll('.tree-row')]
      .find(r => r.querySelector('.folder-name').textContent.trim() === name);
    window.__entry = (title) => [...document.querySelectorAll('.entry-row')]
      .find(r => r.querySelector('.entry-title').textContent.trim() === title);
    window.__menu = (row, label) => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 240 }));
      const item = [...document.querySelectorAll('.menu-item')].find(i => i.textContent.trim() === label);
      item.click();
    };
  `;

  await sleep(800);
  await js(helpers);

  console.log('\n[解锁]');
  const needsSetup = await js(`return !document.getElementById('setup-form').classList.contains('hidden');`);
  if (needsSetup) {
    await js(`
      document.getElementById('setup-password').value = ${JSON.stringify(MASTER)};
      document.getElementById('setup-confirm').value = ${JSON.stringify(MASTER)};
      document.getElementById('setup-form').requestSubmit();
    `);
    await sleep(1200);
  }

  // 锁定后再测一次错误密码
  await js(`document.getElementById('lock-btn').click();`);
  await sleep(500);
  await js(`
    document.getElementById('master-password').value = 'wrong-password';
    document.getElementById('unlock-form').requestSubmit();
  `);
  await sleep(700);
  const errText = await js(`return document.getElementById('lock-msg').textContent.trim();`);
  report('错误主密码被拒绝并提示', /错误/.test(errText), errText);
  const stillLocked = await js(`return document.getElementById('app-view').classList.contains('hidden');`);
  report('错误密码不会进入主界面', stillLocked);

  await js(`
    document.getElementById('master-password').value = ${JSON.stringify(MASTER)};
    document.getElementById('unlock-form').requestSubmit();
  `);
  await sleep(1000);
  report('正确主密码可解锁', await js(`return !document.getElementById('app-view').classList.contains('hidden');`));

  console.log('\n[离线校验]');
  const probeRaw = await jsAsync(`
    const out = {};
    try { await fetch('https://example.com/ping', { mode: 'no-cors' }); out.fetch = 'allowed'; }
    catch { out.fetch = 'blocked'; }
    out.ws = await new Promise((resolve) => {
      try {
        const sock = new WebSocket('wss://example.com');
        sock.onopen = () => resolve('allowed');
        sock.onerror = () => resolve('blocked');
        setTimeout(() => resolve('blocked'), 2500);
      } catch { resolve('blocked'); }
    });
    out.img = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve('allowed');
      img.onerror = () => resolve('blocked');
      img.src = 'https://example.com/x.png?t=' + Date.now();
      setTimeout(() => resolve('blocked'), 2500);
    });
    return JSON.stringify(out);
  `);
  const probe = JSON.parse(probeRaw);
  report('外部 fetch 被阻止', probe.fetch === 'blocked', probe.fetch);
  report('外部 WebSocket 被阻止', probe.ws === 'blocked', probe.ws);
  report('外部图片被阻止', probe.img === 'blocked', probe.img);

  console.log('\n[目录]');
  await js(`__row('办公').click();`);
  await sleep(300);
  await js(`__row('办公').querySelector('.row-add').click();`);
  await sleep(200);
  await js(`
    document.getElementById('m-input').value = '邮箱';
    document.getElementById('m-ok').click();
  `);
  await sleep(600);
  report('新建下级目录', Boolean(await js(`return !!__row('邮箱');`)));

  await js(`__row('邮箱').click();`);
  await sleep(200);
  await js(`__row('邮箱').querySelector('.row-add').click();`);
  await sleep(200);
  await js(`
    document.getElementById('m-input').value = '客户系统';
    document.getElementById('m-ok').click();
  `);
  await sleep(600);
  report('支持三级目录', Boolean(await js(`return !!__row('客户系统');`)));

  await js(`__row('办公').querySelector('.twist').click();`);
  await sleep(300);
  report('目录可收起', await js(`return !__row('邮箱');`));
  await js(`__row('办公').querySelector('.twist').click();`);
  await sleep(300);
  report('目录可展开', Boolean(await js(`return !!__row('邮箱');`)));

  await js(`__menu(__row('邮箱'), '重命名');`);
  await sleep(200);
  await js(`
    document.getElementById('m-input').value = '邮箱账号';
    document.getElementById('m-ok').click();
  `);
  await sleep(600);
  report('目录重命名', Boolean(await js(`return !!__row('邮箱账号');`)));

  console.log('\n[条目]');
  await js(`__row('邮箱账号').click();`);
  await sleep(200);
  await js(`document.getElementById('new-entry-btn').click();`);
  await sleep(200);
  await js(`
    document.getElementById('f-title').value = 'Gmail';
    document.getElementById('f-username').value = 'fxy@gmail.com';
    document.getElementById('f-password').value = 'q7#Lm2vX!pZr9a';
    document.getElementById('entry-form').requestSubmit();
  `);
  await sleep(700);
  report('新增密码条目', Boolean(await js(`return !!__entry('Gmail');`)));
  const detailTitle = await js(`return (document.querySelector('.detail-title') || {}).textContent;`);
  report('保存后自动展示详情', detailTitle === 'Gmail', detailTitle);

  const masked = await js(`return (document.querySelector('.field-value.secret') || {}).textContent || '';`);
  report('密码默认以掩码显示', /^•+$/.test(masked), masked);
  await js(`document.querySelector('[data-reveal]').click();`);
  await sleep(250);
  const revealed = await js(`
    const el = document.querySelector('.field-value.mono');
    return [...document.querySelectorAll('.field-value')].map(e => e.textContent).join('|');
  `);
  report('可切换显示明文密码', revealed.includes('q7#Lm2vX!pZr9a'), revealed);

  await js(`document.querySelector('[data-act="edit"]').click();`);
  await sleep(250);
  await js(`
    document.getElementById('f-title').value = 'Gmail 工作号';
    document.getElementById('f-notes').value = '已开启两步验证';
    document.getElementById('entry-form').requestSubmit();
  `);
  await sleep(700);
  report('编辑条目', Boolean(await js(`return !!__entry('Gmail 工作号');`)));

  console.log('\n[搜索]');
  await js(`
    const s = document.getElementById('search');
    s.value = 'gmail';
    s.dispatchEvent(new Event('input'));
  `);
  await sleep(300);
  report('搜索可过滤', (await js(`return document.querySelectorAll('.entry-row').length;`)) === 1);
  await js(`
    const s = document.getElementById('search');
    s.value = '';
    s.dispatchEvent(new Event('input'));
  `);
  await sleep(300);

  console.log('\n[剪贴板设置]');
  const defaultSeconds = await jsAsync(`
    const r = await window.keynest.getSettings();
    return r.data.clipboardClearSeconds;
  `);
  report('默认清除时间为 30 秒', defaultSeconds === 30, String(defaultSeconds));

  await js(`document.getElementById('settings-btn').click();`);
  await sleep(700);
  await js(`
    const input = document.getElementById('clip-seconds');
    input.value = '45';
    input.dispatchEvent(new Event('change'));
  `);
  await sleep(700);
  const savedSeconds = await jsAsync(`
    const r = await window.keynest.getSettings();
    return r.data.clipboardClearSeconds;
  `);
  report('可自定义清除时间并持久化', savedSeconds === 45, String(savedSeconds));

  const copiedSeconds = await jsAsync(`
    const r = await window.keynest.copy({ value: 'keynest-smoke', secret: true });
    return r.data.clearSeconds;
  `);
  report('复制密码按自定义秒数计时', copiedSeconds === 45, String(copiedSeconds));

  await js(`
    const input = document.getElementById('clip-seconds');
    input.value = '2';
    input.dispatchEvent(new Event('change'));
  `);
  await sleep(700);
  const afterInvalid = await jsAsync(`
    const r = await window.keynest.getSettings();
    return r.data.clipboardClearSeconds;
  `);
  report('越界值被拒绝且不改动原值', afterInvalid === 45, String(afterInvalid));

  console.log('\n[主题]');
  await js(`document.querySelector('#theme-seg .seg-btn[data-theme="light"]').click();`);
  await sleep(700);
  const lightTheme = await js(`return document.documentElement.getAttribute('data-theme');`);
  report('可切换为浅色主题', lightTheme === 'light', lightTheme);
  await shot('smoke-light.png');

  const persistedTheme = await jsAsync(`
    const r = await window.keynest.getSettings();
    return r.data.theme;
  `);
  report('主题选择已持久化', persistedTheme === 'light', String(persistedTheme));

  await js(`document.querySelector('#theme-seg .seg-btn[data-theme="dark"]').click();`);
  await sleep(600);
  const darkTheme = await js(`return document.documentElement.getAttribute('data-theme');`);
  report('可切回深色主题', darkTheme === 'dark', darkTheme);

  await js(`document.getElementById('m-close').click();`);
  await sleep(200);
  await jsAsync(`await window.keynest.copy({ value: '', secret: false });`);

  console.log('\n[删除]');
  await js(`__row('全部密码').click();`);
  await sleep(200);
  await js(`__entry('Gmail 工作号').click();`);
  await sleep(200);
  await js(`document.querySelector('[data-act="delete"]').click();`);
  await sleep(250);
  await shot('smoke-confirm.png');
  await js(`document.getElementById('m-ok').click();`);
  await sleep(700);
  report('删除条目', !(await js(`return !!__entry('Gmail 工作号');`)));

  await js(`__menu(__row('办公'), '删除目录');`);
  await sleep(250);
  await js(`document.getElementById('m-ok').click();`);
  await sleep(800);
  report('级联删除目录', await js(`return !__row('办公') && !__row('邮箱账号') && !__row('客户系统');`));

  console.log('\n[锁定]');
  await js(`document.getElementById('lock-btn').click();`);
  await sleep(600);
  report('手动锁定回到解锁页', await js(`return !document.getElementById('lock-view').classList.contains('hidden') && document.getElementById('app-view').classList.contains('hidden');`));

  await js(`
    document.getElementById('master-password').value = ${JSON.stringify(MASTER)};
    document.getElementById('unlock-form').requestSubmit();
  `);
  await sleep(1000);
  const persisted = await js(`
    return [...document.querySelectorAll('.tree-row .folder-name')].map(e => e.textContent.trim()).join(',');
  `);
  report('重新解锁后数据保持一致', /社交/.test(persisted) && /金融/.test(persisted) && !/办公/.test(persisted), persisted);

  await shot('smoke-final.png');

  const resourceEntries = JSON.parse(
    await js(`
      return JSON.stringify(
        performance.getEntriesByType('resource').map((e) => ({ n: e.name, s: e.transferSize }))
      );
    `)
  );
  const leaked = resourceEntries.filter((e) => !/^(file|data|blob):/.test(e.n) && e.s > 0);
  report(
    '全程没有任何外部数据真正传输',
    leaked.length === 0,
    leaked.map((e) => `${e.n}(${e.s}B)`).join(' , ')
  );

  ws.close();
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
