'use strict';

/**
 * 密码学核心
 * ---------------------------------------------------------------
 * 密钥派生：scrypt (N=2^15, r=8, p=1) → 32 字节密钥
 * 加密算法：AES-256-GCM（带认证，任何篡改都会导致解密失败）
 * 主密码本身永不落盘，仅用于派生密钥。
 */

const crypto = require('node:crypto');

const KDF_PARAMS = Object.freeze({
  name: 'scrypt',
  N: 1 << 15,
  r: 8,
  p: 1,
  keyLen: 32,
});

const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const AAD = Buffer.from('keynest-vault-v1', 'utf8');

function normalizePassword(password) {
  return String(password == null ? '' : password).normalize('NFKC');
}

/** 由主密码派生 32 字节主密钥 */
function deriveKey(password, salt, params = KDF_PARAMS) {
  if (!Buffer.isBuffer(salt) || salt.length < 8) {
    throw new Error('salt 无效');
  }
  return crypto.scryptSync(normalizePassword(password), salt, params.keyLen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 256 * 1024 * 1024,
  });
}

function newSalt() {
  return crypto.randomBytes(SALT_LEN);
}

/**
 * 加密任意可 JSON 序列化的对象
 * @returns {{iv:string, tag:string, data:string}}
 */
function encrypt(key, value) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  cipher.setAAD(AAD);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const out = {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
  plaintext.fill(0);
  return out;
}

/**
 * 解密；密钥错误或数据被篡改时返回 null（绝不抛明文异常）
 */
function decrypt(key, blob) {
  try {
    const iv = Buffer.from(blob.iv, 'base64');
    const tag = Buffer.from(blob.tag, 'base64');
    const data = Buffer.from(blob.data, 'base64');
    if (iv.length !== IV_LEN || tag.length !== TAG_LEN) return null;

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
    const value = JSON.parse(plaintext.toString('utf8'));
    plaintext.fill(0);
    return value;
  } catch {
    return null;
  }
}

/** 用零覆写内存中的密钥，降低密钥驻留时间 */
function wipe(buf) {
  if (Buffer.isBuffer(buf)) buf.fill(0);
}

module.exports = {
  KDF_PARAMS,
  deriveKey,
  newSalt,
  encrypt,
  decrypt,
  wipe,
  normalizePassword,
};
