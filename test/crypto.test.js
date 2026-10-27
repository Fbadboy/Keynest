'use strict';

/**
 * 核心逻辑自测（不依赖 Electron）
 * 运行：npm run test:crypto
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { deriveKey, newSalt, encrypt, decrypt } = require('../src/main/crypto');
const { VaultStore } = require('../src/main/store');
const { VaultSession } = require('../src/main/vault');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

async function main() {
  console.log('\n[crypto]');
  const salt = newSalt();
  const key = deriveKey('correct horse battery staple', salt);

  test('密钥派生是确定性的', () => {
    const again = deriveKey('correct horse battery staple', salt);
    assert.ok(key.equals(again));
    assert.strictEqual(key.length, 32);
  });

  test('不同主密码派生不同密钥', () => {
    const other = deriveKey('another password', salt);
    assert.ok(!key.equals(other));
  });

  test('AES-256-GCM 往返一致', () => {
    const payload = { hello: '世界', list: [1, 2, 3] };
    const blob = encrypt(key, payload);
    assert.deepStrictEqual(decrypt(key, blob), payload);
  });

  test('错误密钥无法解密', () => {
    const blob = encrypt(key, { secret: 'x' });
    const wrong = deriveKey('wrong', salt);
    assert.strictEqual(decrypt(wrong, blob), null);
  });

  test('篡改密文会被认证标签拒绝', () => {
    const blob = encrypt(key, { secret: 'x' });
    const raw = Buffer.from(blob.data, 'base64');
    raw[0] ^= 0xff;
    assert.strictEqual(decrypt(key, { ...blob, data: raw.toString('base64') }), null);
  });

  test('篡改 IV 会被认证标签拒绝', () => {
    const blob = encrypt(key, { secret: 'x' });
    const iv = Buffer.from(blob.iv, 'base64');
    iv[0] ^= 0xff;
    assert.strictEqual(decrypt(key, { ...blob, iv: iv.toString('base64') }), null);
  });

  console.log('\n[vault]');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keynest-test-'));
  const store = new VaultStore(dir);
  const session = new VaultSession(store);
  const MASTER = 'My$tr0ng-Master-2026';
  const SECRET = 'p@ssw0rd-plaintext-marker-9f3a';

  test('创建密码库并预置分类', () => {
    session.create(MASTER);
    assert.ok(store.vaultExists());
    const snap = session.snapshot();
    assert.deepStrictEqual(
      snap.folders.map((f) => f.name),
      ['社交', '办公', '金融']
    );
  });

  test('新增多级目录与密码条目', () => {
    const office = session.snapshot().folders.find((f) => f.name === '办公');
    const sub = session.createFolder('邮箱', office.id);
    const entry = session.createEntry({
      folderId: sub.id,
      title: 'Gmail',
      username: 'me@example.com',
      password: SECRET,
      url: 'https://mail.google.com',
    });
    assert.ok(entry.id);
    const snap = session.snapshot();
    assert.strictEqual(snap.entries.length, 1);
    assert.strictEqual(snap.folders.find((f) => f.id === sub.id).parentId, office.id);
  });

  test('磁盘文件不含任何明文', () => {
    const raw = fs.readFileSync(store.vaultFile, 'utf8');
    assert.ok(!raw.includes(SECRET), '密文中出现了明文密码');
    assert.ok(!raw.includes('Gmail'), '密文中出现了明文名称');
    assert.ok(!raw.includes(MASTER), '密文中出现了主密码');
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.cipher.alg, undefined);
    assert.ok(parsed.cipher.data.length > 0);
  });

  test('锁定后内存中的明文被清空', () => {
    session.lock();
    assert.strictEqual(session.isUnlocked, false);
    assert.throws(() => session.snapshot(), /未解锁/);
  });

  test('错误主密码被拒绝', () => {
    const fresh = new VaultSession(store);
    assert.throws(() => fresh.unlock('wrong-password'), /主密码错误/);
  });

  test('正确主密码可恢复全部数据', () => {
    const fresh = new VaultSession(store);
    fresh.unlock(MASTER);
    const snap = fresh.snapshot();
    assert.strictEqual(snap.entries[0].password, SECRET);
    assert.strictEqual(snap.entries[0].title, 'Gmail');
    fresh.lock();
  });

  test('修改主密码后旧密码失效', () => {
    const fresh = new VaultSession(store);
    fresh.unlock(MASTER);
    fresh.changeMasterPassword('Brand-New-Master-2026');
    fresh.lock();

    const reopened = new VaultSession(store);
    assert.throws(() => reopened.unlock(MASTER), /主密码错误/);
    reopened.unlock('Brand-New-Master-2026');
    assert.strictEqual(reopened.snapshot().entries[0].password, SECRET);
    reopened.lock();
  });

  test('删除目录会级联删除子目录与条目', () => {
    const fresh = new VaultSession(store);
    fresh.unlock('Brand-New-Master-2026');
    const office = fresh.snapshot().folders.find((f) => f.name === '办公');
    fresh.deleteFolder(office.id);
    const snap = fresh.snapshot();
    assert.ok(!snap.folders.some((f) => f.name === '办公'));
    assert.ok(!snap.folders.some((f) => f.name === '邮箱'));
    assert.strictEqual(snap.entries.length, 0);
    fresh.lock();
  });

  console.log('\n[settings]');
  const { DEFAULTS, normalize, applyPatch } = require('../src/main/settings');

  test('缺省剪贴板清除时间为 30 秒', () => {
    assert.strictEqual(normalize({}).clipboardClearSeconds, 30);
    assert.strictEqual(DEFAULTS.clipboardClearSeconds, 30);
  });

  test('可自定义剪贴板清除时间', () => {
    assert.strictEqual(normalize({ clipboardClearSeconds: 45 }).clipboardClearSeconds, 45);
    assert.strictEqual(applyPatch({}, { clipboardClearSeconds: '90' }).clipboardClearSeconds, 90);
    assert.strictEqual(applyPatch({}, { clipboardClearSeconds: 12.6 }).clipboardClearSeconds, 13);
  });

  test('越界或非法值被拒绝', () => {
    assert.strictEqual(normalize({ clipboardClearSeconds: 1 }).clipboardClearSeconds, 30);
    assert.strictEqual(normalize({ clipboardClearSeconds: 99999 }).clipboardClearSeconds, 30);
    assert.strictEqual(normalize({ clipboardClearSeconds: 'abc' }).clipboardClearSeconds, 30);
    assert.throws(() => applyPatch({}, { clipboardClearSeconds: 0 }), /5–3600/);
    assert.throws(() => applyPatch({}, { clipboardClearSeconds: 4000 }), /5–3600/);
    assert.throws(() => applyPatch({}, { clipboardClearSeconds: null }), /5–3600/);
  });

  test('设置可持久化到磁盘', () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'keynest-settings-'));
    const s2 = new VaultStore(dir2);
    s2.writeSettings({ clipboardClearSeconds: 120 });
    assert.strictEqual(s2.readSettings().clipboardClearSeconds, 120);
    assert.strictEqual(normalize(s2.readSettings()).clipboardClearSeconds, 120);
    fs.rmSync(dir2, { recursive: true, force: true });
  });

  test('主题默认为深色，可切换为浅色', () => {
    assert.strictEqual(normalize({}).theme, 'dark');
    assert.strictEqual(normalize({ theme: 'light' }).theme, 'light');
    assert.strictEqual(normalize({ theme: 'blue' }).theme, 'dark');
    assert.strictEqual(applyPatch({}, { theme: 'light' }).theme, 'light');
    assert.throws(() => applyPatch({}, { theme: 'auto' }), /主题/);
  });

  test('局部更新不会互相覆盖', () => {
    const base = { clipboardClearSeconds: 60, theme: 'light' };
    assert.deepStrictEqual(applyPatch(base, { theme: 'dark' }), {
      clipboardClearSeconds: 60,
      theme: 'dark',
    });
    assert.deepStrictEqual(applyPatch(base, { clipboardClearSeconds: 10 }), {
      clipboardClearSeconds: 10,
      theme: 'light',
    });
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n通过 ${passed} 项检查${process.exitCode ? '，存在失败项' : ''}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
