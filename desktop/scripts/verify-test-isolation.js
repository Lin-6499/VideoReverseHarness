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

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const {
  makeIsolatedUserData,
  cleanupIsolatedUserData,
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

const passed = results.filter((r) => r.ok).length;
console.log(`\n${'='.repeat(56)}`);
console.log(`合计 ${results.length} 项，通过 ${passed}，失败 ${results.length - passed}`);
console.log('='.repeat(56));
if (passed < results.length) {
  console.log('\n未通过：');
  results.filter((r) => !r.ok).forEach((r) => console.log(`  · ${r.label}`));
  console.log('\n提示：会写配置的启动型脚本必须调用 makeIsolatedUserData()，');
  console.log('并把返回的 args 展开进 spawn 的 argv。');
}
process.exit(passed === results.length ? 0 : 1);
