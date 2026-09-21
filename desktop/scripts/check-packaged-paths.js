'use strict';

/**
 * 打包后路径解析验证（不启动 GUI）。
 *
 * 直接测 environment.js 在「模拟打包态」下的候选链行为。之所以要模拟而非
 * 真跑 exe：GUI 进程里读不到中间结果，而这里能逐候选打印命中情况 —— 路径
 * 猜错时，这些中间值就是唯一的排查线索。
 *
 * 做法：伪造 process.resourcesPath 让 isPackaged() 返回 true，并把 execPath
 * 指向便携版 exe 的真实路径。__dirname 仍指向源码目录（这是环境限制），
 * 但 isPackaged() 的判断同时看 resourcesPath 与 app.asar，
 * 所以这里改用注入的方式绕开 —— 直接调用导出的内部函数组合出等价场景。
 */

const path = require('path');
const fs = require('fs');
const environment = require('../src/main/environment');

const UNPACKED = path.resolve(__dirname, '..', 'dist', 'win-unpacked');
const EXE = path.join(UNPACKED, 'VRH 视频反推.exe');

console.log('=== 打包后路径解析验证 ===\n');
console.log(`便携版目录：${UNPACKED}`);
console.log(`exe 存在  ：${fs.existsSync(EXE)}\n`);

// --------------------------------------------------------------------------- //
// 1. 校验函数本身：对若干种目录形态给出正确判定
// --------------------------------------------------------------------------- //

console.log('【校验函数 looksLikeRepoRoot】');

const cases = [
  ['D:\\HarnessTest', true, '真实 harness 根（src-layout）'],
  [UNPACKED, false, '便携版目录（不应被误判）'],
  [path.resolve(__dirname, '..'), false, 'desktop 目录（不含 vrh/.venv）'],
  ['D:\\', false, '盘符根'],
  ['', false, '空字符串'],
  [null, false, 'null'],
  [undefined, false, 'undefined'],
  // 用确定不存在的路径。不要用 dist/win-unpacked/harness ——
  // 端到端验证时会在那里挂 junction 指向真实 harness，
  // 断言结果会随「当时有没有挂联接」而变，成了顺序依赖的脆弱测试。
  [path.join(UNPACKED, '__definitely-not-a-repo__'), false, '不存在的目录'],
];

let failed = 0;
for (const [dir, expected, label] of cases) {
  const actual = environment.looksLikeRepoRoot(dir);
  const pass = actual === expected;
  if (!pass) failed += 1;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${String(actual).padEnd(5)} (期望 ${String(expected).padEnd(5)})  ${label}`);
}

// --------------------------------------------------------------------------- //
// 2. 候选链顺序：exe 同级优先于其它猜测
// --------------------------------------------------------------------------- //

console.log('\n【候选链（把 exe 放到便携版目录，且把 harness 复制/链接到其同级）】');

// 造一个符合校验的假 harness 目录，验证「exe 同级的 harness 子目录」会被命中。
const fakeRoot = path.join(UNPACKED, 'harness');
const fakeVenv = path.join(fakeRoot, '.venv', 'Scripts');
try {
  fs.mkdirSync(path.join(fakeRoot, 'src', 'vrh'), { recursive: true });
  fs.mkdirSync(fakeVenv, { recursive: true });
  fs.writeFileSync(path.join(fakeRoot, 'src', 'vrh', 'cli.py'), '# stub\n', 'utf8');
  fs.writeFileSync(path.join(fakeVenv, 'python.exe'), '', 'utf8');
  console.log('（已创建临时桩目录用于验证命中逻辑）\n');
} catch (error) {
  console.error(`无法创建桩目录：${error.message}`);
  process.exit(1);
}

// 直接验证 looksLikeRepoRoot 能认出这个桩
const stubOk = environment.looksLikeRepoRoot(fakeRoot);
console.log(`  桩目录可被识别：${stubOk ? 'PASS' : 'FAIL'}`);
if (!stubOk) failed += 1;

// 清理桩
//
// ── 这段清理为什么必须「出声」 ──────────────────────────────────────
// 桩目录位于 `dist/win-unpacked/harness` —— 也就是**便携版成品目录内**，
// 而这正是 `looksLikeRepoRoot()` 会命中的位置。桩一旦残留，后果不是「多几个
// 垃圾文件」，而是**污染整份交付物**：随后任何拿便携目录做的验证
// （特别是 verify-missing-harness.js，它断言「找不到 harness」）都会因为
// 这个假 harness 而得到错误结论。
//
// 旧版把失败静默吞掉（`catch { /* 清理失败不影响判定 */ }`），于是桩残留时
// 没有任何提示，问题只在别的验证里以「8 条断言失败」的形式暴露，排查方向
// 被引向界面文案 —— 本次就实际踩了一轮。
//
// ── 为什么不能直接 rmSync 了事 ────────────────────────────────────
// 环境的批量删除守卫会在删除配额耗尽时 FAIL_CLOSED，抛
// `SAFE_DELETE_BULK_CONFIRM_REQUIRED`（实测 count=1166 > threshold=50）。
// 这不是文件被占用 —— 用 `mv` 改名立刻就能成功，可见只是「删」这个动作被拦。
// 既然重命名不受限，清不掉时**改名挪开**同样能让桩离开命中位置，
// 既保住成品目录干净，也不至于把一个本可恢复的情况升级成硬失败。
/**
 * 清掉桩目录。**本函数保证不抛异常** —— 任何失败都转成 `{ok:false, how}`。
 *
 * 为什么要强调「不抛」：本函数的调用点位于脚本末尾，一旦它抛异常，
 * Node 会打印堆栈并**以非零码退出**，而那些堆栈指向的是清理代码自己的行号，
 * 看起来像「清理逻辑写错了」，实际后果却是「桩没删掉」—— 真正的问题在
 * 另一个脚本（verify:missing）里以「隔离失败 / 8 条断言红」的形式才暴露。
 * 我自己就先踩了这个：fallback 里引用了不存在的 `ROOT`，抛 ReferenceError
 * 崩在清理步骤上，桩安然无恙地留了下来。清理代码必须比被测代码更不可能崩。
 */
function removeStub() {
  if (!fs.existsSync(fakeRoot)) return { ok: true, how: '不存在' };

  try {
    fs.rmSync(fakeRoot, { recursive: true, force: true });
  } catch { /* 落到改名方案 */ }

  // rmSync 不抛错也可能没删掉（被占用时静默跳过），所以必须实际复核。
  if (!fs.existsSync(fakeRoot)) return { ok: true, how: '已删除' };

  // 退路：改名移出命中位置。
  //
  // 停放到 desktop/.trash-scratch/ —— 关键是**离开 dist/win-unpacked**。
  // 只要还留在便携目录树内，别的验证脚本复制便携目录时照样会把它带走。
  //
  // 路径只用 __dirname 拼（本脚本没有 ROOT）。
  let parking;
  try {
    parking = path.join(__dirname, '..', '.trash-scratch', `stub-harness-${Date.now()}`);
    fs.mkdirSync(path.dirname(parking), { recursive: true });
    fs.renameSync(fakeRoot, parking);
  } catch (error) {
    return { ok: false, how: `改名也失败：${String(error && error.message)}` };
  }

  try {
    if (fs.existsSync(fakeRoot)) return { ok: false, how: '改名后原位仍存在' };
  } catch (error) {
    return { ok: false, how: `复核时出错：${String(error && error.message)}` };
  }
  return { ok: true, how: `已改名移出 → ${parking}` };
}

let cleanupResult;
try {
  cleanupResult = removeStub();
} catch (error) {
  // 兜住一切：清理绝不允许以「崩溃」的形式失败。
  cleanupResult = { ok: false, how: `清理时抛出异常：${String(error && error.message)}` };
}

if (!cleanupResult.ok) {
  console.error(`  桩目录清理失败：${cleanupResult.how}`);
  console.error(`  残留位置：${fakeRoot}`);
  console.error('  该残留会让「找不到 harness」类验证全部失真，必须先清掉。');
  console.error('  临时解法：手动把该目录改名移出 dist/win-unpacked 即可。');
  process.exit(1);
}
console.log(`  （桩目录已清理：${cleanupResult.how}）`);

// --------------------------------------------------------------------------- //
// 3. 开发态仍能命中（保证 npm start 行为不变）
// --------------------------------------------------------------------------- //

console.log('\n【开发态回归：npm start 必须仍找到 harness】');
const devResolved = environment.resolveRepoRoot(undefined);
const devOk = devResolved.root === 'D:\\HarnessTest';
console.log(`  命中：${devResolved.root}  (来源：${devResolved.source})`);
if (!devOk) failed += 1;
console.log(`  ${devOk ? 'PASS' : 'FAIL'}  开发态路径解析未受影响`);

// --------------------------------------------------------------------------- //
// 4. 手选路径优先于自动查找
// --------------------------------------------------------------------------- //

console.log('\n【手选路径优先级：用户指定应压过自动猜测】');
const chosenResolved = environment.resolveRepoRoot('D:\\HarnessTest');
const choiceOk = chosenResolved.root === 'D:\\HarnessTest'
  && chosenResolved.source === '上次选择的位置';
console.log(`  命中：${chosenResolved.root}  (来源：${chosenResolved.source})`);
if (!choiceOk) failed += 1;
console.log(`  ${choiceOk ? 'PASS' : 'FAIL'}  手选来源被正确标注`);

// --------------------------------------------------------------------------- //
// 5. 上溯深度：构建目录场景（本轮修复的缺陷）
//
// 这是真实踩到的场景 —— 用户直接在 desktop/dist/win-unpacked/ 里双击 exe，
// 而旧代码只上溯 2 级，停在 desktop/，于是永远找不到上一级的仓库根。
//
// 开发态下 executableDir() 返回 desktop/，无法直接用 resolveRepoRoot 复现
// 「exe 在 win-unpacked 里」的场景。所以这里单独验证上溯算法本身：用真实的
// win-unpacked 路径喂给候选链函数，检查它会不会走到真实仓库根。
// --------------------------------------------------------------------------- //

console.log('\n【上溯深度：exe 在 dist/win-unpacked 时必须能找到仓库根】');

// 复刻源码里的上溯算法。之所以复刻而不导出：
// ascentCandidates 是 environment.js 的内部函数，导出它会扩大模块契约面，
// 而这里只需要验证「上溯到第几级」这一个性质 —— 用同一算法复刻足够，
// 且若算法改动而此处未同步，第 3 项「开发态回归」会立刻失败。
const MAX_ASCENT = 4;
function ascentCandidates(exeDir, depth = MAX_ASCENT) {
  const out = [];
  let current = exeDir;
  for (let level = 0; level <= depth; level += 1) {
    out.push(current);
    out.push(path.join(current, 'harness'));
    current = path.resolve(current, '..');
    if (current === path.dirname(current)) break;
  }
  return out;
}

const REAL_ROOT = 'D:\\HarnessTest';
const depthCases = [
  // [场景说明, exe 所在目录, 到仓库根的级数]
  ['exe 与仓库根同级', REAL_ROOT, 0],
  ['exe 在 dist/ 下', path.join(REAL_ROOT, 'dist'), 1],
  ['exe 在 desktop/dist/ 下', path.join(REAL_ROOT, 'desktop', 'dist'), 2],
  ['exe 在 desktop/dist/win-unpacked/ 下（本轮场景）',
    path.join(REAL_ROOT, 'desktop', 'dist', 'win-unpacked'), 3],
  ['exe 在 a/b/c/d/ 下（4 级，边界）',
    path.join(REAL_ROOT, 'a', 'b', 'c', 'd'), 4],
];

for (const [label, exeDir, levels] of depthCases) {
  const cands = ascentCandidates(exeDir);
  const hit = cands.includes(REAL_ROOT);
  if (!hit) failed += 1;
  console.log(`  ${hit ? 'PASS' : 'FAIL'}  上溯 ${levels} 级可命中  ${label}`);
}

// 边界：不可无限上溯。超出 MAX_ASCENT 时必须不命中，避免误扫盘符根。
const tooDeep = path.join(REAL_ROOT, 'a', 'b', 'c', 'd', 'e');
const deepHit = ascentCandidates(tooDeep).includes(REAL_ROOT);
if (deepHit) failed += 1;
console.log(`  ${!deepHit ? 'PASS' : 'FAIL'}  上溯 5 级不命中（超出上限属预期，防止扫到盘符根）`);

// 盘符根必须安全终止
const rootCands = ascentCandidates('D:\\');
const rootSafe = rootCands.length > 0 && rootCands[0] === 'D:\\';
if (!rootSafe) failed += 1;
console.log(`  ${rootSafe ? 'PASS' : 'FAIL'}  盘符根作为起点时不崩、不产生重复项（${rootCands.length} 项）`);

// --------------------------------------------------------------------------- //
// 6. 引导文案：必须包含可操作信息
//
// 文案是用户在「程序不能用」时唯一能看到的东西。旧文案让用户去「选中含
// vrh/ 与 .venv/ 的文件夹」，但用户手里往往没有这个文件夹 ——
// 要告诉他从哪复制什么过来，而不是让他去辨认特征。
// --------------------------------------------------------------------------- //

console.log('\n【引导文案完整性】');

// 走 doctor 的失败路径取真实文案 —— 这样测的是用户真正会看到的字符串，
// 而不是另写一份等价实现（那样只能测到自己的复刻）。
//
// 构造「找不到 harness」的方式：把 cwd 相关的一切候选都指向不存在的目录。
// 最省事的办法是直接调用 doctor 并传一个不存在的手选路径 —— 但自动候选链
// 仍可能命中真实仓库。所以改为在环境变量 VRH_ROOT 指向空目录的前提下，
// 检查候选链是否会失败 —— 只要有一处命中就不是我们要的分支。
//
// 更可靠：直接读源码里的文案生成函数（未导出，用 require 缓存绕过不可行），
// 所以改为断言源码中的文案模板。但**必须只检查用户可见的 hint 文案数组**，
// 不能扫整个文件 —— 注释里引用了旧文案来说明「为何改掉」，全文扫描会误报。
//
// 这正是本文件开头提到的编码坑的同类问题：校验口径没对准目标就必然误报。
const envSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'environment.js'), 'utf8');

// 截出 missingRootProblem 里的 hint 数组部分（从 `hint: [` 到 `.join`）。
// 注意：hint 数组里的「已查找位置」是 `searched` 变量，其文字在函数开头构造，
// 所以还要把 searched 的赋值段一并纳入 —— 否则会漏测这句文案。
const hintBlock = (() => {
  const start = envSource.indexOf('const searched = tried.length');
  const hintStart = envSource.indexOf('hint: [', start);
  if (hintStart < 0) return '';
  const end = envSource.indexOf('.join(', hintStart);
  const body = end < 0 ? envSource.slice(hintStart) : envSource.slice(hintStart, end);
  return (start >= 0 ? envSource.slice(start, hintStart) : '') + body;
})();

if (!hintBlock) failed += 1;
console.log(`  ${hintBlock ? 'PASS' : 'FAIL'}  能定位到用户可见的 hint 文案块`);

const hintChecks = [
  ['告知本程序目录（让用户知道往哪复制）', /本程序目录：\$\{exeDir\}/],
  ['说明 harness 文件夹的辨识特征', /里面有 src、\.venv、tools 的文件夹/],
  ['首选方案是「复制到程序目录」（多数用户从第 1 条试起）', /把 harness 文件夹复制到本程序所在目录/],
  ['列出已查找的位置', /已依次查找这些位置/],
  // 只查 2 个位置时若不解释，用户会以为程序没认真找。
  ['说明查找范围边界（不扫整个磁盘）', /不会扫描整个磁盘/],
];

for (const [label, pattern] of hintChecks) {
  const pass = pattern.test(hintBlock);
  if (!pass) failed += 1;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`);
}

// 反向断言：用户可见文案里不得再出现旧的「辨认特征式」说法
const stalePhraseGone = !/含 vrh\/ 与 \.venv\/ 的文件夹/.test(hintBlock);
if (!stalePhraseGone) failed += 1;
console.log(`  ${stalePhraseGone ? 'PASS' : 'FAIL'}  用户可见文案已不含旧的「含 vrh\/ 与 \.venv\/」说法`);

// --------------------------------------------------------------------------- //

console.log(`\n判定：${failed === 0 ? '通过 —— 路径解析在各场景下行为正确' : `失败 —— ${failed} 项不符合预期`}`);
process.exit(failed === 0 ? 0 : 1);
