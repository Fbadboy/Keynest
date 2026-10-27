'use strict';

/**
 * 应用设置（明文，不含敏感信息）
 * 与密码库分离存放，保证解锁前也能读取。
 */

const DEFAULTS = Object.freeze({
  clipboardClearSeconds: 30,
  theme: 'dark',
});

const THEMES = Object.freeze(['dark', 'light']);

const LIMITS = Object.freeze({
  clipboardClearSeconds: Object.freeze({ min: 5, max: 3600 }),
});

/** 合法则返回整数秒，否则返回 null */
function coerceSeconds(value) {
  if (value === '' || value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const rounded = Math.round(num);
  const { min, max } = LIMITS.clipboardClearSeconds;
  if (rounded < min || rounded > max) return null;
  return rounded;
}

/** 把磁盘上的任意内容收敛成合法设置 */
function normalize(raw) {
  const settings = { ...DEFAULTS };
  const seconds = coerceSeconds(raw && raw.clipboardClearSeconds);
  if (seconds !== null) settings.clipboardClearSeconds = seconds;
  if (raw && THEMES.includes(raw.theme)) settings.theme = raw.theme;
  return settings;
}

/** 应用局部更新，非法值抛出可读错误 */
function applyPatch(current, patch) {
  const next = { ...normalize(current) };
  if (patch && patch.clipboardClearSeconds !== undefined) {
    const seconds = coerceSeconds(patch.clipboardClearSeconds);
    if (seconds === null) {
      const { min, max } = LIMITS.clipboardClearSeconds;
      throw new Error(`自动清除时间需在 ${min}–${max} 秒之间`);
    }
    next.clipboardClearSeconds = seconds;
  }
  if (patch && patch.theme !== undefined) {
    if (!THEMES.includes(patch.theme)) throw new Error('主题值无效');
    next.theme = patch.theme;
  }
  return next;
}

module.exports = { DEFAULTS, LIMITS, THEMES, normalize, applyPatch };
