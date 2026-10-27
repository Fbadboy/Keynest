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
    vault.folders = DEFAULT_FOLDERS.map((name) => ({
      id: makeId(),
      name,
      parentId: null,
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
    out.folders = Array.isArray(vault.folders) ? vault.folders : [];
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
    const folder = { id: makeId(), name: clean, parentId: parentId || null, createdAt: now() };
    this.data.folders.push(folder);
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
