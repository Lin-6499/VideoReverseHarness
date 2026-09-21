'use strict';

/**
 * 「测试连接」失败时错误信息的显示验证。
 *
 * 为什么单独验：这类报错的**内容**由 verify:error-hints 保证（翻译规则命中），
 * 但**能不能被看见**是纯布局问题，读代码看不出来 —— 而这个缺陷实际发生过：
 * 结果区原本是一个 `<span>`，和「测试连接」按钮同处一个 `.row` 里，于是被
 * 按钮挤压成窄窄一列、逐字换行。服务端原文里有用的信息（`Arrearage`、
 * `#overdue-payment`）全在那 300+ 字符里，读不出来就等于没给。
 *
 * 所以这里用一条**实测抓到的真实阿里云欠费响应**做输入，断言四件事：
 *   1. 结果区占满容器宽度（不再被按钮挤压）
 *   2. 结果区在按钮下方（不争抢同一行）
 *   3. 高度受控（长报错不把后续内容挤出视野）
 *   4. 无空格长串可断行（URL / request_id / JSON 不撑破布局）
 *
 * 用 CDP 连开发态窗口，直接在页面里注入报错并读回几何信息。
 */

const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { killAndWait } = require('./lib/isolated-user-data');

const ROOT = path.resolve(__dirname, '..');
const PORT = 9231;

// 实测抓到的原文：阿里云账号欠费。保留完整形态（含 request_id 与文档锚点），
// 因为断行与宽度断言依赖「字符串足够长」这个前提。
const RAW_ARREARAGE =
  'RuntimeError: vision request failed: HTTP 400 {"error":{"message":"Access denied, '
  + 'please make sure your account is in good standing. For details, see: '
  + 'https://help.aliyun.com/zh/model-studio/error-code#overdue-payment","type":"Arrearage",'
  + '"param":null,"code":"Arrearage"},"request_id":"8605e472-81b4-9cd7-b04d-878e89847c14"}';

const HINT_ARREARAGE =
  '阿里云账号欠费（错误码 Arrearage）。请到「费用与成本」确认并充值；\n'
  + '充值后余额更新有延迟，等几分钟再试。';

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

// 提到模块作用域，好让 catch 分支也能收进程（失败路径最容易漏）。
let child = null;

(async () => {
  console.log('=== 错误信息显示验证 ===\n');

  const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  child = spawn(ELECTRON, [ROOT, `--debug-port=${PORT}`], {
    cwd: ROOT,
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
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!target) { await killAndWait(child); throw new Error('CDP 未就绪'); }

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
    if (r && r.exceptionDetails) {
      throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    }
    return r && r.result ? r.result.value : undefined;
  };

  const dl = Date.now() + 60000;
  while (Date.now() < dl) {
    if (await evaluate("document.documentElement.dataset.ready === '1'").catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 400));
  }

  // --------------------------------------------- 1. 结果区几何：不再被按钮挤压
  console.log('【1. 长报错不被挤压】');
  const layout = await evaluate(`(() => {
    const node = document.getElementById('testModelResult');
    const btn = document.getElementById('btnTestModel');
    node.className = 'test-result bad';
    // 用 JSON 传参，避免手工拼转义把 \\n 弄丢。
    node.textContent = '失败：' + ${JSON.stringify(HINT_ARREARAGE)}
      + '\\n\\n服务端原文：\\n' + ${JSON.stringify(RAW_ARREARAGE)};
    const nr = node.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    return {
      nodeWidth: Math.round(nr.width),
      rowWidth: Math.round(node.parentElement.getBoundingClientRect().width),
      btnBottom: Math.round(br.bottom),
      nodeTop: Math.round(nr.top),
      scrollH: node.scrollHeight,
      clientH: node.clientHeight,
      wrap: getComputedStyle(node).overflowWrap,
      whiteSpace: getComputedStyle(node).whiteSpace,
      scrollable: getComputedStyle(node).overflowY,
    };
  })()`);

  check('结果区占满容器宽度（不再与按钮争抢同一行）',
    layout.nodeWidth > layout.rowWidth * 0.9,
    `${layout.nodeWidth}px / 容器 ${layout.rowWidth}px`);
  check('结果区位于按钮下方',
    layout.nodeTop >= layout.btnBottom - 2,
    `按钮底 ${layout.btnBottom} / 结果顶 ${layout.nodeTop}`);

  // --------------------------------------------- 2. 高度受控但内容不丢
  console.log('\n【2. 高度受控且内容可及】');
  check('高度受控（长报错不把后续内容挤出视野）',
    layout.clientH <= 200,
    `可视高 ${layout.clientH}px，内容高 ${layout.scrollH}px`);
  check('超高时可滚动（内容仍能读到，不是被裁掉）',
    layout.scrollH <= layout.clientH || layout.scrollable === 'auto',
    `overflow-y: ${layout.scrollable}`);

  // --------------------------------------------- 3. 断行：URL / request_id 不撑破
  console.log('\n【3. 无空格长串可断行】');
  check('overflow-wrap 生效',
    layout.wrap === 'anywhere' || layout.wrap === 'break-word',
    layout.wrap);
  check('保留服务端原文里的换行（pre-wrap）',
    layout.whiteSpace === 'pre-wrap',
    layout.whiteSpace);
  check('无横向溢出（长串未撑破布局）',
    await evaluate("document.getElementById('testModelResult').scrollWidth <= "
      + "document.getElementById('testModelResult').clientWidth + 1"),
    'scrollWidth <= clientWidth');

  // --------------------------------------------- 4. 空结果不占位
  console.log('\n【4. 无结果时不占位】');
  const empty = await evaluate(`(() => {
    const node = document.getElementById('testModelResult');
    node.className = 'test-result';
    node.textContent = '';
    return getComputedStyle(node).display;
  })()`);
  check('空结果不自占空间（不留下无意义的空隙）',
    empty === 'none', `display: ${empty}`);

  ws.close();
  // 必须等它真退出：只发信号就 exit 会留下孤儿进程占住 dist/win-unpacked/，
  // 导致后续 electron-builder 打包失败（删不掉旧目录）。
  await killAndWait(child);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${'='.repeat(56)}`);
  console.log(`合计 ${results.length} 项，通过 ${passed}，失败 ${results.length - passed}`);
  console.log('='.repeat(56));
  if (passed < results.length) {
    console.log('\n未通过：');
    results.filter((r) => !r.ok).forEach((r) => console.log(`  · ${r.label}`));
  }
  process.exit(passed === results.length ? 0 : 1);
})().catch(async (error) => {
  console.error(error);
  await killAndWait(child);
  process.exit(1);
});
