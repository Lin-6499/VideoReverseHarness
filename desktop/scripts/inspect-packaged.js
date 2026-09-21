'use strict';

/**
 * 通过 CDP 读取运行中界面的实际 DOM 状态。
 *
 * 打包后的 exe 没有 --smoke 之类的诊断开关（那些脚本已被排除在 asar 之外），
 * 所以这里从外部连 CDP 观察 —— 等于「用调试器看进程内部」，比看截图更硬：
 * 能直接读到状态栏文案、环境横幅是否显示、以及 doctor() 返回了什么。
 *
 * 用法：
 *   node scripts/launch-packaged-detached.js   # 带 --debug-port=9222 启动
 *   node scripts/inspect-packaged.js
 */

const http = require('http');

const PORT = Number(process.env.CDP_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fetchJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('请求超时')));
  });
}

/**
 * 等界面完成初始化再断言。
 *
 * 曾经的教训：这个脚本一开始是「连上就读 DOM」，于是冷启动时读到的是
 * 「正在探测环境…」的中间态，预设与命令预览都还是空的，判定随机失败 ——
 * 同一份产物有时 5/5 通过、有时 2 项失败，看起来像功能不稳定，
 * 实际是测试没等。
 *
 * 第一次修也没修对：改成等 statusDot 不再 busy，但状态点变绿只代表
 * **环境探测**回来了，预设与命令预览还要再过两个 await 才填。于是仍然
 * 会读到中间态。
 *
 * 真正的解法是让界面给出语义正确的完成信号：`<html data-ready="1">`
 * 由 renderer 的 init() 在最后一步设置。这里等它，而不是猜某个视觉线索。
 */
const READY_PROBE = `(() => {
  const done = document.documentElement.dataset.ready === '1';
  const txt = document.getElementById('statusText');
  const dot = document.getElementById('statusDot');
  return {
    done,
    busy: dot ? dot.classList.contains('busy') : true,
    text: txt ? txt.textContent.trim() : '',
  };
})()`;

const PROBE = `(() => {
  const q = (id) => document.getElementById(id);
  const text = (id) => { const n = q(id); return n ? n.textContent.trim() : null; };

  const banner = q('envBanner');
  const problems = [...document.querySelectorAll('#envBannerList li')].map((li) => li.innerText.trim());

  return {
    statusText: text('statusText'),
    statusDetail: text('statusDetail'),
    statusDot: (q('statusDot') || {}).className || null,
    bannerVisible: banner ? !banner.hidden : null,
    bannerTitle: text('envBannerTitle'),
    problems,
    repoRowVisible: q('envRepoRow') ? !q('envRepoRow').hidden : null,
    repoText: text('envRepoText'),
    runDisabled: q('btnRun') ? q('btnRun').disabled : null,
    presetOptions: [...document.querySelectorAll('#preset option')].map((o) => o.value),
    stageLabels: [...document.querySelectorAll('.stage-label')].map((n) => n.textContent.trim()),
    commandPreview: text('commandPreview'),
    logCount: text('logCount'),
  };
})()`;

/** 建一次 CDP 连接，暴露一个带 id 的求值函数。 */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data.toString());
    const h = pending.get(msg.id);
    if (!h) return;
    pending.delete(msg.id);
    if (msg.result && msg.result.exceptionDetails) {
      h.reject(new Error(JSON.stringify(msg.result.exceptionDetails).slice(0, 300)));
      return;
    }
    // Runtime.evaluate 的结果在 result.result.value；Page.* 则直接是 result。
    const r = msg.result || {};
    h.resolve(r.result && 'value' in r.result ? r.result.value : r.result);
  });

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
  });

  const evalJs = (expression, timeoutMs = 20000) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP 求值超时')); }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    ws.send(JSON.stringify({
      id, method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: false },
    }));
  });

  return { ws, ready, evalJs };
}

async function main() {
  // 找到渲染进程的 target —— 打包应用会有多个 target，取 type=page 的那个。
  const targets = await fetchJson('/json/list');
  const page = targets.find((t) => t.type === 'page') || targets[0];
  if (!page || !page.webSocketDebuggerUrl) {
    console.error('未找到可调试的页面 target：', JSON.stringify(targets, null, 2));
    process.exit(1);
  }

  console.log(`目标页面：${page.title || '(无标题)'}`);
  console.log(`URL     ：${page.url}\n`);

  // 用 Node 22 内置的 WebSocket，不引入 ws 依赖 —— 诊断脚本不该再拖一个包。
  const { ws, ready, evalJs } = connect(page.webSocketDebuggerUrl);
  await ready;

  // ---- 等环境探测完成（否则读到的是中间态）----
  const deadline = Date.now() + 90000;
  let last = '';
  let settled = false;
  while (Date.now() < deadline) {
    let state;
    try {
      state = await evalJs(READY_PROBE, 8000);
    } catch (e) {
      console.log(`（求值重试：${e.message}）`);
      await sleep(1500);
      continue;
    }
    last = state && state.text;
    if (state && state.done) { settled = true; break; }
    await sleep(1000);
  }
  if (!settled) {
    console.log(`警告：界面初始化在 90 秒内未完成，当前状态「${last}」—— 断言结果仅供参考\n`);
  } else {
    console.log(`界面初始化完成：「${last}」\n`);
  }

  const result = await evalJs(PROBE);
  ws.close();

  console.log('=== 打包应用界面状态 ===\n');
  console.log(`状态栏文案    ：${result.statusText}`);
  console.log(`状态栏细节    ：${result.statusDetail || '(空)'}`);
  console.log(`状态指示灯    ：${result.statusDot}`);
  console.log(`环境横幅可见  ：${result.bannerVisible}`);
  console.log(`横幅标题      ：${result.bannerTitle || '(隐藏)'}`);
  console.log(`目录行可见    ：${result.repoRowVisible}`);
  console.log(`目录显示      ：${result.repoText || '(空)'}`);
  console.log(`开始运行禁用  ：${result.runDisabled}`);
  console.log(`预设项数      ：${result.presetOptions.length} ${JSON.stringify(result.presetOptions)}`);
  console.log(`阶段标签      ：${JSON.stringify(result.stageLabels)}`);
  console.log(`命令预览      ：${(result.commandPreview || '(空)').slice(0, 120)}`);
  console.log(`日志行数      ：${result.logCount}`);

  if (result.problems.length) {
    console.log(`\n问题列表：`);
    result.problems.forEach((p) => console.log(`  · ${p.replace(/\n/g, '\n    ')}`));
  }

  // 判定
  console.log('\n=== 判定 ===');
  const checks = [
    ['找到了 harness（未显示阻碍横幅）', result.bannerVisible === false],
    ['「开始运行」可用', result.runDisabled === false],
    ['预设已加载', result.presetOptions.length > 0],
    ['阶段标签已渲染且为中文', result.stageLabels.length === 5
      && result.stageLabels.every((s) => /[\u4e00-\u9fa5]/.test(s))],
    ['命令预览已填充', Boolean(result.commandPreview && result.commandPreview.trim())],
  ];
  let failed = 0;
  for (const [label, pass] of checks) {
    if (!pass) failed += 1;
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`);
  }
  console.log(`\n${failed === 0 ? '通过 —— 打包应用在 exe 同级找到 harness 并正常初始化' : `失败 —— ${failed} 项不符合预期`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`验证失败：${error.message}`);
  console.error('（确认 exe 已用 --debug-port=9222 启动）');
  process.exit(1);
});
