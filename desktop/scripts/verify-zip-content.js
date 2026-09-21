'use strict';

/**
 * 交付包最终确认：zip 里的 asar 是否含本轮改动。
 *
 * 为什么单独做这一步：`verify:zip` 验的是「解压后能启动、能找到 harness」，
 * 但没有验「解压出来的那份代码是新的」。这两件事是独立的 ——
 * 完全可能打包流程正常、却因为打包时机早于改代码而交付了旧渲染层
 * （本轮就踩过一次）。所以交付前专门确认一次包内内容。
 *
 * 做法：从 zip 里直接流式读取 asar 的头部，定位并提取目标文件。
 * 更简单的等价做法是解压后检查，但那样要落 110MB 到磁盘；
 * 这里只读需要的那部分。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ZIP = path.join(ROOT, 'dist', 'VRH-desktop-0.1.0-portable.zip');
const TAR = 'C:\\Windows\\System32\\tar.exe';

// 本轮改动的文件 + 必须存在的特征串。
const EXPECT = [
  { file: 'src/renderer/renderer.js', marks: ['SLOT_LABELS', '主体', '有意为之', '生成模型'] },
  { file: 'src/renderer/styles.css', marks: ['shot-lang-note'] },
];

function fail(message) {
  console.log(`FAIL  ${message}`);
  process.exitCode = 1;
}

(function main() {
  if (!fs.existsSync(ZIP)) {
    fail(`交付包不存在：${ZIP}`);
    return;
  }

  // zip 用 bsdtar 解到内存（只取 asar 一个条目）。
  // 条目名带前导 `./`（tar 的惯例），所以写成 `./resources/app.asar`；
  // 少这个前缀会因为找不到条目而报「Not found in archive」。
  const entry = './resources/app.asar';
  let asarBuf;
  try {
    asarBuf = execFileSync(TAR, ['-xOf', ZIP, entry], {
      maxBuffer: 1024 * 1024 * 512,
    });
  } catch (error) {
    fail(`从 zip 读取 ${entry} 失败：${(error.message || '').slice(0, 160)}`);
    return;
  }
  console.log(`已从交付包读出 asar：${(asarBuf.length / 1024 / 1024).toFixed(1)} MB`);

  /*
   * asar 是「头部 JSON + 拼接的文件体」格式。头部前 16 字节含
   * 4 字节 uint32（头部 pickle 大小）等，真实的 JSON 长度在其内部。
   * 这里不重复实现解析器，直接落地成临时文件交给 @electron/asar 读 ——
   * 它已在 devDependencies 里，且解析正确性有保证。
   */
  const tmpAsar = path.join(require('os').tmpdir(), `vrh-verify-${Date.now()}.asar`);
  fs.writeFileSync(tmpAsar, asarBuf);

  let bad = 0;
  try {
    const asar = require('@electron/asar');
    for (const { file, marks } of EXPECT) {
      let text;
      try {
        text = asar.extractFile(tmpAsar, path.join(...file.split('/'))).toString('utf8');
      } catch (error) {
        fail(`${file} 读取失败：${error.message}`);
        bad += 1;
        continue;
      }
      const missing = marks.filter((m) => !text.includes(m));
      if (missing.length) {
        fail(`${file} 缺少特征串：${missing.join('、')}`);
        bad += 1;
      } else {
        console.log(`OK    ${file} 含全部特征串`);
      }
    }
  } finally {
    try { fs.unlinkSync(tmpAsar); } catch { /* 尽力而为 */ }
  }

  console.log('');
  if (bad === 0) {
    console.log('交付包内容正确 —— 本轮改动已进入用户拿到手的那份代码');
  } else {
    console.log(`${bad} 个文件不符 —— 需要重新打包并重做交付包`);
    process.exitCode = 1;
  }
})();
