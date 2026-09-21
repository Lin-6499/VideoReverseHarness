'use strict';

/**
 * 渲染结果验证：镜头卡片的中文标签与说明条。
 *
 * 为什么单独做：本轮改动全在渲染层（标签文案 + 说明条），
 * 而「界面有没有正确渲染」不能靠读代码确认 —— 需要在真实运行环境里
 * 把 DOM 打出来看。
 *
 * 做法：启动打包应用 → 通过 IPC 读真实产物 → 在页面内**直接调用渲染函数**
 * （renderShotCards 是渲染层的函数，挂在内联脚本的顶层作用域上，页面内可访问）
 * → dump 生成的 DOM 文本与关键属性。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'win-unpacked', 'VRH 视频反推.exe');
const PORT = 9225;

function httpJson(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
  });
}

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok });
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
}

(async () => {
  console.log('=== 镜头卡片渲染验证 ===\n');

  const child = spawn(EXE, [`--debug-port=${PORT}`], {
    cwd: path.dirname(EXE),
    stdio: 'ignore',
    env: (() => {
      const e = { ...process.env };
      delete e.NODE_OPTIONS;
      delete e.ELECTRON_RUN_AS_NODE;
      return e;
    })(),
  });

  let target = null;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const list = await httpJson(PORT, '/json/list');
      target = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!target) { console.log('CDP 未就绪'); child.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 1;
  const pending = new Map();
  await new Promise((res) => ws.addEventListener('open', res));
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) {
      const { resolve } = pending.get(m.id);
      pending.delete(m.id);
      resolve(m.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const i = id++;
    pending.set(i, { resolve });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) throw new Error(r.exceptionDetails.text || '求值异常');
    return r && r.result ? r.result.value : undefined;
  };

  // 等界面就绪
  const dl = Date.now() + 90000;
  while (Date.now() < dl) {
    const r = await evaluate("document.documentElement.dataset.ready === '1'").catch(() => false);
    if (r) break;
    await new Promise((r2) => setTimeout(r2, 500));
  }
  console.log('界面已就绪\n');

  // 找一个有产物的视频
  const outRoot = 'D:/HarnessTest/output';
  let videoPath = null;
  for (const vid of fs.readdirSync(outRoot)) {
    const meta = path.join(outRoot, vid, 'meta.json');
    if (!fs.existsSync(meta)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
      const c = m.video_path || m.path;
      if (c && fs.existsSync(c)) { videoPath = c; break; }
    } catch { /* 跳过 */ }
  }
  if (!videoPath) { console.log('未找到可用视频'); child.kill(); process.exit(1); }
  console.log(`使用视频：${videoPath}\n`);

  // 读产物并渲染
  const setup = `(async () => {
    const art = await window.vrh.artifacts(${JSON.stringify(videoPath)});
    if (!art || !art.exists) return { error: '无产物' };
    // renderShotCards 是渲染层顶层函数，页面内可直接调用 —— 这正是我们要测的代码路径。
    renderShotCards(art);
    const list = document.getElementById('shotList');
    return {
      cardCount: art.shotCards.length,
      innerText: list.innerText,
      noticeText: (list.querySelector('.shot-lang-note') || {}).innerText || null,
      firstSlotHtml: (list.querySelector('.shot-slots') || {}).innerHTML || null,
      slotTitles: [...list.querySelectorAll('.shot-slots span')].map(s => s.title),
      boldLabels: [...list.querySelectorAll('.shot-slots span b')].map(b => b.textContent),
      /*
       * 提示词正文。用产物里的**真实 prompt 值**去 DOM 里定位，
       * 而不是猜关键词 —— 猜的词可能同时出现在别处，那样验的就不是提示词了。
       */
      promptLines: art.shotCards
        .map((c) => c.prompt)
        .filter(Boolean)
        .filter((p) => (list.innerText || '').includes(p)),
    };
  })()`;
  const out = await evaluate(setup);

  if (out && out.error) { console.log(`失败：${out.error}`); ws.close(); child.kill(); process.exit(1); }

  console.log(`镜头卡片数：${out.cardCount}`);
  console.log('\n--- 说明条 ---');
  console.log(out.noticeText);
  console.log('\n--- 第一张卡片的槽位 ---');
  console.log(out.firstSlotHtml);
  console.log('\n--- 校验 ---');

  // 1. 说明条存在且说清了「英文是有意为之」
  check('说明条已渲染', Boolean(out.noticeText));
  check('说明条明确「英文是有意为之」', /有意为之/.test(out.noticeText || ''));
  check('说明条说明了原因（投喂给生成模型）', /生成模型/.test(out.noticeText || ''));
  check('说明条警示「改成中文会降低质量」', /中文.*降低|降低.*质量/.test(out.noticeText || ''));

  // 2. 槽位标签已中文化
  const expectedLabels = ['主体', '动作', '场景', '运镜', '光照', '风格'];
  const labels = out.boldLabels || [];
  console.log(`   实际标签：${labels.join(' / ')}`);
  check('槽位标签全部为中文', labels.length > 0 && labels.every((l) => /^[\u4e00-\u9fa5]+$/.test(l)),
    labels.join('/'));
  check('包含全部六个槽位标签', expectedLabels.every((e) => labels.includes(e)));

  /*
   * 3. 界面上不应再出现裸的英文键名（形如 `subject:`）。
   *
   * 注意 innerText 不含 title 属性的值，所以「tooltip 里保留英文键名」不会
   * 让这条误报 —— 这两条断言验的正是同一个设计的两面。
   */
  const bareKeys = ['subject', 'action', 'scene', 'camera', 'lighting', 'style']
    .filter((k) => new RegExp(`(^|[^A-Za-z])${k}\\s*:`, 'm').test(out.innerText || ''));
  check('界面上不再出现英文键名（如 subject:）', bareKeys.length === 0, bareKeys.join(','));

  // 4. 英文键名保留在 tooltip 里，便于对照产物
  const titles = out.slotTitles || [];
  check('英文键名保留在 tooltip（可对照产物）',
    titles.length > 0 && titles.some((t) => /subject|action|scene/.test(t)),
    titles[0] || '');

  /*
   * 5. 提示词内容本身仍是英文（不能被误改）。
   *
   * 这条断言有两个失败模式必须同时防住，否则会「假通过」：
   *   a) 过滤后得到空串 —— 空串当然不含中文，断言恒真。所以必须**先断言
   *      确实取到了行**，再判断这些行里没有中文。
   *   b) 取到的不是提示词 —— 用 prompt 的**真实内容**去定位行，而不是用
   *      `walking` 这种同时出现在 slots 值和说明条里的词。
   */
  const promptLines = out.promptLines || [];
  check('取到了提示词行（否则下一条断言会假通过）', promptLines.length > 0,
    `${promptLines.length} 行`);
  check('提示词内容仍为英文（未被误改）',
    promptLines.length > 0 && promptLines.every((l) => !/[\u4e00-\u9fa5]/.test(l)),
    promptLines[0] ? promptLines[0].slice(0, 60) : '');

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${'='.repeat(50)}`);
  console.log(`合计 ${results.length} 项，通过 ${passed}，失败 ${results.length - passed}`);
  console.log('='.repeat(50));
  if (passed < results.length) {
    console.log('\n未通过：');
    results.filter((r) => !r.ok).forEach((r) => console.log(`  · ${r.label}`));
  }

  ws.close();
  child.kill('SIGTERM');
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
