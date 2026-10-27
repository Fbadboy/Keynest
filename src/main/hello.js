'use strict';

/**
 * Windows Hello（系统生物识别）桥接
 * 通过 WinRT UserConsentVerifier 调起系统级的指纹 / 人脸 / PIN 验证。
 * 非 Windows 或系统未配置时自动降级为「不可用」。
 */

const { execFile } = require('node:child_process');
const path = require('node:path');

// 打包后脚本位于 app.asar.unpacked（asar 内的文件 PowerShell 读不到）
const SCRIPT = path
  .join(__dirname, 'scripts', 'hello.ps1')
  .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

function runScript(args, timeout) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('当前系统不支持 Windows Hello'));
      return;
    }
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args],
      { timeout, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        const out = String(stdout || '').trim();
        if (out.startsWith('ERROR:')) {
          reject(new Error(out.slice(6) || 'Windows Hello 调用失败'));
          return;
        }
        if (err && !out) {
          reject(new Error(err.message || 'Windows Hello 调用失败'));
          return;
        }
        resolve(out);
      }
    );
  });
}

/** @returns {Promise<{available:boolean, reason:string}>} */
async function checkAvailability() {
  try {
    const out = await runScript(['-Mode', 'check'], 20000);
    const value = out.replace(/^AVAIL:/, '');
    const map = {
      Available: { available: true, reason: '' },
      DeviceNotPresent: { available: false, reason: '未检测到生物识别设备' },
      DeviceBusy: { available: false, reason: '设备忙，请稍后再试' },
      DisabledByPolicy: { available: false, reason: '已被系统策略禁用' },
      NotConfiguredForUser: { available: false, reason: '系统尚未配置 Windows Hello' },
    };
    return map[value] || { available: false, reason: 'Windows Hello 不可用' };
  } catch (err) {
    return { available: false, reason: err.message };
  }
}

/** 调起系统验证，返回是否通过 */
async function verify(message) {
  const out = await runScript(['-Mode', 'verify', '-Message', message], 120000);
  const value = out.replace(/^RESULT:/, '');
  return value === 'Verified';
}

module.exports = { checkAvailability, verify };
