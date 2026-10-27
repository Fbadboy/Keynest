'use strict';

/**
 * 磁盘存储层：只负责密文的读写，永远不接触明文密码库。
 */

const fs = require('node:fs');
const path = require('node:path');

const VAULT_FILE = 'vault.dat';
const BIO_FILE = 'biometric.dat';
const SETTINGS_FILE = 'settings.json';

class VaultStore {
  constructor(dir) {
    this.dir = dir;
    this.vaultFile = path.join(dir, VAULT_FILE);
    this.bioFile = path.join(dir, BIO_FILE);
    this.settingsFile = path.join(dir, SETTINGS_FILE);
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  vaultExists() {
    try {
      return fs.statSync(this.vaultFile).isFile();
    } catch {
      return false;
    }
  }

  readVault() {
    if (!this.vaultExists()) return null;
    try {
      const raw = fs.readFileSync(this.vaultFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.format !== 'keynest-vault') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** 原子写入：先写临时文件再重命名，避免断电产生半截文件 */
  writeAtomic(file, data) {
    this.ensureDir();
    const tmp = `${file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  }

  writeVault(payload) {
    this.writeAtomic(this.vaultFile, JSON.stringify(payload, null, 2));
  }

  readBiometric() {
    try {
      const raw = fs.readFileSync(this.bioFile, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed.wrapped === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  writeBiometric(payload) {
    this.writeAtomic(this.bioFile, JSON.stringify(payload, null, 2));
  }

  clearBiometric() {
    try {
      fs.unlinkSync(this.bioFile);
    } catch {
      /* 不存在即视为已清除 */
    }
  }

  /** 备份一份密文（用于导出/迁移） */
  backupTo(targetFile) {
    if (!this.vaultExists()) throw new Error('密码库不存在');
    fs.copyFileSync(this.vaultFile, targetFile);
  }

  readSettings() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  writeSettings(settings) {
    this.writeAtomic(this.settingsFile, JSON.stringify(settings, null, 2));
  }
}

module.exports = { VaultStore };
