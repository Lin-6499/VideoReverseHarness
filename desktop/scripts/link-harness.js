'use strict';

/**
 * 在便携版目录里创建/移除指向 harness 的目录联接（junction）。
 *
 * 为什么用 junction 而不是复制：harness 含 .venv 与便携 ffmpeg，1GB+，
 * 复制既慢又占空间。junction 是 Windows 的目录映射，程序读起来与真实目录
 * 无异 —— 正好用于「验证 exe 能否在同级找到 harness」。
 *
 * 注意：删除 junction 必须用 rmdir（不带 /S）。用 Remove-Item -Recurse 或
 * rm -rf 会穿透联接把目标目录（真实的 harness）删掉。
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const UNPACKED = path.resolve(__dirname, '..', 'dist', 'win-unpacked');
const LINK = path.join(UNPACKED, 'harness');
const TARGET = process.env.VRH_LINK_TARGET || 'D:\\HarnessTest';

const action = process.argv[2] || 'status';

function status() {
  const exists = fs.existsSync(LINK);
  console.log(`联接路径：${LINK}`);
  console.log(`目标    ：${TARGET}`);
  console.log(`状态    ：${exists ? '已存在' : '不存在'}`);
  return exists;
}

function create() {
  if (fs.existsSync(LINK)) {
    console.log('联接已存在，先移除…');
    remove();
  }
  // 参数用数组传，避免 shell 对反斜杠做二次转义。
  execFileSync('cmd', ['/c', 'mklink', '/J', LINK, TARGET], { stdio: 'inherit' });
  console.log(`\n已创建联接：${LINK} → ${TARGET}`);
  console.log(`校验 cli.py 可达：${fs.existsSync(path.join(LINK, 'src', 'vrh', 'cli.py'))}`);
}

function remove() {
  if (!fs.existsSync(LINK)) {
    console.log('联接不存在，无需移除');
    return;
  }
  // 用 cmd 的 rmdir（不带 /S）：只删联接本身，不碰目标。
  execFileSync('cmd', ['/c', 'rmdir', LINK], { stdio: 'inherit' });
  console.log(`已移除联接：${LINK}`);
  console.log(`目标目录仍完好：${fs.existsSync(TARGET)}`);
}

switch (action) {
  case 'create': create(); break;
  case 'remove': remove(); break;
  case 'status': status(); break;
  default:
    console.error(`未知动作：${action}（可选 create / remove / status）`);
    process.exit(1);
}
