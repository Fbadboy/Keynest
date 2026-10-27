'use strict';

/**
 * 启动器
 * 某些环境（如被注入的终端）会带上 ELECTRON_RUN_AS_NODE=1，
 * 导致 electron 以纯 Node 模式执行主进程而崩溃。这里显式剔除后再拉起。
 */

const { spawn } = require('node:child_process');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  windowsHide: false,
});

child.on('close', (code) => process.exit(code == null ? 0 : code));
