'use strict';

/**
 * 打包态「测试连接」验证。
 *
 * 这是本轮最需要从**打包产物**验证的一条路径 —— 它依赖 `src/main/test-model.py`，
 * 而 `build.files` 的 glob 很容易漏掉非 JS 文件。开发态能跑、打包态静默失败，
 * 是这类缺陷的典型形态。
 *
 * 验证口径：
 *   1. 离线占位：应返回「可用且未发请求」（证明 IPC 链路通，且没白白请求网络）
 *   2. 真实 provider + 不可达地址：**必须是可读的失败**，而不是「找不到文件」
 *      —— 后者说明脚本没打进包，前者说明脚本正常执行、错误语义正确
 *
 * 只做这两种，因为它们能区分「链路通」与「脚本缺失」，不需要真实 Key。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const {
  makeIsolatedUserData,
  cleanupIsolatedUserData,
  killAndWait,
} = require('./lib/isolated-user-data');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'win-unpacked', 'VRH 视频反推.exe');
const PORT = 9228;

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

// 提到模块作用域，好让 catch 分支也能收进程 + 清理临时目录。
let udd = null;
let child = null;

(async () => {
  console.log('=== 打包态「测试连接」验证 ===\n');

  if (!fs.existsSync(EXE)) {
    console.log(`可执行文件不存在：${EXE}`);
    process.exit(1);
  }

  /*
   * 必须隔离 userData：第 4 段要验「保存 → 读回」的持久化，会往配置里写
   * 测试 Key。不隔离就会**覆盖用户真实保存的 API Key**。
   * 详见 lib/isolated-user-data.js 的说明。
   */
  udd = makeIsolatedUserData('model-packaged-ui');
  child = spawn(EXE, [`--debug-port=${PORT}`, ...udd.args], {
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
      pending.get(m.id).resolve(m.result);
      pending.delete(m.id);
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const i = id++;
    pending.set(i, { resolve });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r && r.exceptionDetails) throw new Error(r.exceptionDetails.text || '求值异常');
    return r && r.result ? r.result.value : undefined;
  };

  const dl = Date.now() + 90000;
  while (Date.now() < dl) {
    if (await evaluate("document.documentElement.dataset.ready === '1'").catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log('界面已就绪\n');

  // --------------------------------------- 1. 打包态界面含模型面板
  console.log('【1. 打包态界面含模型面板】');
  const panel = await evaluate(`({
    group: Boolean(document.getElementById('groupModel')),
    options: document.getElementById('providerPreset').options.length,
    testBtn: Boolean(document.getElementById('btnTestModel')),
  })`);
  check('「模型设置」面板存在', panel.group);
  check('服务下拉已填充', panel.options >= 6, `${panel.options} 项`);
  check('「测试连接」按钮存在', panel.testBtn);

  // ----------------------------------------- 2. 离线占位：IPC 链路通
  console.log('\n【2. 离线占位（不发网络请求）】');
  const fakeResult = await evaluate(`(async () => {
    const sel = document.getElementById('providerPreset');
    sel.value = 'fake';
    sel.dispatchEvent(new Event('change'));
    return await window.vrh.testModel(readModelConfig());
  })()`);
  check('IPC 调用返回了结果（链路通）', fakeResult && typeof fakeResult.ok === 'boolean');
  check('离线占位判定为可用', fakeResult.ok === true, fakeResult.detail || '');
  check('明确说明未发网络请求', /不|未/.test(fakeResult.detail || ''), fakeResult.detail || '');

  // ------------- 3. 真实 provider：必须是可读报错，而非「找不到文件」
  console.log('\n【3. 真实 provider + 不可达地址】');
  const realResult = await evaluate(`(async () => {
    const cfg = {
      provider: 'openai_vlm',
      model: 'test-model',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-not-real',
    };
    return await window.vrh.testModel(cfg);
  })()`);
  check('真实 provider 判定为失败（符合预期）', realResult.ok === false);
  const msg = realResult.message || '';
  check('脚本确实被打进包（不是「找不到文件」）',
    !/can't open file|No such file|找不到.*test-model/i.test(msg),
    msg.slice(0, 90));
  check('报错来自网络层（说明脚本正常执行）',
    /HTTP|connect|refused|拒绝|Transport/i.test(msg), msg.slice(0, 90));

  // 定位这类失败时，**截断的报错会害人** —— 90 字符恰好把「路径是 app.asar 还是
  // app.asar.unpacked」这段最关键的信息裁掉了，导致多排查一轮。所以这里在失败时
  // 直接打全文，成功时保持精简。
  if (!results[results.length - 2].ok || !results[results.length - 1].ok) {
    console.log('\n  ── 完整报错（未截断，便于定位）──');
    console.log(msg);
    console.log('  ── 完整报错结束 ──');
  }

  // ------------------------------------- 4. 配置持久化在打包态可用
  console.log('\n【4. 配置持久化（打包态）】');
  const persist = await evaluate(`(async () => {
    const saved = await window.vrh.saveModelConfig({
      provider: 'gemini_vlm', model: 'gemini-2.5-flash', baseUrl: '', apiKey: 'sk-persist-test',
    });
    const back = await window.vrh.loadModelConfig();
    return { saved, back };
  })()`);
  check('保存成功', persist.saved && persist.saved.ok === true, JSON.stringify(persist.saved));
  check('能读回', Boolean(persist.back), persist.back ? persist.back.model : '');
  check('读回内容一致（含 Key）',
    persist.back && persist.back.apiKey === 'sk-persist-test');

  // 收尾：清掉刚写入的测试配置，别把假 Key 留在用户目录里
  await evaluate(`window.vrh.saveModelConfig({ provider: 'fake', model: '', baseUrl: '', apiKey: '' })`);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${'='.repeat(56)}`);
  console.log(`合计 ${results.length} 项，通过 ${passed}，失败 ${results.length - passed}`);
  console.log('='.repeat(56));
  if (passed < results.length) {
    console.log('\n未通过：');
    results.filter((r) => !r.ok).forEach((r) => console.log(`  · ${r.label}`));
  }

  ws.close();
  await killAndWait(child);          // 必须等它真退出，否则留下孤儿进程占住 dist/
  cleanupIsolatedUserData(udd);
  process.exit(passed === results.length ? 0 : 1);
})().catch(async (error) => {
  console.error(error);
  // 失败路径同样要收进程 —— 这是最容易漏、也最容易留下孤儿的地方。
  await killAndWait(child);
  cleanupIsolatedUserData(udd);
  process.exit(1);
});
