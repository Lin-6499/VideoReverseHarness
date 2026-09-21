'use strict';

/**
 * 「harness 放置说明」的唯一来源。
 *
 * 为什么抽成独立模块：这份说明会被**两个地方**用到 ——
 *   1. 打包时（scripts/make-zip.js）写进便携目录，随 zip 一起分发
 *   2. 运行时（src/main/main.js）在找不到 harness 时直接打开给用户看
 * 两处各写一份必然漂移，所以正文与文件名都收在这里。
 *
 * ── 编码（重要）────────────────────────────────────────────────
 * 写 **UTF-8 带 BOM**，不是裸 UTF-8。
 *
 * 原因：Windows 记事本对「无 BOM 的 UTF-8」按本机 ANSI 代码页解释，中文会显示成
 * 乱码。这是我们最不希望出问题的一份文件 —— 用户正是在「程序用不了」的时候
 * 才打开它，看到乱码就彻底失去线索了。带 BOM 的 UTF-8 在记事本、VS Code、
 * 写字板里都能正确识别，且不依赖非 ASCII 代码页。
 *
 * 早先尝试用 GBK：Node 没有内置 GBK 编码器，要自己带码表，代价远大于收益，
 * 而且非简中系统反而会乱码。BOM 是更稳的默认值。
 */

const fs = require('fs');
const path = require('path');

/** 说明文件的文件名。打包与运行时都引用这里，避免两处写不一致。 */
const NOTICE_FILENAME = '请先阅读 - harness 放置说明.txt';

/**
 * 生成说明正文。
 *
 * @param {object} [options]
 * @param {string} [options.programDir] 程序所在目录（运行时已知，打包时未知）
 * @returns {string}
 */
function buildNoticeText(options = {}) {
  const { programDir } = options;
  const lines = [
    'VRH 视频反推 — 桌面端',
    '='.repeat(40),
    '',
    '这个程序只是 harness 的图形界面，自身不含 Python 环境。',
    '首次使用前，需要让程序找到 harness 文件夹。',
    '',
    'harness 文件夹指的是里面有 src、.venv、tools 的那个文件夹。',
    '',
    '三种办法，任选其一：',
    '',
    '  1. 把 harness 文件夹复制到本程序所在目录，改名为 harness',
    '     复制好之后目录结构应该长这样：',
    '',
    '       VRH 视频反推.exe',
    '       harness\\',
    '         src\\',
    '         .venv\\',
    '         tools\\',
    '',
  ];

  if (programDir) {
    lines.push(`     本程序所在目录：${programDir}`, '');
  }

  lines.push(
    '  2. 启动程序后，点环境提示条里的「手动指定」，选中 harness 文件夹本身',
    '     （程序会记住这个位置，下次不用再选）',
    '',
    '  3. 设置环境变量 VRH_ROOT 为 harness 文件夹的完整路径，然后重启程序',
    '',
    '-'.repeat(40),
    '',
    '注意：harness 需要先初始化过环境（.venv 里装好依赖、tools 里有 ffmpeg）。',
    '如果你拿到的 harness 是刚下载的压缩包，请先在它目录里运行：',
    '',
    '   python scripts/setup.py',
    '   python scripts/get_ffmpeg.py',
    '',
    '如果程序启动后仍提示找不到 harness，可以点程序里的「重新探测」，',
    '或关掉程序重新打开一次。',
    '',
  );

  return lines.join('\r\n');
}

/**
 * 把说明写到指定目录（文件名固定）。
 *
 * @param {string} dir 目标目录
 * @param {object} [options] 同 buildNoticeText
 * @returns {string} 写入的文件完整路径
 */
function writeNotice(dir, options = {}) {
  const target = path.join(dir, NOTICE_FILENAME);
  // U+FEFF 作为 BOM 前缀 —— 记事本据此判定为 UTF-8。
  fs.writeFileSync(target, `\uFEFF${buildNoticeText(options)}`, 'utf8');
  return target;
}

/**
 * 在若干候选目录里找到已存在的说明文件。
 *
 * 运行时用：优先程序目录（用户复制过来的那份），其次工作目录。
 * 找不到返回 null —— 调用方应退回到「用内置文案弹窗」，而不是报错。
 *
 * @param {string[]} dirs
 * @returns {string|null}
 */
function findNotice(dirs) {
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, NOTICE_FILENAME);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* 忽略权限等问题 */ }
  }
  return null;
}

module.exports = { NOTICE_FILENAME, buildNoticeText, writeNotice, findNotice };
