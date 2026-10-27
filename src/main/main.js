'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  clipboard,
  safeStorage,
  Menu,
  powerMonitor,
  session: electronSession,
} = require('electron');
const path = require('node:path');

const { VaultStore } = require('./store');
const { VaultSession } = require('./vault');
const appSettings = require('./settings');
const hello = require('./hello');

const AUTO_LOCK_MS = 10 * 60 * 1000; // 闲置 10 分钟自动锁定

let win = null;
let store = null;
let session = null;
let lockTimer = null;
let clipboardTimer = null;
let clipboardDeadline = 0;
let lastCopiedAt = 0;
let cachedHello = { available: false, reason: '检测中' };
let helloReady = null;
let lastCopied = '';
let settings = { ...appSettings.DEFAULTS };

const isDev = process.argv.includes('--dev');

app.setName('Keynest');
app.setAppUserModelId('com.keynest.app');

// ── 离线加固（必须在 ready 之前设置）────────────────────────────
// 本应用完全离线：不加载任何远程资源，也不发起任何外部请求。
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('no-pings');
app.commandLine.appendSwitch(
  'disable-features',
  'NetworkTimeServiceQuerying,OptimizationHints,Translate,MediaRouter'
);
// 兜底：即便有内部组件绕过请求拦截，也无法解析任何域名
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');

/** 运行期再拦一层：任何 http(s)/ws(s)/ftp 请求一律取消 */
const NETWORK_URL_FILTER = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'];

function lockdownSession(target) {
  target.webRequest.onBeforeRequest({ urls: NETWORK_URL_FILTER }, (details, callback) => {
    console.warn('[离线] 已拦截外部请求：', details.url);
    callback({ cancel: true });
  });
  // 摄像头、麦克风、定位、通知等一律不授权
  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
  target.setSpellCheckerEnabled(false);
}

// 单实例：已经有 Keynest 在运行时，本次启动直接退出，
// 由已运行的实例把窗口唤到前台。这里必须 return，
// 否则下面的 whenReady 仍会建出一个随退出一起销毁的窗口，
// 表现为「任务管理器有进程，但看不到窗口」。
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
  return;
}

/** 支持便携模式：用 KEYNEST_DATA_DIR 指定密码库存放目录 */
function resolveDataDir() {
  const custom = (process.env.KEYNEST_DATA_DIR || '').trim();
  return custom ? path.resolve(custom) : app.getPath('userData');
}

/** 窗口底色需与界面主题一致，避免启动/缩放时闪白或闪黑 */
const THEME_BG = { dark: '#0b0d10', light: '#f4f6f9' };
function themeBackground(theme) {
  return THEME_BG[theme] || THEME_BG.dark;
}

/** 标题栏叠加层（Windows 原生窗口按钮）也要跟随主题，否则浅色下会留一条黑底 */
const TITLEBAR_HEIGHT = 44;
const THEME_CHROME = {
  dark: { color: '#0b0d10', symbolColor: '#7d8593' },
  light: { color: '#f4f6f9', symbolColor: '#5c6572' },
};
function chromeFor(theme) {
  return { ...(THEME_CHROME[theme] || THEME_CHROME.dark), height: TITLEBAR_HEIGHT };
}

function applyThemeChrome(theme) {
  if (!win || win.isDestroyed()) return;
  win.setBackgroundColor(themeBackground(theme));
  if (process.platform === 'win32') {
    try {
      win.setTitleBarOverlay(chromeFor(theme));
    } catch {
      /* 旧版本 Windows 不支持时忽略，退回默认表现 */
    }
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: themeBackground(settings.theme),
    title: 'Keynest',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    titleBarStyle: 'hidden',
    titleBarOverlay: chromeFor(settings.theme),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: isDev,
    },
  });

  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), {
    query: { theme: settings.theme },
  });

  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  win.on('closed', () => {
    win = null;
  });
}

// ---------------- 自动锁定 ----------------

function resetLockTimer() {
  if (lockTimer) clearTimeout(lockTimer);
  if (!session || !session.isUnlocked) return;
  lockTimer = setTimeout(() => lockVault('idle'), AUTO_LOCK_MS);
}

function lockVault(reason = 'manual') {
  if (!session) return;
  session.lock();
  if (lockTimer) clearTimeout(lockTimer);
  lockTimer = null;
  clearClipboard(true);
  if (win && !win.isDestroyed()) win.webContents.send('vault:locked', { reason });
}

function clearClipboard(force = false) {
  if (clipboardTimer) {
    clearTimeout(clipboardTimer);
    clipboardTimer = null;
  }
  if (force && lastCopied && clipboard.readText() === lastCopied) clipboard.clear();
  lastCopied = '';
  clipboardDeadline = 0;
}

/** 按当前设置的秒数安排一次剪贴板清除 */
function scheduleClipboardClear(seconds) {
  if (clipboardTimer) {
    clearTimeout(clipboardTimer);
    clipboardTimer = null;
  }
  if (!lastCopied || !(seconds > 0)) return;
  lastCopiedAt = Date.now();
  clipboardDeadline = lastCopiedAt + seconds * 1000;
  clipboardTimer = setTimeout(() => {
    clipboardTimer = null;
    clipboardDeadline = 0;
    if (lastCopied && clipboard.readText() === lastCopied) clipboard.clear();
    lastCopied = '';
  }, seconds * 1000);
}

/** 设置变更后，让正在进行中的计时按新值重新计算 */
function rescheduleClipboardClear() {
  if (!clipboardTimer || !lastCopied) return;
  const elapsed = Date.now() - lastCopiedAt;
  const remaining = settings.clipboardClearSeconds * 1000 - elapsed;
  if (remaining <= 0) {
    clearClipboard(true);
    return;
  }
  scheduleClipboardClear(remaining / 1000);
}

// ---------------- 生物识别 ----------------

function biometricEnabled() {
  return Boolean(store.readBiometric());
}

function enableBiometric() {
  if (!session.isUnlocked) throw new Error('请先解锁密码库');
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统的安全存储不可用，无法启用生物识别');
  }
  const wrapped = safeStorage.encryptString(session.getKey().toString('base64')).toString('base64');
  store.writeBiometric({ version: 1, wrapped, createdAt: new Date().toISOString() });
}

function disableBiometric() {
  store.clearBiometric();
}

// ---------------- IPC ----------------

function ok(data) {
  resetLockTimer();
  return { ok: true, data };
}

function fail(err) {
  return { ok: false, error: err && err.message ? err.message : String(err) };
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return ok(await fn(...args));
    } catch (err) {
      return fail(err);
    }
  });
}

function requireUnlocked() {
  if (!session.isUnlocked) throw new Error('密码库已锁定');
}

function registerIpc() {
  handle('vault:status', async () => {
    if (helloReady) await helloReady;
    const availability = cachedHello;
    return {
      initialized: session.isInitialized(),
      unlocked: session.isUnlocked,
      biometricEnabled: biometricEnabled(),
      biometricAvailable: availability.available,
      biometricReason: availability.reason,
      platform: process.platform,
    };
  });

  handle('vault:create', async (password) => {
    session.create(password);
    resetLockTimer();
    return { initialized: true };
  });

  handle('vault:unlock', async (password) => {
    session.unlock(password);
    resetLockTimer();
    return true;
  });

  handle('vault:unlock-biometric', async () => {
    const record = store.readBiometric();
    if (!record) throw new Error('尚未启用生物识别解锁');
    if (!cachedHello.available) throw new Error(cachedHello.reason || '生物识别不可用');
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
    }
    const passed = await hello.verify('解锁 Keynest 密码库');
    if (!passed) throw new Error('身份验证未通过');
    const keyB64 = safeStorage.decryptString(Buffer.from(record.wrapped, 'base64'));
    session.unlockWithKey(Buffer.from(keyB64, 'base64'));
    resetLockTimer();
    return true;
  });

  handle('vault:lock', async () => {
    lockVault('manual');
    return true;
  });

  handle('vault:touch', async () => true);

  handle('vault:biometric', async (enabled) => {
    requireUnlocked();
    if (enabled) {
      const availability = await hello.checkAvailability();
      cachedHello = availability;
      if (!availability.available) throw new Error(availability.reason || '生物识别不可用');
      enableBiometric();
    } else {
      disableBiometric();
    }
    return { biometricEnabled: biometricEnabled() };
  });

  handle('vault:change-password', async ({ current, next }) => {
    requireUnlocked();
    session.unlock(current); // 先校验旧密码
    session.changeMasterPassword(next);
    if (biometricEnabled()) enableBiometric(); // 主密钥变了，同步刷新
    return true;
  });

  handle('data:snapshot', async () => {
    requireUnlocked();
    return session.snapshot();
  });

  handle('folder:create', async ({ name, parentId }) => {
    requireUnlocked();
    return session.createFolder(name, parentId);
  });

  handle('folder:rename', async ({ id, name }) => {
    requireUnlocked();
    return session.renameFolder(id, name);
  });

  handle('folder:reorder', async ({ id, targetId, position }) => {
    requireUnlocked();
    return session.reorderFolder(id, targetId, position === 'after' ? 'after' : 'before');
  });

  handle('folder:move', async ({ id, parentId }) => {
    requireUnlocked();
    return session.moveFolder(id, parentId || null);
  });

  handle('folder:nudge', async ({ id, delta }) => {
    requireUnlocked();
    return session.nudgeFolder(id, Number(delta) < 0 ? -1 : 1);
  });

  handle('folder:delete', async ({ id }) => {
    requireUnlocked();
    return session.deleteFolder(id);
  });

  handle('entry:create', async (input) => {
    requireUnlocked();
    return session.createEntry(input || {});
  });

  handle('entry:update', async ({ id, patch }) => {
    requireUnlocked();
    return session.updateEntry(id, patch || {});
  });

  handle('entry:delete', async ({ id }) => {
    requireUnlocked();
    return session.deleteEntry(id);
  });

  handle('clipboard:write', async ({ value, secret }) => {
    requireUnlocked();
    const text = String(value == null ? '' : value);
    if (clipboardTimer) {
      clearTimeout(clipboardTimer);
      clipboardTimer = null;
    }
    clipboard.writeText(text);
    // 非敏感内容覆盖剪贴板后，之前密码的清除计时也就失去意义
    lastCopied = secret ? text : '';
    if (secret) scheduleClipboardClear(settings.clipboardClearSeconds);
    return { clearSeconds: secret ? settings.clipboardClearSeconds : 0 };
  });

  handle('settings:get', async () => ({
    ...settings,
    limits: appSettings.LIMITS,
  }));

  handle('settings:update', async (patch) => {
    const next = appSettings.applyPatch(settings, patch || {});
    settings = next;
    store.writeSettings(settings);
    if (patch && patch.theme) applyThemeChrome(settings.theme);
    rescheduleClipboardClear();
    return { ...settings, limits: appSettings.LIMITS };
  });
}

// ---------------- 生命周期 ----------------

app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.moveTop();
  win.focus();
});

app.whenReady().then(async () => {
  store = new VaultStore(resolveDataDir());
  store.ensureDir();
  settings = appSettings.normalize(store.readSettings());
  session = new VaultSession(store);
  registerIpc();

  lockdownSession(electronSession.defaultSession);

  helloReady = hello.checkAvailability().then((result) => {
    cachedHello = result;
    return result;
  });

  createWindow();

  powerMonitor.on('suspend', () => lockVault('suspend'));
  powerMonitor.on('lock-screen', () => lockVault('screen-lock'));
});

app.on('window-all-closed', () => {
  if (session) session.lock();
  app.quit();
});

app.on('before-quit', () => {
  if (session) session.lock();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
