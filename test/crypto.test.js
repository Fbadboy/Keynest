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

  console.log('\n[folder order]');
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'keynest-order-'));
  const store3 = new VaultStore(dir3);
  const s3 = new VaultSession(store3);
  const MASTER3 = 'Order-Test-Master-2026';

  test('新建目录自带递增 order', () => {
    s3.create(MASTER3);
    const roots = s3.snapshot().folders.filter((f) => !f.parentId);
    assert.deepStrictEqual(
      roots.map((f) => f.name),
      ['社交', '办公', '金融']
    );
    assert.deepStrictEqual(
      roots.map((f) => f.order),
      [0, 1, 2]
    );
    const extra = s3.createFolder('其它');
    assert.strictEqual(extra.order, 3);
    s3.deleteFolder(extra.id);
  });

  test('拖到目标之前/之后都会改写顺序', () => {
    const byName = (n) => s3.snapshot().folders.find((f) => f.name === n && !f.parentId);
    const social = byName('社交');
    const finance = byName('金融');

    // 把「社交」拖到「金融」之后 → 办公、金融、社交
    s3.reorderFolder(social.id, finance.id, 'after');
    assert.deepStrictEqual(
      s3.snapshot().folders.filter((f) => !f.parentId).sort((a, b) => a.order - b.order).map((f) => f.name),
      ['办公', '金融', '社交']
    );

    // 再拖到「办公」之前 → 社交、办公、金融
    const office = byName('办公');
    s3.reorderFolder(social.id, office.id, 'before');
    assert.deepStrictEqual(
      s3.snapshot().folders.filter((f) => !f.parentId).sort((a, b) => a.order - b.order).map((f) => f.name),
      ['社交', '办公', '金融']
    );
  });

  test('order 连续且无重复', () => {
    const orders = s3.snapshot().folders.filter((f) => !f.parentId).map((f) => f.order).sort((a, b) => a - b);
    assert.deepStrictEqual(orders, [0, 1, 2]);
  });

  test('上移/下移在边界处不动', () => {
    const social = s3.snapshot().folders.find((f) => f.name === '社交' && !f.parentId);
    s3.nudgeFolder(social.id, -1); // 已在首位
    assert.strictEqual(s3.snapshot().folders.find((f) => f.id === social.id).order, 0);

    s3.nudgeFolder(social.id, 1);
    assert.strictEqual(s3.snapshot().folders.find((f) => f.id === social.id).order, 1);
    s3.nudgeFolder(social.id, -1);

    const finance = s3.snapshot().folders.find((f) => f.name === '金融' && !f.parentId);
    s3.nudgeFolder(finance.id, 1); // 已在末位
    assert.strictEqual(s3.snapshot().folders.find((f) => f.id === finance.id).order, 2);
  });

  test('不允许跨层级拖动', () => {
    const office = s3.snapshot().folders.find((f) => f.name === '办公' && !f.parentId);
    const child = s3.createFolder('邮箱', office.id);
    assert.throws(() => s3.reorderFolder(child.id, office.id, 'before'), /同级/);
  });

  test('顺序在重新解锁后仍然保持', () => {
    const finance = s3.snapshot().folders.find((f) => f.name === '金融' && !f.parentId);
    const social = s3.snapshot().folders.find((f) => f.name === '社交' && !f.parentId);
    s3.reorderFolder(finance.id, social.id, 'before'); // 金融、社交、办公
    s3.lock();

    const reopened = new VaultSession(store3);
    reopened.unlock(MASTER3);
    const roots = reopened.snapshot().folders.filter((f) => !f.parentId).sort((a, b) => a.order - b.order);
    assert.deepStrictEqual(
      roots.map((f) => f.name),
      ['金融', '社交', '办公']
    );
    reopened.lock();
  });

  test('旧数据没有 order 时按创建时间补齐', () => {
    const legacy = new VaultSession(store3);
    const normalized = legacy.normalizeVault({
      folders: [
        { id: 'b', name: 'B', parentId: null, createdAt: '2026-01-02T00:00:00.000Z' },
        { id: 'a', name: 'A', parentId: null, createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'c', name: 'C', parentId: 'a', createdAt: '2026-01-03T00:00:00.000Z' },
      ],
      entries: [],
    });
    assert.deepStrictEqual(
      normalized.folders.filter((f) => !f.parentId).map((f) => f.name),
      ['A', 'B']
    );
    assert.deepStrictEqual(
      normalized.folders.filter((f) => !f.parentId).map((f) => f.order),
      [0, 1]
    );
    assert.strictEqual(normalized.folders.find((f) => f.id === 'c').order, 0);
  });

  fs.rmSync(dir3, { recursive: true, force: true });

  console.log('\n[folder move]');
  const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'keynest-move-'));
  const store4 = new VaultStore(dir4);
  const s4 = new VaultSession(store4);
  const MASTER4 = 'Move-Test-Master-2026';
  const byName = (n) => s4.snapshot().folders.find((f) => f.name === n);

  test('移动到另一个目录下', () => {
    s4.create(MASTER4);
    const social = byName('社交');
    const office = byName('办公');
    const inbox = s4.createFolder('邮箱', office.id);
    const entry = s4.createEntry({ folderId: inbox.id, title: 'Gmail', password: 'x' });

    s4.moveFolder(inbox.id, social.id);
    const moved = s4.snapshot().folders.find((f) => f.id === inbox.id);
    assert.strictEqual(moved.parentId, social.id);
    assert.strictEqual(moved.order, 0, '应排到新父级的末尾（首个）');
    // 条目归属不变
    assert.strictEqual(s4.snapshot().entries.find((e) => e.id === entry.id).folderId, inbox.id);
  });

  test('子目录随父目录一起移动', () => {
    const social = byName('社交');
    const inbox = byName('邮箱');
    const inner = s4.createFolder('工作邮箱', inbox.id);
    s4.moveFolder(inbox.id, social.id);
    const all = s4.snapshot().folders;
    assert.strictEqual(all.find((f) => f.id === inbox.id).parentId, social.id);
    assert.strictEqual(all.find((f) => f.id === inner.id).parentId, inbox.id);
  });

  test('可以移动到根目录', () => {
    const inbox = byName('邮箱');
    s4.moveFolder(inbox.id, null);
    assert.strictEqual(s4.snapshot().folders.find((f) => f.id === inbox.id).parentId, null);
  });

  test('不能移动到自身或自己的子目录', () => {
    const inbox = byName('邮箱');
    const inner = byName('工作邮箱');
    assert.throws(() => s4.moveFolder(inbox.id, inbox.id), /自身或子目录/);
    assert.throws(() => s4.moveFolder(inbox.id, inner.id), /自身或子目录/);
  });

  test('目标不存在时报错', () => {
    const inbox = byName('邮箱');
    assert.throws(() => s4.moveFolder(inbox.id, 'no-such-folder'), /目标目录不存在/);
  });

  test('移动结果在重新解锁后保持', () => {
    const inbox = byName('邮箱');
    const finance = byName('金融');
    s4.moveFolder(inbox.id, finance.id);
    s4.lock();

    const reopened = new VaultSession(store4);
    reopened.unlock(MASTER4);
    const all = reopened.snapshot().folders;
    const moved = all.find((f) => f.name === '邮箱');
    assert.strictEqual(moved.parentId, all.find((f) => f.name === '金融').id);
    assert.strictEqual(all.find((f) => f.name === '工作邮箱').parentId, moved.id);
    assert.strictEqual(reopened.snapshot().entries.length, 1);
    reopened.lock();
  });

  fs.rmSync(dir4, { recursive: true, force: true });

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
