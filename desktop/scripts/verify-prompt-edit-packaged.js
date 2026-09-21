'use strict';

/**
 * 打包态验证「编辑提示词 → 保存 → 落盘」。
 *
 * 为什么需要单独一个：verify-packaged.js 只证明「看得见 + 跑得动」，
 * 但提示词编辑是本轮新增的功能，界面在打包后能否真的把改动写进
 * prompt.json，必须实测 —— 它的关键路径（dataset → IPC → 文件写入）
 * 有一半在渲染层，打包不会改变渲染层代码，但会改变路径解析，
 * 而保存功能恰恰依赖 repoRoot 的解析结果。
 *
 * 与 verify-packaged.js 一样，启动、验证、还原必须在同一个进程里完成
 * （会话结束会回收进程树）。
 *
 * 用法：node scripts/verify-prompt-edit-packaged.js
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { killAndWait } = require('./lib/isolated-user-data');

const ROOT = path.resolve(__dirname, '..');

// 提到模块作用域，好让 main 的 catch 分支也能收进程（失败路径最容易漏）。
let child = null;
const UNPACKED = path.join(ROOT, 'dist', 'win-unpacked');
const EXE = path.join(UNPACKED, 'VRH 视频反推.exe');
const PORT = Number(process.env.VRH_DEBUG_PORT || 9222);
const VIDEO = process.env.VRH_TEST_VIDEO || path.resolve(ROOT, '..', 'samples', 'clip.mp4');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// harness 的输出目录按 sha256(小写绝对路径)[:12] 命名 —— 必须与算法保持一致，
// 否则测试会去读一个不存在的目录，然后把「文件没变」误判成功能坏了。
const videoId = (p) => require('crypto').createHash('sha256')
  .update(path.resolve(p).toLowerCase(), 'utf8').digest('hex').slice(0, 12);

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

async function connect() {
  const targets = await fetchJson('/json/list');
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('未找到页面 target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();

  const evaluate = (expression, awaitPromise = true) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP 求值超时')); }, 25000);
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
  return { ws, evaluate };
}

async function main() {
  const results = [];
  const record = (label, pass, note = '') => {
    results.push({ label, pass });
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${note ? `  （${note}）` : ''}`);
  };

  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;

  const out = fs.openSync(path.join(ROOT, 'pkg-prompt.log'), 'w');
  const err = fs.openSync(path.join(ROOT, 'pkg-prompt.err'), 'w');

  console.log('启动打包应用…');
  child = spawn(EXE, [`--debug-port=${PORT}`], {
    cwd: UNPACKED, env, detached: true, stdio: ['ignore', out, err],
  });
  child.unref();

  const deadline = Date.now() + 60000;
  let up = false;
  while (Date.now() < deadline) {
    try { await fetchJson('/json/version'); up = true; break; } catch { await sleep(1200); }
  }
  if (!up) { console.error('CDP 未就绪'); process.exit(1); }
  console.log('CDP 已就绪\n');

  const { ws, evaluate } = await connect();

  try {
    // ---- 等初始化 ----
    let inited = false;
    const initDeadline = Date.now() + 90000;
    while (Date.now() < initDeadline) {
      const s = await evaluate(`document.documentElement.dataset.ready === '1'`);
      if (s === true) { inited = true; break; }
      await sleep(1000);
    }
    if (!inited) { console.error('界面未完成初始化，中止'); process.exit(1); }

    // ---- 跑一次，让镜头卡出现（顶部要有结果才可编辑）----
    console.log('=== 准备：真实干跑一次以生成镜头卡 ===');
    await evaluate(`(() => {
      const i = document.getElementById('videoPath');
      i.value = ${JSON.stringify(VIDEO)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await evaluate(`document.getElementById('btnDryRun').click()`, false);

    let cards = 0;
    const runDeadline = Date.now() + 120000;
    while (Date.now() < runDeadline) {
      await sleep(2500);
      cards = await evaluate(`document.querySelectorAll('#shotList .shot-card').length`);
      if (cards > 0) break;
    }
    console.log(`  镜头卡 ${cards} 张\n`);
    record('运行后有镜头卡可编辑', cards > 0, `${cards} 张`);
    if (cards === 0) throw new Error('无镜头卡，无法验证编辑');

    // ---- 编辑 + 保存 ----
    console.log('=== 编辑提示词并保存 ===');
    const promptPath = path.join(UNPACKED, 'harness', 'output', videoId(VIDEO), 'prompt.json');
    const before = JSON.parse(fs.readFileSync(promptPath, 'utf8'));
    const original = before.shots[0].prompt;
    const backupPath = `${promptPath}.bak`;
    // 清掉可能残留的备份，保证「本次是否生成备份」的判定有效
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);

    const opened = await evaluate(`(() => {
      const card = document.querySelector('#shotList .shot-card');
      card.querySelector('.shot-edit-toggle').click();
      const input = card.querySelector('[data-field="prompt"]');
      input.value = '【打包态验证】' + Date.now();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return {
        editVisible: !card.querySelector('.shot-prompt-edit').hidden,
        dirty: card.classList.contains('dirty'),
        saveBarVisible: !document.getElementById('promptSaveBar').hidden,
        saveCount: document.getElementById('promptSaveCount').textContent,
        typed: input.value,
      };
    })()`);
    console.log(`  展开=${opened.editVisible} 已改=${opened.dirty} 保存栏=${opened.saveBarVisible} 「${opened.saveCount}」`);
    record('编辑区可展开', opened.editVisible);
    record('改动被标记', opened.dirty);
    record('保存栏出现', opened.saveBarVisible);

    await evaluate(`document.getElementById('btnSavePrompt').click()`, false);
    // 等保存栏收起（说明写完了）
    let saved = false;
    const saveDeadline = Date.now() + 25000;
    while (Date.now() < saveDeadline) {
      if (await evaluate(`document.getElementById('promptSaveBar').hidden`)) { saved = true; break; }
      await sleep(500);
    }
    record('保存流程完成（保存栏收起）', saved);

    // 读模态内容，然后关掉 —— 不关会挡住后续操作
    const notice = await evaluate(`(() => {
      const d = document.getElementById('errorDialog');
      return {
        open: d.open,
        title: document.getElementById('errorDialogTitle').textContent,
        body: document.getElementById('errorDialogRaw').textContent.slice(0, 120),
      };
    })()`);
    console.log(`  保存提示：「${notice.title}」`);
    if (notice.open) {
      await evaluate(`(() => { document.getElementById('errorDialog').close(); return true; })()`, false);
      await sleep(300);
    }
    record('保存后给出成功提示', notice.title.includes('保存完成'),
      notice.title.includes('失败') ? notice.body : '');

    // ---- 决定性证据：读回磁盘 ----
    const after = JSON.parse(fs.readFileSync(promptPath, 'utf8'));
    const written = after.shots[0].prompt;
    const changedOnDisk = written === opened.typed;
    console.log(`  落盘核对：${changedOnDisk ? '一致' : `不一致（磁盘="${String(written).slice(0, 40)}"）`}`);
    record('prompt.json 内容真的变了', changedOnDisk);
    record('首次保存生成了 .bak 备份', fs.existsSync(backupPath));

    // ---- 还原 ----
    const restored = await evaluate(`(() => {
      const card = document.querySelector('#shotList .shot-card');
      if (card.querySelector('.shot-prompt-edit').hidden) card.querySelector('.shot-edit-toggle').click();
      const input = card.querySelector('[data-field="prompt"]');
      input.value = ${JSON.stringify(original)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    if (restored) {
      await evaluate(`document.getElementById('btnSavePrompt').click()`, false);
      const rd = Date.now() + 25000;
      while (Date.now() < rd) {
        if (await evaluate(`document.getElementById('promptSaveBar').hidden`)) break;
        await sleep(500);
      }
      await evaluate(`(() => { const d = document.getElementById('errorDialog'); if (d.open) d.close(); return true; })()`, false);
      await sleep(500);
      const back = JSON.parse(fs.readFileSync(promptPath, 'utf8'));
      record('改动已还原（不留测试污染）', back.shots[0].prompt === original);
    }

    // 收尾：清掉测试产生的备份
    try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch { /* 忽略 */ }
  } finally {
    try { ws.close(); } catch { /* 忽略 */ }
    await killAndWait(child);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${'='.repeat(56)}`);
  console.log(`合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  console.log('='.repeat(56));
  // 已经 await 过进程退出，不需要再靠 setTimeout 拖延。
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await killAndWait(child);
  process.exit(1);
});
