'use strict';

/**
 * 依次跑完全部冒烟场景。
 *
 * 每个场景是一次独立的 Electron 启动 —— 一个场景崩了不会污染下一个，
 * 这比在一个进程里连续跑更能暴露「状态没清理干净」的问题。
 *
 * 用法：node scripts/run-all.js [场景...]
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ELECTRON = path.resolve(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const ROOT = path.resolve(__dirname, '..');
const SCENARIOS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['idle', 'layout', 'success', 'gate', 'error', 'stop', 'fresh', 'prompt-edit'];

const results = [];

for (const scenario of SCENARIOS) {
  const bar = '='.repeat(60);
  console.log(`\n${bar}\n> 场景 ${scenario}\n${bar}`);

  // 剥掉会干扰 Electron 启动的环境变量。
  //
  // NODE_OPTIONS：某些开发环境（例如 IDE 注入的 language shim）会带上这个变量。
  //   它被 Electron 子进程继承后，Electron 会以「纯 Node 模式」启动而不是应用模式，
  //   于是 `require('electron').ipcMain` 是 undefined，启动即崩 ——
  //   症状看起来像「应用坏了」，实际是环境串味。这与产品无关，必须在这里清掉。
  // ELECTRON_RUN_AS_NODE：同理，会强制 Electron 退化成 Node 解释器。
  const childEnv = { ...process.env };
  delete childEnv.NODE_OPTIONS;
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const out = spawnSync(ELECTRON, ['.', `--smoke=${scenario}`], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300000,
    env: childEnv,
  });

  const text = `${out.stdout || ''}${out.stderr || ''}`;
  fs.writeFileSync(path.join(ROOT, `smoke-${scenario}.log`), text, 'utf8');

  const passed = out.status === 0;
  const problems = text
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('! '))
    .map((l) => l.trim().slice(2));

  results.push({ scenario, passed, exitCode: out.status, problems });
  console.log(passed ? `[OK] ${scenario}` : `[FAIL] ${scenario}`);
  for (const p of problems) console.log(`    ! ${p}`);
}

console.log(`\n${'='.repeat(60)}\n汇总\n${'='.repeat(60)}`);
for (const r of results) {
  console.log(`${r.passed ? '[OK]  ' : '[FAIL]'} ${r.scenario.padEnd(10)} 退出码 ${r.exitCode}  问题 ${r.problems.length} 项`);
}
const failed = results.filter((r) => !r.passed);
console.log(`\n合计 ${results.length} 个场景，通过 ${results.length - failed.length}，失败 ${failed.length}`);
process.exit(failed.length ? 1 : 0);
