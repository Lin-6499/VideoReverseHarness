'use strict';

/**
 * 打包态一站式验证：启动 → 等就绪 → 界面断言 → 真实跑一次 → 清理。
 *
 * 为什么必须合成一个进程：
 * 本环境每次命令都是独立的 shell 会话，会话一结束就回收整个进程树 ——
 * 即使子进程用了 detached + unref 也留不住。所以「分两步跑」（先启动，
 * 再验证）永远拿不到活着的窗口：第二步开始时端口已经断了。
 *
 * 把启动与验证放进同一个 Node 进程，窗口的生命周期就落在这一次调用之内。
 *
 * 用法：node scripts/verify-packaged.js
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const UNPACKED = path.join(ROOT, 'dist', 'win-unpacked');
const EXE = path.join(UNPACKED, 'VRH 视频反推.exe');
const PORT = Number(process.env.VRH_DEBUG_PORT || 9222);
const VIDEO = process.env.VRH_TEST_VIDEO || path.resolve(ROOT, '..', 'samples', 'clip.mp4');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fetchJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => { req.destroy(new Error('timeout')); });
  });
}

async function portAlive() {
  try {
    await fetchJson('/json/version');
    return true;
  } catch {
    return false;
  }
}

/** 建 CDP 连接，返回求值函数。 */
async function connect() {
  const targets = await fetchJson('/json/list');
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('未找到页面 target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();

  const evaluate = (expression, awaitPromise = true) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('CDP 求值超时'));
    }, 25000);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    ws.send(JSON.stringify({
      id, method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise },
    }));
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data.toString());
    const h = pending.get(msg.id);
    if (!h) return;
    pending.delete(msg.id);
    if (msg.result && msg.result.exceptionDetails) {
      const d = msg.result.exceptionDetails;
      h.reject(new Error((d.exception && d.exception.description) || d.text));
      return;
    }
    const r = msg.result || {};
    h.resolve(r.result && 'value' in r.result ? r.result.value : r.result);
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
  });

  return { ws, evaluate, page };
}

async function main() {
  if (!fs.existsSync(EXE)) {
    console.error(`未找到打包产物：${EXE}\n请先运行 npm run dist`);
    process.exit(1);
  }

  const results = [];
  const record = (label, pass, note = '') => {
    results.push({ label, pass, note });
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${note ? `  （${note}）` : ''}`);
  };

  // ---- 启动 ----
  const env = { ...process.env };
  delete env.NODE_OPTIONS;          // 打包应用拒绝它，见 README
  delete env.ELECTRON_RUN_AS_NODE;  // 否则退化成 Node 解释器

  const out = fs.openSync(path.join(ROOT, 'pkg-run.log'), 'w');
  const err = fs.openSync(path.join(ROOT, 'pkg-run.err'), 'w');

  console.log(`启动：${path.basename(EXE)} --debug-port=${PORT}`);
  const child = spawn(EXE, [`--debug-port=${PORT}`], {
    cwd: UNPACKED, env, detached: true, stdio: ['ignore', out, err],
  });
  child.unref();

  // ---- 等 CDP 就绪 ----
  let up = false;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await portAlive()) { up = true; break; }
    if (child.exitCode !== null) {
      console.error(`\n进程提前退出（code=${child.exitCode}），见 pkg-run.err`);
      console.error(fs.readFileSync(path.join(ROOT, 'pkg-run.err'), 'utf8').slice(0, 1500));
      process.exit(1);
    }
    await sleep(1200);
  }
  if (!up) {
    console.error('\nCDP 端口 60 秒内未就绪');
    process.exit(1);
  }
  console.log('CDP 已就绪\n');

  const { ws, evaluate, page } = await connect();
  console.log(`页面：${page.title}`);
  console.log(`URL ：${page.url}\n`);

  try {
    // ---- 1. 等界面初始化完成 ----
    console.log('=== 1. 界面初始化 ===');
    let inited = false;
    const initDeadline = Date.now() + 90000;
    while (Date.now() < initDeadline) {
      const s = await evaluate(`(() => ({
        done: document.documentElement.dataset.ready === '1',
        text: document.getElementById('statusText').textContent.trim(),
      }))()`);
      if (s && s.done) { console.log(`  初始化完成：「${s.text}」`); inited = true; break; }
      await sleep(1000);
    }
    record('界面在 90 秒内完成初始化', inited);

    const ui = await evaluate(`(() => {
      const q = (id) => document.getElementById(id);
      const banner = q('envBanner');
      return {
        statusText: q('statusText').textContent.trim(),
        statusDetail: q('statusDetail').textContent.trim(),
        bannerVisible: banner ? !banner.hidden : null,
        problems: [...document.querySelectorAll('#envBannerList li')].map((li) => li.innerText.trim()),
        repoText: q('envRepoText').textContent.trim(),
        runDisabled: q('btnRun').disabled,
        presets: [...document.querySelectorAll('#preset option')].map((o) => o.value),
        stages: [...document.querySelectorAll('.stage-label')].map((n) => n.textContent.trim()),
        command: q('commandPreview').textContent.trim(),
      };
    })()`);

    console.log(`  状态栏  ：${ui.statusText} · ${ui.statusDetail}`);
    console.log(`  harness ：${ui.repoText || '(未显示)'}`);
    console.log(`  预设    ：${ui.presets.length} 项 ${JSON.stringify(ui.presets)}`);
    console.log(`  阶段标签：${ui.stages.length} 个，全中文=${ui.stages.every((s) => /[\u4e00-\u9fa5]/.test(s))}`);

    record('找到 harness（无阻碍横幅）', ui.bannerVisible === false,
      ui.problems.length ? ui.problems[0].slice(0, 60) : '');
    record('「开始运行」可用', ui.runDisabled === false);
    record('预设已加载', ui.presets.length > 0, `${ui.presets.length} 项`);
    record('阶段标签中文完整', ui.stages.length === 5
      && ui.stages.every((s) => /[\u4e00-\u9fa5]/.test(s)));
    record('命令预览已填充', Boolean(ui.command));

    // ---- 2. 真实跑一次，验证 exe → Python 链路 ----
    console.log('\n=== 2. exe → Python 链路（真实干跑）===');

    // 先确认 harness 存在，否则后面的失败会是「视频路径不对」而不是「链路不通」
    if (!fs.existsSync(VIDEO)) {
      console.log(`  测试视频不存在，跳过：${VIDEO}`);
      record('exe 调起 Python harness', false, '缺少测试视频');
    } else {
      await evaluate(`(() => {
        const i = document.getElementById('videoPath');
        i.value = ${JSON.stringify(VIDEO)};
        i.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);

      await evaluate(`document.getElementById('btnDryRun').click()`, false);

      let dom = null;
      const runDeadline = Date.now() + 120000;
      while (Date.now() < runDeadline) {
        await sleep(3000);
        dom = await evaluate(`(() => {
          const body = document.getElementById('resultBody');
          const lines = [...document.querySelectorAll('#logBody .log-line')];
          return {
            kind: body.dataset.kind || null,
            logLines: lines.length,
            lastLogs: lines.slice(-5).map((l) => l.innerText.trim().replace(/\\s+/g, ' ')),
          };
        })()`);
        if (dom && dom.kind) break;
        process.stdout.write(`  等待中：日志 ${dom ? dom.logLines : 0} 行\r`);
      }
      console.log('');
      if (dom && dom.lastLogs) {
        console.log('  最近日志：');
        dom.lastLogs.forEach((l) => console.log(`    ${l.slice(0, 110)}`));
      }
      record('exe 调起 Python harness 并产生输出',
        Boolean(dom && dom.kind) && dom.logLines > 0,
        dom ? `结论=${dom.kind}，日志 ${dom.logLines} 行` : '超时');
    }
  } finally {
    try { ws.close(); } catch { /* 忽略 */ }
    try { child.kill(); } catch { /* 忽略 */ }
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${'='.repeat(56)}`);
  console.log(`合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  console.log('='.repeat(56));

  // 稍等一下再退，避免 Windows 上子进程句柄还没释放就退出导致的噪音。
  setTimeout(() => process.exit(failed.length ? 1 : 0), 800);
}

main().catch((e) => { console.error(`验证失败：${e.message}`); process.exit(1); });
