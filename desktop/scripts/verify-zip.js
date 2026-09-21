'use strict';

/**
 * 端到端验收：把交付的 zip 解压到干净目录，从解压出来的副本启动程序，
 * 验证「用户拿到手的那份东西」真的能用。
 *
 * 为什么必须解压后再试：直接测 dist/win-unpacked 只证明「构建产物是对的」，
 * 不证明「压缩包是对的」。两者之间的差异正是踩过的地方 ——
 * 曾经交付过一个 281MB、扩展名叫 .zip 但实际是 tar 流的文件，
 * 以及一个漏掉放置说明的包。所以验收口径是「解压后能用」。
 *
 * 用法：node scripts/verify-zip.js
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const pkg = require('../package.json');
const ZIP = path.join(DIST, `VRH-desktop-${pkg.version}-portable.zip`);

// 解压目的地：用一个明确的临时目录，测完保留（便于人工查看），不自动删。
const OUT = path.join(ROOT, '.verify-extract');
const PORT = Number(process.env.VRH_DEBUG_PORT || 9223);
const SRC_HARNESS = path.resolve(ROOT, '..');   // 真实 harness 根

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

async function main() {
  const results = [];
  const record = (label, pass, note = '') => {
    results.push({ label, pass });
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${note ? `  （${note}）` : ''}`);
  };

  if (!fs.existsSync(ZIP)) {
    console.error(`未找到 zip：${ZIP}\n请先运行 npm run dist:zip`);
    process.exit(1);
  }

  // ---- 1. 文件头验真 ----
  console.log('=== 1. 交付文件本身 ===');
  const sizeMb = (fs.statSync(ZIP).size / 1024 / 1024).toFixed(1);
  const fd = fs.openSync(ZIP, 'r');
  const head = Buffer.alloc(4);
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  console.log(`  ${path.basename(ZIP)}  ${sizeMb} MB  文件头 ${head.toString('hex')}`);
  record('是有效的 zip（PK\\x03\\x04）', isZip, isZip ? '' : `实际 ${head.toString('hex')}`);

  // ---- 2. 解压到干净目录 ----
  console.log('\n=== 2. 解压到干净目录 ===');
  // 先确保目录是空的。用 Node 原生递归删（清的是本脚本自己的临时目录）。
  if (fs.existsSync(OUT)) {
    fs.rmSync(OUT, { recursive: true, force: true });
  }
  fs.mkdirSync(OUT, { recursive: true });

  try {
    execFileSync('unzip', ['-q', '-o', ZIP, '-d', OUT], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    console.error(`解压失败：${error.stderr ? error.stderr.toString() : error.message}`);
    process.exit(1);
  }

  const exePath = fs.readdirSync(OUT).find((f) => f.toLowerCase().endsWith('.exe'));
  const noticeName = fs.readdirSync(OUT).find((f) => f.endsWith('.txt') && f !== 'LICENSE.electron.txt');
  const asarPath = path.join(OUT, 'resources', 'app.asar');

  console.log(`  可执行文件：${exePath || '(缺失)'}`);
  console.log(`  放置说明  ：${noticeName || '(缺失)'}`);
  record('解压后根目录就是程序（无多余层级）', Boolean(exePath));
  record('放置说明在根目录', Boolean(noticeName));
  record('asar 存在', fs.existsSync(asarPath));
  if (!exePath) { console.error('无可执行文件，中止'); process.exit(1); }

  const EXE = path.join(OUT, exePath);

  // ---- 3. 挂 harness（用 junction 指向真实 harness）----
  console.log('\n=== 3. 放置 harness 并启动 ===');
  const linkPath = path.join(OUT, 'harness');
  try {
    // mklink /J 需要 cmd；这里用 fs.symlinkSync 的 'junction' 类型，无需 cmd。
    fs.symlinkSync(SRC_HARNESS, linkPath, 'junction');
    console.log(`  已把 harness 联接到：${linkPath}`);
    record('可在程序同级放置 harness', true);
  } catch (error) {
    console.log(`  联接失败：${error.message}`);
    record('可在程序同级放置 harness', false, error.message.slice(0, 50));
  }

  // ---- 4. 启动并验证 ----
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;

  const out = fs.openSync(path.join(ROOT, 'zip-verify.log'), 'w');
  const err = fs.openSync(path.join(ROOT, 'zip-verify.err'), 'w');

  const child = spawn(EXE, [`--debug-port=${PORT}`], {
    cwd: OUT, env, detached: true, stdio: ['ignore', out, err],
  });
  child.unref();

  let up = false;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try { await fetchJson('/json/version'); up = true; break; } catch { await sleep(1200); }
  }
  if (!up) {
    console.error('CDP 未就绪，见 zip-verify.err');
    console.error(fs.readFileSync(path.join(ROOT, 'zip-verify.err'), 'utf8').slice(0, 800));
    record('解压后的程序能启动', false);
    process.exit(1);
  }
  console.log('  CDP 已就绪');
  record('解压后的程序能启动', true);

  // 连上读界面
  const targets = await fetchJson('/json/list');
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const evaluate = (expression, awaitPromise = true) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('求值超时')); }, 25000);
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
    ws.addEventListener('error', () => reject(new Error('WS 连接失败')));
  });

  try {
    console.log('\n=== 4. 界面初始化 ===');
    let inited = false;
    const initDeadline = Date.now() + 90000;
    while (Date.now() < initDeadline) {
      if (await evaluate(`document.documentElement.dataset.ready === '1'`)) { inited = true; break; }
      await sleep(1000);
    }
    record('解压副本完成初始化', inited);

    const ui = await evaluate(`(() => {
      const q = (id) => document.getElementById(id);
      const banner = q('envBanner');
      return {
        status: q('statusText').textContent.trim(),
        detail: q('statusDetail').textContent.trim(),
        banner: banner ? !banner.hidden : null,
        problems: [...document.querySelectorAll('#envBannerList li')].map((li) => li.innerText.trim()),
        repo: q('envRepoText').textContent.trim(),
        presets: [...document.querySelectorAll('#preset option')].map((o) => o.value),
      };
    })()`);
    console.log(`  状态：${ui.status} · ${ui.detail}`);
    console.log(`  harness：${ui.repo || '(未显示)'}`);
    if (ui.problems.length) ui.problems.forEach((p) => console.log(`  问题：${p.split('\n')[0]}`));
    record('解压副本找到同级 harness', ui.banner === false);
    record('预设已加载', ui.presets.length > 0, `${ui.presets.length} 项`);
  } finally {
    try { ws.close(); } catch { /* 忽略 */ }
    try { child.kill(); } catch { /* 忽略 */ }
  }

  // ---- 清理联接（必须用 rmdir 语义，绝不能用递归删除穿透）----
  try {
    if (fs.existsSync(linkPath) && fs.lstatSync(linkPath).isSymbolicLink()) {
      fs.unlinkSync(linkPath);
      console.log('\n已移除联接（harness 本体未受影响）');
    }
  } catch { /* 忽略 */ }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${'='.repeat(56)}`);
  console.log(`合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  console.log('='.repeat(56));
  console.log(`解压副本保留在：${OUT}`);
  setTimeout(() => process.exit(failed.length ? 1 : 0), 800);
}

main().catch((e) => { console.error(`验收失败：${e.message}`); process.exit(1); });
