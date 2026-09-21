'use strict';

/**
 * 验证脚本的「用户数据隔离」守卫。
 *
 * ── 为什么需要这条 ─────────────────────────────────────────────
 * 这是一个**已经真实发生过**的缺陷：`verify:model-ui` 会往 Key 输入框填
 * 占位值 `sk-test-not-a-real-key`，输入框的 `input` 监听器立刻持久化 ——
 * 于是测试把**用户真实保存的 API Key 覆盖掉了**。
 *
 * 症状极具误导性：用户报告「我明明配好了却一直连接失败」，而配置里躺着
 * 一个 22 字符的测试占位值。排查方向会被引向「Key 是不是过期了」，
 * 而真凶是自家的验证脚本。
 *
 * 这类缺陷的可怕之处是**跨轮次、静默、且伪装成用户配置问题**。所以必须有
 * 一条自动断言盯着：**任何会写配置的启动型脚本，都必须带隔离参数**。
 *
 * 本脚本用静态检查实现（不启动应用，秒级）：
 *   1. 找出所有会启动 Electron 且会写模型配置的脚本
 *   2. 断言它们都引用了隔离工具
 *   3. 断言隔离工具本身行为正确（建目录、参数形状）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const {
  makeIsolatedUserData,
  cleanupIsolatedUserData,
  killAndWait,
} = require('./lib/isolated-user-data');

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok });
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
}

console.log('=== 验证脚本的用户数据隔离 ===\n');

// ---------------------------------------------- 1. 找出「会写配置」的启动型脚本
console.log('【1. 静态扫描：启动型脚本是否隔离】');

const files = fs.readdirSync(SCRIPTS).filter((f) => f.endsWith('.js'));
const offenders = [];
const checked = [];
const unisolatedAll = [];

for (const f of files) {
  const full = path.join(SCRIPTS, f);
  const src = fs.readFileSync(full, 'utf8');

  // 只关心「自己启动应用」的脚本 —— 独立单元验证不启动应用，无此风险。
  const launchesApp = /spawn\(/.test(src) && /--debug-port/.test(src);
  if (!launchesApp) continue;

  /*
   * 判据必须**同时**看「调用了工具」和「参数真的传给了 spawn」。
   *
   * 曾经只查 `makeIsolatedUserData` 这个词 —— 结果把它注释掉、只留
   * `__DISABLED_makeIsolatedUserData` 时，子串仍然匹配，守卫照样报「已隔离」。
   * 这是典型的**假通过**：检查了，但检查不出问题。
   *
   * 所以改成两个必要条件：
   *   1. 真的调用了工厂函数（剔除注释、拒绝前缀污染）
   *   2. 返回值展开进了 spawn 的 argv
   * 只满足一个都算未隔离 —— 建了目录却不传参数，等于没隔离。
   */
  const callsFactory = /(^|[^A-Za-z0-9_])makeIsolatedUserData\s*\(/.test(
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
  );
  const passesArgs = /udd\.args/.test(src);
  const isolated = callsFactory && passesArgs;

  // 会往界面里填 Key / 调保存接口的，属于「确定会写配置」。
  // 注意 `saveModelConfig` 是 IPC 名，`apiKey` 是界面字段名，两者任一出现都算。
  const writesConfig = /saveModelConfig|apiKey/.test(src);

  if (!isolated) unisolatedAll.push(f);
  if (!writesConfig) continue;

  checked.push(f);
  console.log(`   ${isolated ? 'OK  ' : '缺失'}  ${f}`
    + (isolated
      ? '（已隔离）'
      : `（${
        !callsFactory ? '未调用隔离工具' : '未把隔离参数传给 spawn'
      }）`));
  if (!isolated) offenders.push(f);
}

// 分级：会写配置的必须隔离（硬失败）；暂未写配置的只提示。
// 分级而非一刀切，是因为一刀切会把「读了配置但只读不写」的脚本也判红，
// 那样守卫会因为噪声过多而被绕过 —— 而绕过一次之后就再没人看它了。
if (unisolatedAll.filter((f) => !checked.includes(f)).length > 0) {
  console.log('\n   （以下脚本启动了应用但未隔离；当前尚未写配置，属可接受，'
    + '但一旦开始写就应加隔离）');
  unisolatedAll
    .filter((f) => !checked.includes(f))
    .forEach((f) => console.log(`   提示  ${f}`));
}

check('存在需要隔离的启动型脚本（自检：扫描逻辑没空转）',
  checked.length > 0, `扫到 ${checked.length} 个`);
check('全部已隔离 userData',
  offenders.length === 0,
  offenders.length ? `未隔离：${offenders.join(', ')}` : `共 ${checked.length} 个`);

// ---------------------------------------------- 1b. 进程回收
console.log('\n【1b. 进程回收（防孤儿进程占住 dist/）】');

/*
 * 孤儿进程是实测踩到的坑：`child.kill()` 只对直接子进程发信号，而 Electron
 * 会派生 renderer / GPU 等子进程。脚本紧接着 `process.exit()` 的话，父进程
 * 来不及收尾，子进程留在系统里**占着 dist/win-unpacked/ 的文件句柄**，
 * 导致后续 electron-builder 打包失败（`Device or resource busy`）。
 *
 * 所以断言：启动型脚本必须用 killAndWait（等它真退出），且**失败路径也要收**。
 */
const leaky = [];
const teardownChecked = [];

for (const f of files) {
  const full = path.join(SCRIPTS, f);
  const src = fs.readFileSync(full, 'utf8');

  const launchesApp = /spawn\(/.test(src) && /--debug-port/.test(src);
  if (!launchesApp) continue;

  /*
   * 跳过自己。
   *
   * 本脚本也会 spawn 一个 node 子进程（验证 killAndWait 行为），因此按
   * 「含 spawn + debug-port」的判据会被自己扫进来 —— 但它 spawn 的不是
   * 应用，是秒退的探测进程，不该套用「catch 里必须收应用进程」这条规则。
   * 不排除的话会报一个**假失败**，而假失败比不检查更糟：它会让人开始
   * 怀疑守卫本身，进而忽略它的真报警。
   */
  if (f === path.basename(__filename)) continue;

  /*
   * 跳过「故意分离」的启动器。
   *
   * launch-packaged-detached.js 的**全部意义就是让进程活过本次会话**
   * （detached + unref）。对它套用「必须等进程退出」的规则是**方向反了** ——
   * 那是它的功能，不是缺陷。所以按用途白名单排除，而不是按文件名猜测。
   */
  if (f === 'launch-packaged-detached.js') continue;

  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  /*
   * 「等进程真退出」有两种合格实现：
   *   1. `killAndWait()` —— 跨平台，等 exit 事件（本项目的标准做法）
   *   2. `taskkill /T`    —— Windows 专有，但能**一次杀掉整棵树**，
   *                          连应用拉起的 Python 子进程一起收
   *
   * 第 2 种在某些场景下更彻底（Electron 会派生 renderer/GPU，还可能再派生
   * Python），所以不应判它不合格 —— 把合格的实现误判为失败，会让人开始
   * 怀疑守卫本身，进而忽略它的真报警。
   */
  const usesKillAndWait = /(^|[^A-Za-z0-9_])killAndWait\s*\(/.test(stripped);
  const usesTaskkillTree = /taskkill[\s\S]{0,120}?\/T/.test(stripped);
  const killsProperly = usesKillAndWait || usesTaskkillTree;

  // catch / unhandledRejection 分支必须也收进程（这里最容易漏）。
  const catchCollects = /(catch\(async[\s\S]{0,600}?|unhandledRejection[\s\S]{0,600}?)(killAndWait|taskkill|cleanup)/.test(stripped);

  teardownChecked.push(f);
  const ok = killsProperly && catchCollects;
  console.log(`   ${ok ? 'OK  ' : '缺失'}  ${f}`
    + (ok
      ? `（${usesTaskkillTree && !usesKillAndWait ? 'taskkill /T 收整棵树' : '正常 + 失败路径都收'}）`
      : `（${[
        !killsProperly ? '未等待进程退出' : '',
        !catchCollects ? '失败路径没收进程' : '',
      ].filter(Boolean).join('；')}）`));
  if (!ok) leaky.push(f);
}

check('存在需要检查进程回收的脚本（自检：没空转）',
  teardownChecked.length > 0, `扫到 ${teardownChecked.length} 个`);
check('全部脚本都等待进程真正退出',
  leaky.length === 0,
  leaky.length ? `有问题：${leaky.join(', ')}` : `共 ${teardownChecked.length} 个`);

// killAndWait 自身的行为。
// CommonJS 顶层没有 await，用 then 链把它接到底部的汇总之前。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killAndWaitChecks = (async () => {
  const liveChild = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
  await sleep(300);
  const started = liveChild.exitCode === null && liveChild.signalCode === null;
  await killAndWait(liveChild, 3000);
  // 被信号终止时 exitCode 保持 null、signalCode 有值 —— 两个都要看。
  const died = liveChild.exitCode !== null || liveChild.signalCode !== null;
  check('killAndWait 能结束活着的进程', started && died,
    `exitCode=${liveChild.exitCode} signalCode=${liveChild.signalCode}`);
  check('killAndWait 对已退出进程是幂等的（不抛）', await (async () => {
    try { await killAndWait(liveChild, 500); return true; } catch { return false; }
  })());
  check('killAndWait 传 null 不抛（防调用方漏判）', await (async () => {
    try { await killAndWait(null, 500); return true; } catch { return false; }
  })());
})();

// ---------------------------------------------- 2. 隔离工具本身的行为
console.log('\n【2. 隔离工具行为】');

const udd = makeIsolatedUserData('selftest');
check('建出了目录', fs.existsSync(udd.dir), udd.dir);
check('目录在系统临时目录下（不污染项目）',
  path.resolve(udd.dir).startsWith(path.resolve(os.tmpdir())),
  os.tmpdir());
check('参数形状是 --user-data-dir=<路径>',
  udd.args.length === 1 && udd.args[0] === `--user-data-dir=${udd.dir}`,
  udd.args[0]);

// 两次调用必须不同，否则并发验证会互相踩。
const udd2 = makeIsolatedUserData('selftest');
check('两次调用产生不同目录（可并发）', udd.dir !== udd2.dir, '目录名含 pid + 时间戳');
cleanupIsolatedUserData(udd2);

// ---------------------------------------------- 3. 清理行为
console.log('\n【3. 清理】');
cleanupIsolatedUserData(udd);
check('清理后目录已删除', !fs.existsSync(udd.dir), udd.dir);
check('清理不存在的目录不抛异常（幂等）', (() => {
  try { cleanupIsolatedUserData(udd); return true; } catch { return false; }
})());
check('传 null 不抛异常（防调用方漏判）', (() => {
  try { cleanupIsolatedUserData(null); return true; } catch { return false; }
})());

killAndWaitChecks.then(() => {
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${'='.repeat(56)}`);
  console.log(`合计 ${results.length} 项，通过 ${passed}，失败 ${results.length - passed}`);
  console.log('='.repeat(56));
  if (passed < results.length) {
    console.log('\n未通过：');
    results.filter((r) => !r.ok).forEach((r) => console.log(`  · ${r.label}`));
    console.log('\n提示：');
    console.log('  · 会写配置的启动型脚本必须调用 makeIsolatedUserData()，');
    console.log('    并把返回的 args 展开进 spawn 的 argv。');
    console.log('  · 所有启动型脚本都要用 killAndWait() 等进程真退出，');
    console.log('    且 catch 分支也要收 —— 否则孤儿进程会占住 dist/。');
  }
  process.exit(passed === results.length ? 0 : 1);
});
