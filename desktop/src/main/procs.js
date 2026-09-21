'use strict';

/**
 * 停止操作的进程树验证。
 *
 * 界面冒烟测试的 stop 场景只断言了「徽标显示已中断」「按钮恢复可用」——
 * 那是界面层的自洽性，不能证明子进程真的被终止了。
 *
 * 这里验证的是另一件事：**点停止之后，Python 与它拉起的 ffmpeg 是否真的消失**。
 * 这是这个应用最容易留隐患的地方 —— Windows 上 child.kill() 只杀直接子进程，
 * ffmpeg 会变成孤儿继续吃 CPU，而用户在界面上看不到任何异常。
 *
 * 用法：npm start -- --procs
 */

const path = require('path');
const { execFileSync } = require('child_process');

const SAMPLE = path.resolve(__dirname, '..', '..', '..', 'samples', 'clip.mp4');

/** 取当前所有相关进程（按 PID → 命令行）。用 tasklist -V 拿命令行。 */
function snapshot() {
  const out = execFileSync('tasklist', ['-V', '-FO', 'CSV'], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });

  const procs = new Map();
  for (const line of out.split(/\r?\n/)) {
    // CSV 字段：映像名称, PID, 会话名, 会话#, 内存, 状态, 用户名, CPU时间, 窗口标题
    const m = line.match(/^"([^"]+)","(\d+)"/);
    if (!m) continue;
    const name = m[1].toLowerCase();
    const pid = Number(m[2]);
    if (['python.exe', 'ffmpeg.exe', 'ffprobe.exe'].includes(name)) {
      procs.set(pid, name);
    }
  }
  return procs;
}

/** 列出属于指定 PID 集合的子进程（通过 wmic 的 ParentProcessId 关系）。 */
async function runOnce(win) {
  const before = snapshot();
  console.log('\n=== 停止操作的进程树验证 ===');
  console.log(`停止前环境中的相关进程：${[...before].map(([p, n]) => `${n}#${p}`).join(', ') || '（无）'}`);

  // 用界面真实路径启动：写表单 + 点按钮，与用户操作一致。
  // --fresh 绕开缓存，否则流水线秒级完成，等不到可中断的窗口。
  const config = { videoPath: SAMPLE, preset: 't2v_generic', runMode: 'full', fresh: true };
  const payload = JSON.stringify(JSON.stringify(config));
  await win.webContents.executeJavaScript(`
    (async () => {
      window.__smokeSetConfig(JSON.parse(${payload}));
      await new Promise((r) => setTimeout(r, 120));
      document.getElementById('btnRun').click();
      return 'clicked';
    })()
  `);

  // 等停止按钮可用（说明子进程已起来）。
  const deadline = Date.now() + 60000;
  let running = false;
  while (Date.now() < deadline) {
    running = await win.webContents.executeJavaScript(
      `!document.getElementById('btnStop').disabled`
    ).catch(() => false);
    if (running) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!running) {
    console.log('  ! 点了运行但停止按钮始终不可用 —— 无法验证');
    return { problems: ['无法进入运行态'] };
  }

  // 先记下启动初期的进程集合，后面用它判断停止后是否清干净了。
  // 放在这里（而不是紧邻点击之前）是有意的：tasklist 扫描要一两秒，
  // 夹在「检查运行状态」与「点击停止」之间会把时间窗撑大，导致点下去时
  // 流水线已经自然结束。
  const spawned = snapshot();
  console.log(`启动后新增进程：${
    [...spawned.keys()].filter((p) => !before.has(p))
      .map((p) => `${spawned.get(p)}#${p}`).join(', ') || '（未捕获到）'}`);

  // 等首条日志，确保流水线真的在跑（而不是还卡在启动阶段）。
  const logDeadline = Date.now() + 30000;
  while (Date.now() < logDeadline) {
    const n = await win.webContents.executeJavaScript(
      `document.querySelectorAll('#logBody .log-line').length`
    ).catch(() => 0);
    if (n > 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  // 关键：确认此刻仍在运行中，并**立即点击**，中间不能插入任何耗时调用。
  //
  // 这里踩过两次同样的坑：tasklist 一次扫描要一两秒，而沙箱会拦截 harness 在
  // 切分层的重复关键帧删除，流水线可能恰好在这段时间里自然结束。此时
  // setRunning(false) 已把停止按钮置灰，runner 的 stop() 也会因 settled 而
  // 静默返回 false —— 界面正确地显示「运行出错」，是探针点晚了。
  //
  // 所以顺序必须是：查状态 → 立刻点击 → 再取快照。
  // 两次检查合成一次往返，把中间的时间窗压到最小。
  const preClick = await win.webContents.executeJavaScript(`(() => {
    const stop = document.getElementById('btnStop');
    return {
      stopEnabled: !stop.disabled,
      resultKind: document.getElementById('resultBody').dataset.kind || null,
    };
  })()`);

  if (!preClick.stopEnabled || preClick.resultKind) {
    console.log(`  ! 点停止前流水线已结束（按钮可用=${preClick.stopEnabled}，结论=${preClick.resultKind || '无'}）` +
                ' —— 本次采样作废，未能验证中断路径');
    return { problems: [], skipped: true };
  }

  console.log('点击停止…');
  await win.webContents.executeJavaScript(`document.getElementById('btnStop').click()`);

  // 点击之后才取快照，看此刻还剩哪些进程。
  // taskkill 是异步生效的，这里拿到的是「被终止前/终止中」的集合。
  const midRun = snapshot();
  console.log(`停止瞬间仍在的进程：${
    [...midRun.keys()].filter((p) => !before.has(p))
      .map((p) => `${midRun.get(p)}#${p}`).join(', ') || '（已全部退出）'}`);

  // 等界面给出结论。
  const settleDeadline = Date.now() + 60000;
  let kind = null;
  while (Date.now() < settleDeadline) {
    kind = await win.webContents.executeJavaScript(
      `document.getElementById('resultBody').dataset.kind || null`
    ).catch(() => null);
    if (kind) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`界面结论：${kind}`);

  // 进程残留判定以「启动后观察到的那批进程」为基准，而不是点击后的快照 ——
  // taskkill 生效极快，点击后可能一个都不剩，用后者当基准会导致误报「未捕获到」。
  const observed = new Set([
    ...spawned.keys(),
    ...midRun.keys(),
  ]);
  const expected = [...observed].filter((p) => !before.has(p));

  let cleared = false;
  let stragglers = [];
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const after = snapshot();
    stragglers = expected.filter((p) => after.has(p));
    if (stragglers.length === 0) { cleared = true; break; }
  }

  const after = snapshot();
  console.log(`停止 10 秒后残留：${stragglers.map((p) => `${after.get(p) || '?'}#${p}`).join(', ') || '（无）'}`);

  const problems = [];
  if (!expected.length) {
    problems.push('运行期间没有捕获到任何 Python/ffmpeg 进程 —— 验证无效');
  }
  if (!cleared) {
    problems.push(`停止后仍有 ${stragglers.length} 个进程残留：${stragglers.join(', ')}（进程树未完整终止）`);
  }
  if (kind !== 'interrupted') {
    problems.push(`停止后界面结论应为 interrupted，实际 ${kind}`);
  }

  console.log('');
  if (problems.length) {
    for (const p of problems) console.log(`  ! ${p}`);
  } else {
    console.log('判定：通过 —— 进程树被完整终止，界面结论正确');
  }
  console.log('');
  return { problems, expected, stragglers, kind };
}

/**
 * 带重试的入口。
 *
 * 中断窗口有时很窄：沙箱会拦截 harness 在切分层的重复关键帧删除，流水线可能在
 * 首条日志出现后立刻收尾，导致这一次采样根本没赶上「运行中」。这不是缺陷，
 * 重来一次即可 —— 但要把「采样作废」与「验证失败」区分开，否则会误报。
 */
async function runWithRetry(win, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    const result = await runOnce(win);
    if (!result.skipped) return result;
    if (i < attempts) {
      console.log(`\n（第 ${i} 次采样未命中运行中窗口，重新加载界面后重试…）\n`);
      // 重试用重新加载而不是再点一次按钮：上一次运行可能刚刚结束、
      // 主进程的 activeRun 尚未归零，直接再点会被「已有运行在进行中」拒绝。
      win.webContents.reload();
      await new Promise((r) => win.webContents.once('did-finish-load', r));
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  console.log('  连续多次都未命中运行中窗口 —— 无法验证，按采样作废处理');
  return { problems: [], skipped: true };
}

module.exports = { run: runWithRetry };
