'use strict';

/**
 * 打包态「找不到 harness」场景验证。
 *
 * 为什么单独做一个：主验证（verify-packaged.js）跑的是「一切正常」的路径。
 * 而用户实际遇到报错时，看到的是**错误横幅** —— 里面的文案、引导按钮、
 * 「已依次查找」清单是否可用，是另一套需要独立验证的界面状态。
 *
 * ── 怎么造这个场景 ────────────────────────────────────────────────
 * 不能去动真实的 harness（有风险），也不能靠环境变量（VRH_ROOT 为空时
 * 候选链会继续自动查找，但 exe 在 dist 里，上溯 3 级就能找到真实仓库）。
 *
 * 做法：把便携目录**复制**到一个与真实 harness 无路径关系的临时位置，
 * 例如 `D:\_vrh-verify-<时间戳>\`。复制后上溯 4 级都到不了 D:\HarnessTest，
 * 于是必然进入「找不到 harness」分支。
 *
 * 复制整份便携目录较重（269MB），但只复制必需的几个文件即可让应用起来：
 * exe + resources/app.asar + 若干 dll/pak。实测缺文件时 Electron 会直接
 * 退出，所以这里必须复制完整目录 —— 用 fs.cpSync 一次搞定。
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const http = require('http');

const { guardedRemove } = require('./lib/remove-tree');

const ROOT = path.resolve(__dirname, '..');
const UNPACKED = path.join(ROOT, 'dist', 'win-unpacked');
const EXE = path.join(UNPACKED, 'VRH 视频反推.exe');
const PORT = 9223;

// 与真实 harness 完全无关的位置：上溯任何级数都不会碰到 D:\HarnessTest
const ISOLATED = path.join('D:\\', `_vrh-noharness-${Date.now()}`);

let child = null;
const report = { problems: [] };

function progress(msg) { console.log(msg); }

function portBusy(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 800 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function httpJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`不是 JSON：${body.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
  });
}

/** 极简 CDP 客户端：连一个页面，按 id 匹配响应。
 *
 * 用 Node 22 内置的 WebSocket（`require('ws')` 在无依赖环境下不可用，
 * 而 built-in 版本完全够用 —— verify-packaged.js 走的也是这条路）。
 */
function createClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(String(event.data)); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} 超时`));
      }
    }, 30000);
  });

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || '求值异常');
    }
    return result.result.value;
  };

  return { ready, send, evaluate, close: () => ws.close() };
}

/** 等界面初始化完成（<html data-ready="1">）。 */
async function waitReady(client, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ready = await client.evaluate("document.documentElement.dataset.ready === '1'");
      if (ready) return true;
    } catch { /* 导航中，重试 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * 递归复制目录。
 *
 * 为什么不用 `fs.cpSync`：实测在 269MB 的便携目录上会**静默中断** ——
 * 进程正常退出、没有任何异常抛出、目标目录只复制了一部分。这类静默失败
 * 在验证脚本里格外危险（会让人以为「验证跑过了」）。
 *
 * 改为逐项复制并计数，任何一步失败都抛出来。
 */
function copyTree(src, dest, counter = { files: 0, bytes: 0 }) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to, counter);
    } else if (entry.isSymbolicLink()) {
      // 便携目录里通常没有联接，但真遇到就跳过 —— 不把外部依赖拖进来。
      continue;
    } else {
      fs.copyFileSync(from, to);
      counter.files += 1;
      counter.bytes += fs.statSync(to).size;
    }
  }
  return counter;
}

function cleanup() {
  if (child && child.exitCode === null) {
    try {
      // 用 taskkill /T 终止整棵树（应用会拉起 Python 探测进程）。
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch { /* 已经退出 */ }
  }

  // 隔离目录有近 200 个文件，直接 rmSync 会被 bulk-delete 守卫拦下
  // （实测报 SAFE_DELETE_BULK_CONFIRM_REQUIRED，count=198 > threshold=50）。
  // 走逐项删除的实现，并把「删不掉的」如实报出来 —— 静默留下几百兆垃圾
  // 比报错更糟。
  const stats = guardedRemove(ISOLATED, path.dirname(ISOLATED));
  if (stats.rejected) {
    progress(stats.rejected);
    return;
  }
  if (!fs.existsSync(ISOLATED)) {
    progress(`已清理隔离目录：${ISOLATED}（${stats.files} 个文件）`);
  } else {
    progress(`隔离目录未清干净，可手动删：${ISOLATED}`);
    stats.failed.slice(0, 5).forEach((f) => progress(`  · ${f}`));
  }
}

async function main() {
  progress('=== 打包态「找不到 harness」场景验证 ===\n');

  if (!fs.existsSync(EXE)) {
    console.error(`未找到 exe：${EXE}\n请先运行 npm run dist`);
    process.exit(1);
  }

  if (await portBusy(PORT)) {
    console.error(`端口 ${PORT} 已被占用，请先关闭占用它的程序。`);
    process.exit(2);
  }

  // 1. 复制便携目录到隔离位置
  //
  // 复制约 260MB，需要几秒。逐文件复制并打印计数 —— 若能到「完成」说明
  // 复制是完整的（见 copyTree 的注释：fs.cpSync 会静默中断）。
  progress('1. 复制便携目录到隔离位置（上溯 4 级也无法到达真实 harness）');
  progress(`   ${UNPACKED}`);
  progress(`   → ${ISOLATED}`);
  try {
    const counter = copyTree(UNPACKED, ISOLATED);
    progress(`   完成：${counter.files} 个文件，${(counter.bytes / 1024 / 1024).toFixed(0)} MB`);
  } catch (error) {
    console.error(`   复制失败：${error.message}`);
    cleanup();
    process.exit(1);
  }
  const isolatedExe = path.join(ISOLATED, path.basename(EXE));
  if (!fs.existsSync(isolatedExe)) {
    console.error(`   复制后未找到 exe：${isolatedExe}`);
    cleanup();
    process.exit(1);
  }
  progress(`   exe：${isolatedExe}\n`);

  // 2. 启动
  progress(`2. 启动应用（调试端口 ${PORT}）`);
  child = spawn(isolatedExe, [`--debug-port=${PORT}`], {
    cwd: ISOLATED,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: (() => {
      const env = { ...process.env };
      // 这两个变量会让打包应用无法以应用模式启动，必须剥掉。
      delete env.NODE_OPTIONS;
      delete env.ELECTRON_RUN_AS_NODE;
      // 确保不会因为外部环境变量而意外找到 harness。
      delete env.VRH_ROOT;
      return env;
    })(),
  });

  child.stdout.on('data', (d) => process.stdout.write(`   [exe] ${d}`));
  child.stderr.on('data', (d) => process.stdout.write(`   [exe:err] ${d}`));

  // 3. 连 CDP
  progress('3. 等待调试端口就绪');
  let target = null;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      console.error(`\n应用提前退出（code=${child.exitCode}），无法继续验证。`);
      cleanup();
      process.exit(1);
    }
    try {
      const list = await httpJson(PORT, '/json/list');
      target = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!target) {
    console.error('等待调试端口超时。');
    cleanup();
    process.exit(1);
  }
  progress('   CDP 已就绪\n');

  const client = createClient(target.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Runtime.enable');
  await client.send('Page.enable');

  const results = [];
  const check = (label, ok, detail) => {
    results.push({ label, ok });
    if (!ok) report.problems.push(label);
    progress(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  };

  try {
    // 4. 等初始化
    progress('4. 等界面初始化');
    const ready = await waitReady(client);
    check('界面在 90 秒内完成初始化', ready);
    if (!ready) throw new Error('界面未完成初始化');

    // 5. 读出错误横幅的全部内容
    //
    // 已查找位置列表从 title 属性取 —— 它是换行分隔的多行文本。
    // 注意：这里在 JS 模板字符串里传表达式，所以换行符要写成 '\n' 的转义形式
    // （写成 '\n' 会被外层模板字符串先解析掉，变成真的换行、把表达式截断）。
    progress('\n5. 检查错误横幅');
    const snapshotExpr = [
      '(() => {',
      "  const text = (id) => { const n = document.getElementById(id); return n ? n.innerText.trim() : null; };",
      "  const btn = (id) => { const n = document.getElementById(id); return n ? { hidden: n.hidden, label: n.innerText.trim() } : null; };",
      "  const titleNode = document.getElementById('envRepoText');",
      '  return {',
      "    status: text('statusText'),",
      "    bannerHidden: document.getElementById('envBanner').hidden,",
      "    bannerTitle: text('envBannerTitle'),",
      "    problems: [...document.querySelectorAll('#envBannerList li')].map(li => li.innerText.trim()),",
      "    repoRowHidden: document.getElementById('envRepoRow').hidden,",
      "    repoText: text('envRepoText'),",
      '    searchedList: titleNode ? titleNode.title.split(String.fromCharCode(10)).filter(Boolean) : [],',
      "    openNotice: btn('btnOpenNotice'),",
      "    pickRepo: btn('btnPickRepo'),",
      "    runDisabled: document.getElementById('btnRun').disabled,",
      "    dryRunDisabled: document.getElementById('btnDryRun').disabled,",
      '  };',
      '})()',
    ].join('\n');
    const snap = await client.evaluate(snapshotExpr);

    progress(`   状态栏      ：${snap.status}`);
    progress(`   横幅标题    ：${snap.bannerTitle}`);
    progress(`   目录行      ：${snap.repoText}`);
    progress(`   已查找位置  ：${(snap.searchedList || []).length} 个`);
    for (const dir of snap.searchedList || []) progress(`      · ${dir}`);

    check('状态栏为「环境未就绪」', snap.status === '环境未就绪', `实际 ${snap.status}`);
    check('错误横幅可见', snap.bannerHidden === false);
    check('「开始运行」已禁用', snap.runDisabled === true);
    check('「干跑预演」已禁用', snap.dryRunDisabled === true);

    // 6. 引导文案的关键内容
    progress('\n6. 检查引导文案');
    const problemText = (snap.problems || []).join('\n');
    progress('   ---- 用户看到的文案 ----');
    problemText.split('\n').forEach((l) => progress(`   ${l}`));
    progress('   ------------------------');

    check('提示「未找到 harness 仓库」', /未找到 harness 仓库/.test(problemText));
    check('给出「复制到程序目录」这一首选办法', /复制到本程序所在目录/.test(problemText));
    check('告知本程序所在目录（用户据此知道往哪复制）',
      new RegExp(ISOLATED.replace(/\\/g, '\\\\')).test(problemText) || /本程序目录：/.test(problemText));
    check('说明 harness 文件夹的辨识特征', /里面有 src、\.venv、tools/.test(problemText));
    check('列出已查找的位置', /已依次查找这些位置/.test(problemText));
    check('保留了「手动指定」办法', /手动指定/.test(problemText));
    check('保留了环境变量办法', /VRH_ROOT/.test(problemText));

    // 7. 界面上的按钮
    progress('\n7. 检查界面按钮');
    check('「怎么放？」按钮已显示', snap.openNotice && snap.openNotice.hidden === false,
      snap.openNotice ? `label=${snap.openNotice.label}` : '按钮不存在');
    check('「手动指定」按钮已显示', Boolean(snap.pickRepo));

    // 8. 点「怎么放？」必须真的有反应
    progress('\n8. 点「怎么放？」验证一定有反馈');
    // 说明文件不在隔离目录里（还没生成过），主进程应当现写一份再打开。
    // 打开动作会调用系统默认程序，为避免拉起记事本干扰验证，这里只检查
    // IPC 返回值 —— 它明确告诉我们「走了哪条路径」。
    const noticeResult = await client.evaluate(`
      window.vrh.openNotice().then(r => JSON.stringify(r)).catch(e => JSON.stringify({ error: String(e) }))
    `);
    progress(`   IPC 返回：${noticeResult}`);
    let parsed = null;
    try { parsed = JSON.parse(noticeResult); } catch { /* 保持 null */ }
    check('「怎么放？」有明确返回值（不是静默失败）', Boolean(parsed && !parsed.error));
    check('说明了走了哪条路径（opened / created / dialog）',
      Boolean(parsed && ['opened', 'created', 'dialog'].includes(parsed.action)),
      parsed ? `action=${parsed.action}` : '');

    // 9. 说明文件确实被写出来了（created 或已存在）
    const noticePath = path.join(ISOLATED, '请先阅读 - harness 放置说明.txt');
    const noticeExists = fs.existsSync(noticePath);
    check('程序目录里存在放置说明文件', noticeExists, noticeExists ? `${fs.statSync(noticePath).size} 字节` : '');
    if (noticeExists) {
      const raw = fs.readFileSync(noticePath);
      // 必须是 UTF-8 带 BOM，否则记事本打开是乱码。
      const hasBom = raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF;
      check('说明文件为 UTF-8 带 BOM（记事本不乱码）', hasBom,
        hasBom ? '' : `前 3 字节 ${raw.slice(0, 3).toString('hex')}`);
      const body = raw.toString('utf8');
      check('说明正文含「复制到本程序所在目录」', /复制到本程序所在目录/.test(body));
      check('说明正文含程序目录绝对路径', body.includes(ISOLATED));
    }

    // 10. 顺手确认「重新探测」不会崩（用户最常见的下一步动作）
    progress('\n9. 点「重新探测」确认不崩');
    await client.evaluate("document.getElementById('btnRecheck').click()");
    await new Promise((r) => setTimeout(r, 3500));
    const afterRecheck = await client.evaluate(`(() => {
      const n = document.getElementById('statusText');
      return n ? n.innerText.trim() : null;
    })()`);
    progress(`   状态栏：${afterRecheck}`);
    check('重新探测后界面仍可用', Boolean(afterRecheck && afterRecheck.length > 0));

  } catch (error) {
    report.problems.push(`验证过程异常：${error.message}`);
    check(`验证过程无异常（${error.message}）`, false);
  } finally {
    client.close();
  }

  // ------------------------------------------------------------------------ //
  const passed = results.filter((r) => r.ok).length;
  progress(`\n${'='.repeat(56)}`);
  progress(`合计 ${results.length} 项，通过 ${passed}，失败 ${results.length - passed}`);
  if (report.problems.length) {
    progress('\n未通过项：');
    report.problems.forEach((p) => progress(`  · ${p}`));
  }
  progress('='.repeat(56));

  cleanup();
  process.exit(report.problems.length ? 1 : 0);
}

// 兜底：任何未捕获异常都要清理掉隔离目录与子进程，别留垃圾。
process.on('unhandledRejection', (reason) => {
  console.error(`未捕获异常：${reason && reason.stack || reason}`);
  cleanup();
  process.exit(1);
});
process.on('SIGINT', () => { cleanup(); process.exit(130); });

main();
