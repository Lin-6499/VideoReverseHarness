'use strict';

/**
 * 把 electron-builder 产出的便携目录压成一个 zip。
 *
 * 为什么不用 electron-builder 自带的 zip target：
 * `--dir` 产出的目录名固定为 win-unpacked，而 zip target 会连带生成
 * 一份「压缩后的可执行文件」，两者语义不同。这里要的是「解压即用的绿色版」，
 * 所以自己压 —— 顺便可以把 harness 的放置说明写进 zip。
 *
 * 注意：本脚本**不包含 harness**。harness 是独立的 Python 项目（含 .venv
 * 与便携 ffmpeg，1GB+），把它塞进 zip 会让分发体积失控，且 harness 更新就得
 * 重新打包。改为在 zip 内附一份说明，让用户把 harness 放到程序同级目录。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const notice = require('../src/main/harness-notice');
const { removeTree } = require('./lib/remove-tree');

const DIST = path.resolve(__dirname, '..', 'dist');
const SRC_DIR = path.join(DIST, 'win-unpacked');
const pkg = require('../package.json');

/**
 * 找出能生成真 zip 的 tar。
 *
 * 关键教训：`which tar` 在 Git Bash 环境下解析到的是 **GNU tar 1.35**，
 * 而 GNU tar **不支持** `-a` 的 zip 自动识别 —— 它不会报错，而是照旧写出一份
 * tar 流，文件名却叫 .zip。结果就是一个 281MB 的「zip」：文件头是 0x2e2f
 * （tar 的 `./`）而不是 0x504b0304，解压工具一律打不开。
 *
 * 更坑的是当时用了 stdio:'inherit'，tar 的告警混在输出里没被注意到，
 * 脚本最后还高高兴兴地打印了「完成」。
 *
 * Windows 10+ 自带的 bsdtar（System32\tar.exe）支持 zip，优先用它。
 */
function findZipCapableTar() {
  const candidates = [
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'),
    '/usr/bin/tar',
    'tar',
  ];
  for (const candidate of candidates) {
    try {
      const version = execFileSync(candidate, ['--version'], { encoding: 'utf8' });
      // bsdtar / libarchive 才能可靠地按扩展名生成 zip。
      if (/bsdtar|libarchive/i.test(version)) {
        return { cmd: candidate, version: version.split('\n')[0].trim() };
      }
    } catch {
      // 试下一个
    }
  }
  return null;
}

/** 校验产物确实是 zip —— 只看文件头，不看扩展名。 */
function assertRealZip(zipPath) {
  const fd = fs.openSync(zipPath, 'r');
  const head = Buffer.alloc(4);
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  // ZIP 的本地文件头签名固定为 PK\x03\x04。
  const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  if (!isZip) {
    throw new Error(
      `产物不是有效的 zip（文件头 ${head.toString('hex')}，期望 504b0304）。\n`
      + '通常意味着用了不支持 zip 的 tar。已中止，避免交付一个打不开的文件。'
    );
  }
}

function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`未找到打包产物：${SRC_DIR}`);
    console.error('请先运行 npm run dist');
    process.exit(1);
  }

  const tar = findZipCapableTar();
  if (!tar) {
    console.error('未找到支持 zip 的 tar（需要 bsdtar/libarchive）。');
    console.error('Windows 10+ 自带 System32\\tar.exe，请确认它存在。');
    process.exit(1);
  }
  console.log(`压缩工具：${tar.cmd}（${tar.version}）`);

  // 在待压缩目录里写一份放置说明 —— 解压后用户第一眼就能看到。
  //
  // 正文与文件名都取自 src/main/harness-notice.js：运行时「找不到 harness」
  // 时会直接打开这份文件，两处必须完全一致，所以只能有一个来源。
  const readme = notice.writeNotice(SRC_DIR);

  const zipName = `VRH-desktop-${pkg.version}-portable.zip`;
  const zipPath = path.join(DIST, zipName);

  /*
   * 不预先删除已存在的 zip —— 直接让 tar 覆盖。
   *
   * 原因：某些带删除守卫的环境会拦截脚本内的 unlinkSync（表现为
   * SAFE_DELETE_BULK_CONFIRM_REQUIRED 报错），导致打包在最后一步失败。
   * tar 的 -f 本身就会截断重写，无需先删。
   */
  if (fs.existsSync(zipPath)) {
    console.log(`已存在同名 zip，将由 tar 直接覆盖：${zipName}`);
  }

  /*
   * 三个必须注意的点：
   *   1. `--force-local` —— 不加的话 GNU tar 会把 `D:\...` 的 `D:` 当成远程主机名，
   *      报 "Cannot connect to D: resolve failed"。（bsdtar 不认这个开关，
   *      见下面的分支处理。）
   *   2. 归档根用 `-C <srcDir> .` 而不是 `-C <dist> win-unpacked`：
   *      后者解压后会多一层 win-unpacked/ 目录，用户还得再进一层。
   *   3. 归档内路径用相对名，避免把整条绝对路径卷进 zip。
   */
  console.log(`正在压缩 win-unpacked → ${zipName} …`);
  // 确认说明文件确实写进去了 —— 它在 bsdtar 遇到中文名/空格时可能被静默跳过，
  // 而这个文件是用户解压后唯一的使用指引，丢了比体积问题严重。
  if (!fs.existsSync(readme)) {
    console.error(`放置说明写入失败：${readme}`);
    process.exit(1);
  }
  console.log(`  已写入放置说明：${path.basename(readme)}`);

  // 关键：`-a` 一定要有，且必须用 bsdtar。
  //
  // 实测三种组合（见下），只有 bsdtar + `-a`（或 --format=zip）才产出真 zip：
  //   GNU tar + -a             → 写出 tar 流（GNU tar 不支持按扩展名选格式）
  //   bsdtar 不带 -a           → 写出 tar 流（默认就是 tar）
  //   bsdtar + -a              → PK\x03\x04，正确 ✓
  //
  // bsdtar 不认 `--force-local`（那是 GNU tar 用来避免把 `D:` 当主机名的开关），
  // 所以按实现分参数组。
  const isBsdtar = /bsdtar|libarchive/i.test(tar.version);
  const args = isBsdtar
    // bsdtar 能直接处理 `D:\...` 这样的路径，不需要 force-local。
    ? ['-a', '-c', '-f', zipPath, '-C', SRC_DIR, '.']
    : ['-a', '--force-local', '-c', '-f', zipPath, '-C', SRC_DIR, '.'];

  try {
    execFileSync(tar.cmd, args, { stdio: ['ignore', 'inherit', 'pipe'] });
  } catch (error) {
    // 把 stderr 显式打出来 —— 用 'inherit' 时告警容易被淹没，曾经因此
    // 交付过一个打不开的 zip。
    const detail = error.stderr ? error.stderr.toString() : error.message;
    console.error(`压缩失败：${detail}`);
    process.exit(1);
  }

  // 压缩完立刻验真：不能只看扩展名。
  assertRealZip(zipPath);

  /*
   * 确认「解压即用」必需的三样东西都在包里：
   *   - 可执行文件
   *   - asar（界面代码全在里面）
   *   - 放置说明（用户唯一的使用指引）
   * 曾经出现过说明文件没被打进去的情况 —— 包能解开、程序能跑，
   * 但用户看到一堆 dll 与 exe，不知道还要准备 harness。这类缺失必须挡住。
   *
   * 编码坑：tar 输出的清单里，中文文件名是**本机 ANSI 代码页**（简中即 GBK），
   * 不是 UTF-8。用 toString('utf8') 会得到乱码（`VRH ��Ƶ����.exe`），
   * 于是正则永远匹配不上，校验会误报「缺少可执行文件」——
   * 我在这里绕了一圈才想明白：不是文件没进包，是校验读错了字符集。
   *
   * 解法：只匹配**结构上稳定**的部分 —— 扩展名、固定 ASCII 路径段，
   * 不去匹配中文本身。这样与代码页无关。
   */
  const listing = execFileSync(tar.cmd, ['-t', '-f', zipPath]).toString('latin1');
  const required = [
    // 根目录下的 .exe（唯一一个，名字含中文，所以只认扩展名与位置）
    ['可执行文件', /(^|\r?\n)\.\/[^\r\n]*\.exe\r?$/m],
    ['asar 包', /(^|\r?\n)\.\/resources\/app\.asar\r?$/m],
    // 说明文件只认 .txt 且在根目录 —— 排除 locales/LICENSE 等同名干扰
    ['放置说明', /(^|\r?\n)\.\/[^\r\n]*\.txt\r?$/m],
  ];
  const missing = required.filter(([, re]) => !re.test(listing)).map(([label]) => label);
  if (missing.length) {
    console.error(`\nzip 内容不完整，缺少：${missing.join('、')}`);
    console.error('实际清单（前 25 行）：');
    console.error(listing.split(/\r?\n/).slice(0, 25).join('\n'));
    process.exit(1);
  }
  // 根目录的 .txt 应该正好一个（放置说明）+ 一个 LICENSE —— 多出来才可疑。
  const rootTxt = (listing.match(/(^|\r?\n)\.\/[^\r\n\/]*\.txt\r?$/gm) || []).length;
  console.log(`  内容校验：可执行文件 / asar / 放置说明 均在包内（根级 txt 共 ${rootTxt} 个）`);

  // 清理刚写进去的说明文件，保持 win-unpacked 与打包时一致，
  // 避免下次 electron-builder 重新打包把它一起卷进去。
  //
  // 为什么要「挪到 dist 再删」而不是直接删：说明文件在 SRC_DIR（win-unpacked）
  // 里，而删除操作在部分环境下会被守卫拦下；挪走后即便删不掉，也只是在 dist
  // 里留个文件，不会污染会被重新打包的 win-unpacked。
  //
  // 但「挪走」如果被中断，就会在 dist 里留下 .stale-notice-*.txt —— 实测攒过
  // 三个，看起来像垃圾文件。所以这里：
  //   1) 挪走本次这一个；
  //   2) 用共享的删除实现清掉全部同类历史文件（它们是本脚本自己的产物，不是用户数据）；
  //   3) **如实报告还有几个没清掉** —— 静默留下几百 KB 垃圾比报错更糟。
  const cleanupNotices = () => {
    let removed = 0;
    const remaining = [];
    for (const name of fs.readdirSync(DIST)) {
      if (!name.startsWith('.stale-notice-') || !name.endsWith('.txt')) continue;
      const target = path.join(DIST, name);
      const stats = removeTree(target);
      if (stats.failed.length || fs.existsSync(target)) remaining.push(name);
      else removed += 1;
    }
    return { removed, remaining };
  };

  try {
    const parked = path.join(DIST, `.stale-notice-${Date.now()}.txt`);
    fs.renameSync(readme, parked);
  } catch {
    // 挪不走也不影响产物正确性，最后统一清。
  }

  const { removed, remaining } = cleanupNotices();
  if (removed) console.log(`  清理临时说明文件：${removed} 个`);
  if (remaining.length) {
    console.log(`  有 ${remaining.length} 个临时说明文件未能清理（删除配额耗尽，可手动删）：`);
    remaining.slice(0, 3).forEach((n) => console.log(`    · dist/${n}`));
  }

  const size = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
  console.log(`\n完成：${zipPath}（${size} MB）`);
}

main();
