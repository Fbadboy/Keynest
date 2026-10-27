'use strict';

/**
 * 会话层：管理「已解锁」状态与密码库的增删改查。
 * 明文只存在于内存中，锁定时立即丢弃。
 */

const crypto = require('node:crypto');
const { KDF_PARAMS, deriveKey, newSalt, encrypt, decrypt, wipe } = require('./crypto');

const DEFAULT_FOLDERS = ['社交', '办公', '金融'];
const MAX_NAME = 80;

function emptyVault() {
  return { version: 1, folders: [], entries: [] };
}

function makeId() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

function str(value, max = 4096) {
  if (value == null) return '';
  return String(value).slice(0, max);
}

function parentOf(folder) {
  return folder.parentId || null;
}

/** 同级目录按 order 升序；order 相同或缺失时退化为 createdAt、再退化为原数组位置 */
function compareSiblings(a, b) {
  const oa = Number.isFinite(a.order) ? a.order : Number.MAX_SAFE_INTEGER;
  const ob = Number.isFinite(b.order) ? b.order : Number.MAX_SAFE_INTEGER;
  if (oa !== ob) return oa - ob;
  const ca = String(a.createdAt || '');
  const cb = String(b.createdAt || '');
  if (ca !== cb) return ca < cb ? -1 : 1;
  return 0;
}

/**
 * 归一化目录顺序：每个父级下的子目录 order 从 0 连续递增。
 * 旧版本数据没有 order 字段，按 createdAt 补号——正好等于旧版的展示顺序，
 * 因此升级后用户看到的目录顺序不会发生变化。
 */
function normalizeOrder(folders) {
  const groups = new Map();
  for (const folder of folders) {
    const key = parentOf(folder);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(folder);
  }
  const result = [];
  for (const group of groups.values()) {
    group.sort(compareSiblings);
    group.forEach((folder, index) => {
      folder.order = index;
      result.push(folder);
    });
  }
  return result;
}

class VaultSession {
  constructor(store) {
    this.store = store;
    this.key = null;
    this.data = null;
  }

  get isUnlocked() {
    return this.data !== null;
  }

  isInitialized() {
    return this.store.vaultExists();
  }

  /** 首次创建密码库 */
  create(masterPassword) {
    if (this.isInitialized()) throw new Error('密码库已存在');
    if (typeof masterPassword !== 'string' || masterPassword.length < 6) {
      throw new Error('主密码至少需要 6 个字符');
    }
    const salt = newSalt();
    const key = deriveKey(masterPassword, salt);
    const vault = emptyVault();
    vault.folders = DEFAULT_FOLDERS.map((name, index) => ({
      id: makeId(),
      name,
      parentId: null,
      order: index,
      createdAt: now(),
    }));
    this.persist(key, salt, vault, KDF_PARAMS);
    this.key = key;
    this.data = vault;
    return true;
  }

  /** 主密码解锁 */
  unlock(masterPassword) {
    const payload = this.store.readVault();
    if (!payload) throw new Error('密码库不存在或已损坏');
    const params = { ...KDF_PARAMS, ...(payload.kdf || {}) };
    const salt = Buffer.from(payload.kdf.salt, 'base64');
    const key = deriveKey(String(masterPassword == null ? '' : masterPassword), salt, params);
    const vault = decrypt(key, payload.cipher);
    if (!vault) {
      wipe(key);
      throw new Error('主密码错误');
    }
    this.key = key;
    this.data = this.normalizeVault(vault);
    this.lastSalt = salt;
    return true;
  }

  /** 用外部提供的密钥直接解锁（生物识别场景） */
  unlockWithKey(key) {
    const payload = this.store.readVault();
    if (!payload) throw new Error('密码库不存在或已损坏');
    const vault = decrypt(key, payload.cipher);
    if (!vault) throw new Error('密钥无效');
    this.key = Buffer.from(key);
    this.data = this.normalizeVault(vault);
    return true;
  }

  normalizeVault(vault) {
    const out = emptyVault();
    out.folders = normalizeOrder(Array.isArray(vault.folders) ? vault.folders : []);
    out.entries = Array.isArray(vault.entries) ? vault.entries : [];
    return out;
  }

  lock() {
    if (this.key) wipe(this.key);
    this.key = null;
    this.data = null;
  }

  persist(key, salt, vault, params = KDF_PARAMS) {
    const payload = {
      format: 'keynest-vault',
      version: 1,
      updatedAt: now(),
      kdf: {
        name: params.name,
        N: params.N,
        r: params.r,
        p: params.p,
        salt: salt.toString('base64'),
      },
      cipher: encrypt(key, vault),
    };
    this.store.writeVault(payload);
  }

  save() {
    if (!this.isUnlocked) throw new Error('密码库未解锁');
    const payload = this.store.readVault();
    const salt = Buffer.from(payload.kdf.salt, 'base64');
    this.persist(this.key, salt, this.data);
  }

  /** 修改主密码：用旧密钥解出的数据，用新密码重新加密 */
  changeMasterPassword(nextPassword) {
    if (!this.isUnlocked) throw new Error('密码库未解锁');
    if (typeof nextPassword !== 'string' || nextPassword.length < 6) {
      throw new Error('主密码至少需要 6 个字符');
    }
    const salt = newSalt();
    const key = deriveKey(nextPassword, salt);
    this.persist(key, salt, this.data);
    if (this.key) wipe(this.key);
    this.key = key;
    return true;
  }

  /** 当前主密钥（仅用于生物识别登记，调用方不得持久化明文） */
  getKey() {
    if (!this.isUnlocked) throw new Error('密码库未解锁');
    return this.key;
  }

  snapshot() {
    if (!this.isUnlocked) throw new Error('密码库未解锁');
    return { folders: this.data.folders, entries: this.data.entries };
  }

  // ---------------- 目录 ----------------

  createFolder(name, parentId = null) {
    const clean = str(name, MAX_NAME).trim();
    if (!clean) throw new Error('目录名称不能为空');
    if (parentId) {
      const parent = this.data.folders.find((f) => f.id === parentId);
      if (!parent) throw new Error('上级目录不存在');
    }
    const folder = {
      id: makeId(),
      name: clean,
      parentId: parentId || null,
      order: this.nextOrder(parentId),
      createdAt: now(),
    };
    this.data.folders.push(folder);
    this.save();
    return folder;
  }

  /**
   * 调整目录顺序：把 id 放到 targetId 之前或之后。
   * 只允许在同一父级内调整，避免拖动时误改层级。
   */
  reorderFolder(id, targetId, position = 'before') {
    const folder = this.data.folders.find((f) => f.id === id);
    if (!folder) throw new Error('目录不存在');
    const target = this.data.folders.find((f) => f.id === targetId);
    if (!target) throw new Error('目标目录不存在');
    if (folder.id === target.id) return folder;
    if (parentOf(folder) !== parentOf(target)) {
      throw new Error('只能在同级目录之间调整顺序');
    }

    const siblings = this.data.folders
      .filter((f) => parentOf(f) === parentOf(folder))
      .sort(compareSiblings);
    const rest = siblings.filter((f) => f.id !== folder.id);
    let index = rest.findIndex((f) => f.id === target.id);
    if (index < 0) return folder;
    if (position === 'after') index += 1;
    rest.splice(index, 0, folder);
    rest.forEach((item, i) => {
      item.order = i;
    });

    this.save();
    return folder;
  }

  /** 把目录上移/下移一格（用于右键菜单，与拖动等价） */
  nudgeFolder(id, delta) {
    const folder = this.data.folders.find((f) => f.id === id);
    if (!folder) throw new Error('目录不存在');
    const siblings = this.data.folders
      .filter((f) => parentOf(f) === parentOf(folder))
      .sort(compareSiblings);
    const from = siblings.findIndex((f) => f.id === id);
    const to = from + (delta < 0 ? -1 : 1);
    if (from < 0 || to < 0 || to >= siblings.length) return folder;

    const [moved] = siblings.splice(from, 1);
    siblings.splice(to, 0, moved);
    siblings.forEach((item, i) => {
      item.order = i;
    });

    this.save();
    return moved;
  }

  /** 该目录及其所有子孙目录的 id */
  subtreeIds(id) {
    const ids = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of this.data.folders) {
        if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
          ids.add(f.id);
          grew = true;
        }
      }
    }
    return ids;
  }

  /** 某个父级下追加到末尾时应使用的 order */
  nextOrder(parentId) {
    return (
      this.data.folders
        .filter((f) => parentOf(f) === (parentId || null))
        .reduce((max, f) => Math.max(max, Number.isFinite(f.order) ? f.order : -1), -1) + 1
    );
  }

  /**
   * 把目录移动到另一个目录下（parentId 为 null 表示移到顶层）。
   * 连同其所有子目录一起移动，并排到新父级的末尾。
   */
  moveFolder(id, parentId = null) {
    const folder = this.data.folders.find((f) => f.id === id);
    if (!folder) throw new Error('目录不存在');
    const target = parentId || null;
    if (target) {
      if (!this.data.folders.some((f) => f.id === target)) throw new Error('目标目录不存在');
      if (this.subtreeIds(id).has(target)) throw new Error('不能移动到自身或子目录下');
    }
    if (parentOf(folder) === target) return folder;

    // 先算序号再改 parentId，否则会把自己算进目标父级的兄弟里
    const order = this.nextOrder(target);
    folder.parentId = target;
    folder.order = order;
    this.save();
    return folder;
  }

  renameFolder(id, name) {
    const clean = str(name, MAX_NAME).trim();
    if (!clean) throw new Error('目录名称不能为空');
    const folder = this.data.folders.find((f) => f.id === id);
    if (!folder) throw new Error('目录不存在');
    folder.name = clean;
    this.save();
    return folder;
  }

  /** 删除目录：连同所有子目录与其中条目一并删除 */
  deleteFolder(id) {
    const ids = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of this.data.folders) {
        if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
          ids.add(f.id);
          grew = true;
        }
      }
    }
    this.data.folders = this.data.folders.filter((f) => !ids.has(f.id));
    this.data.entries = this.data.entries.filter((e) => !ids.has(e.folderId));
    this.save();
    return [...ids];
  }

  // ---------------- 条目 ----------------

  sanitizeEntry(input) {
    const title = str(input.title, MAX_NAME).trim();
    if (!title) throw new Error('名称不能为空');
    return {
      title,
      username: str(input.username, 512),
      password: str(input.password, 4096),
      url: str(input.url, 2048),
      notes: str(input.notes, 8192),
    };
  }

  createEntry(input) {
    const folderId = input.folderId || null;
    if (folderId && !this.data.folders.some((f) => f.id === folderId)) {
      throw new Error('目录不存在');
    }
    const fields = this.sanitizeEntry(input);
    const entry = {
      id: makeId(),
      folderId,
      ...fields,
      createdAt: now(),
      updatedAt: now(),
    };
    this.data.entries.push(entry);
    this.save();
    return entry;
  }

  updateEntry(id, input) {
    const entry = this.data.entries.find((e) => e.id === id);
    if (!entry) throw new Error('条目不存在');
    const fields = this.sanitizeEntry({ ...entry, ...input });
    Object.assign(entry, fields, { updatedAt: now() });
    if (input.folderId !== undefined) {
      const folderId = input.folderId || null;
      if (folderId && !this.data.folders.some((f) => f.id === folderId)) {
        throw new Error('目录不存在');
      }
      entry.folderId = folderId;
    }
    this.save();
    return entry;
  }

  deleteEntry(id) {
    const before = this.data.entries.length;
    this.data.entries = this.data.entries.filter((e) => e.id !== id);
    if (this.data.entries.length === before) throw new Error('条目不存在');
    this.save();
    return true;
  }
}

module.exports = { VaultSession };
