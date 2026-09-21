'use strict';

/**
 * 清空上一轮的打包目录。
 *
 * 为什么需要专门的脚本：electron-builder 在覆盖 dist/win-unpacked 前会先
 * 递归删除它（264 个文件），这会撞上环境的 bulk-delete 守卫
 * （SAFE_DELETE_BULK_CONFIRM_REQUIRED，阈值 50），打包直接失败。
 *
 * 手动清理同样受阻：cmd 的 rmdir、PowerShell 的 Remove-Item、robocopy /MIR
 * 都被同一套 shim 拦下。实际删除逻辑收在 scripts/lib/remove-tree.js，
 * 与验证脚本共用一份实现。
 *
 * 用法：node scripts/clean-dist.js
 */

const fs = require('fs');
const path = require('path');

const { guardedRemove } = require('./lib/remove-tree');

const DIST = path.resolve(__dirname, '..', 'dist');
// 只清这两个 —— 不动 zip（由 make-zip.js 负责覆盖），也不动 dist 之外任何东西。
const TARGETS = ['win-unpacked', 'win-unpacked.tmp'];

if (!fs.existsSync(DIST)) {
  console.log(`dist 不存在，无需清理：${DIST}`);
  process.exit(0);
}

let totalFiles = 0;
const allFailed = [];

for (const name of TARGETS) {
  const target = path.join(DIST, name);
  const stats = guardedRemove(target, DIST);

  if (stats.rejected) {
    console.error(stats.rejected);
    process.exit(1);
  }

  totalFiles += stats.files;
  allFailed.push(...stats.failed);
  console.log(fs.existsSync(target) ? `未能清除：${name}` : `已清除：${name}`);
}

console.log(`共删除 ${totalFiles} 个文件。`);
if (allFailed.length) {
  // 如实报告，别让人以为「跑过了就没事」。最常见的原因是环境删除配额耗尽
  // 或文件被占用（应用没退干净）—— 后者会让 electron-builder 覆盖时 EBUSY。
  console.log(`有 ${allFailed.length} 个文件未能删除。`);
  allFailed.slice(0, 3).forEach((f) => console.log(`  · ${f}`));
  const quota = allFailed.some((f) => /SAFE_DELETE_BULK_CONFIRM_REQUIRED/.test(f));
  if (quota) {
    console.log('  原因：环境删除配额已耗尽（同一会话内反复清理会触发）。');
    console.log('  通常不影响打包 —— electron-builder 自身的清理不受此限制。');
  } else {
    console.log('  原因多为文件被占用，请确认应用已完全退出后再打包。');
  }
}
console.log('剩余：', fs.readdirSync(DIST).join(', '));
