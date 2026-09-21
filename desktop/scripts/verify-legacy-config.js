'use strict';

/**
 * 验证：加载「来自旧版本」的已保存配置时，界面会不会呈现自相矛盾的状态。
 *
 * 为什么值得单独验：用户实测的配置里 `model` 是旧版本存下的
 * `qwen-image-2.0-pro`，且没有 `presetId` 字段（那一版还没记录这个字段）。
 * 而 `loadSavedModelConfig()` 会先把下拉框回落到第一项（离线占位），
 * 再用保存值覆盖输入框 —— 于是「选中的服务」与「填写的模型名」可能对不上。
 * 读代码能猜到，但**界面实际长什么样必须看**。
 *
 * 做法：造一个隔离 userData，预先塞入一份「旧版本形状」的配置，
 * 启动应用，读回界面真实状态。
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { makeIsolatedUserData, cleanupIsolatedUserData, killAndWait } =
  require('./lib/isolated-user-data');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'win-unpacked', 'VRH 视频反推.exe');
const PORT = 9247;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

let child = null;
let udd = null;

function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: pathname }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

(async () => {
  if (!fs.existsSync(EXE)) {
    console.error(`找不到打包产物：${EXE}\n请先 npm run dist:zip`);
    process.exit(1);
  }

  udd = makeIsolatedUserData('legacy-config');

  /*
   * 预置一份「旧版本形状」的配置。
   *
   * 关键点：**不带 presetId** —— 这正是用户机器上那份配置的样子，
   * 它由更早的版本写入，那时还没记录 presetId。
   */
  const legacy = {
    provider: 'openai_vlm',
    model: 'qwen-image-2.0-pro',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: 'sk-legacy-shape-test',
  };
  const cfgPath = path.join(udd.dir, 'model-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(legacy, null, 2), 'utf8');
  console.log(`已预置旧版形状配置（无 presetId）\n`);

  const args = [
    `--debug-port=${PORT}`,
    ...udd.args,
  ];

  child = spawn(EXE, args, {
    cwd: path.dirname(EXE),
    stdio: 'ignore',
    /*
     * 必须清掉这两个变量。
     *
     * `ELECTRON_RUN_AS_NODE` 一旦被设置，Electron 会以**纯 Node 模式**启动 ——
     * 没有 DOM、没有渲染进程，`Runtime.evaluate` 里连 `document` 都读不到，
     * 表现为「求值返回 undefined」这种与真实原因毫不相干的症状。
     * 实测踩到过：排查了很久才发现不是 CDP 用法的问题，是进程根本没起成 GUI。
     */
    env: (() => {
      const e = { ...process.env };
      delete e.NODE_OPTIONS;
      delete e.ELECTRON_RUN_AS_NODE;
      return e;
    })(),
  });

  // 等 CDP 就绪
  const deadline = Date.now() + 90000;
  let wsUrl = null;
  while (Date.now() < deadline) {
    try {
      const list = JSON.parse(await get('/json/list'));
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!wsUrl) throw new Error('CDP 未就绪');

  // Node 22 自带全局 WebSocket，不需要 ws 包（项目里也没有这个依赖）。
  // 写法对齐 scripts/verify-model-ui.js —— 那边是跑通的，别自创。
  const ws = new WebSocket(wsUrl);
  let id = 1;
  const pending = new Map();
  await new Promise((res) => ws.addEventListener('open', res));
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) {
      pending.get(m.id).resolve(m.result);   // 注意：只 resolve m.result
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
    /*
     * 注意 CDP 的响应是**两层** result 嵌套：
     *   { id, result: { result: { type, value } } }
     * 上面 send() 已经把外层剥掉了，所以这里还要再取一层 `r.result.value`。
     * 少取一层不会报错，只会静默返回 undefined —— 相当难查。
     */
    if (r && r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`页面求值失败：${(d.exception && d.exception.description) || d.text}`);
    }
    return r && r.result ? r.result.value : undefined;
  };

  // 等界面自报就绪
  const ready = Date.now() + 90000;
  while (Date.now() < ready) {
    if (await evaluate("document.documentElement.dataset.ready === '1'").catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log('界面已就绪\n');

  // 先探明求值上下文里到底能看到什么 —— 不猜。
  console.log('【诊断：求值上下文】');
  const diag = await evaluate(`(function () {
    return {
      hasPresets: typeof PROVIDER_PRESETS !== 'undefined',
      presetCount: (typeof PROVIDER_PRESETS !== 'undefined') ? PROVIDER_PRESETS.length : -1,
      hasSel: !!document.getElementById('providerPreset'),
      ready: document.documentElement.dataset.ready || '(未设置)',
    };
  })()`);
  console.log(`    PROVIDER_PRESETS 可见：${diag.hasPresets}（${diag.presetCount} 项）`);
  console.log(`    下拉框元素存在：${diag.hasSel}`);
  console.log(`    就绪标记：${diag.ready}\n`);

  console.log('【加载旧版形状配置后的界面状态】');
  const state = await evaluate(`(function () {
    var sel = document.getElementById('providerPreset');
    var list = (typeof PROVIDER_PRESETS !== 'undefined') ? PROVIDER_PRESETS : [];
    var p = null;
    for (var i = 0; i < list.length; i++) { if (list[i].id === sel.value) { p = list[i]; break; } }
    var badge = document.getElementById('modelBadge');
    return {
      presetValue: sel.value,
      presetLabel: p ? p.label : '(未知)',
      presetModel: p ? p.model : '',
      presetBaseUrl: p ? p.baseUrl : '',
      modelInput: document.getElementById('modelName').value,
      baseUrl: document.getElementById('baseUrl').value,
      badgeText: badge ? badge.textContent : '',
      badgeClass: badge ? badge.className : '',
    };
  })()`);
  if (!state) throw new Error('页面状态读取失败（见上方诊断）');

  console.log(`    下拉框选中 ：${state.presetValue}  「${state.presetLabel}」`);
  console.log(`    该预设模型 ：${state.presetModel || '(无)'}`);
  console.log(`    模型输入框 ：${state.modelInput}`);
  console.log(`    接口地址   ：${state.baseUrl}`);
  console.log(`    角标       ：「${state.badgeText}」  class=${state.badgeClass}\n`);

  check('界面能加载旧版配置而不崩', Boolean(state.presetValue), state.presetValue);

  /*
   * 核心断言：旧版配置（无 presetId）必须能被**按 baseUrl 反推**出正确的服务。
   *
   * 修复前这里会落到第一项「离线占位」，而输入框里却留着百炼的地址与模型名 ——
   * 界面自相矛盾，用户以为在用真实模型，实际跑的是占位。
   */
  check(
    '按 baseUrl 反推出正确的服务预设（而非回落到离线占位）',
    state.presetValue === 'dashscope',
    `${state.presetValue}「${state.presetLabel}」`,
  );
  check(
    '推断出的预设与该地址自洽',
    state.presetBaseUrl === state.baseUrl,
    state.presetBaseUrl === state.baseUrl ? state.baseUrl : `预设 ${state.presetBaseUrl} vs 实际 ${state.baseUrl}`,
  );

  /*
   * 第二组：模型名是图像生成模型时必须告警。
   *
   * 用户的配置里正是 `qwen-image-2.0-pro` —— 文生图模型，不能做视觉理解。
   * 修复前界面毫无提示（只显示「通义千问」），用户只能靠测试连接失败去猜。
   *
   * 注意：这里**断言告警**，不断言自动改写 —— 静默改用户保存的值是更糟的行为。
   */
  check(
    '模型名疑似图像生成时给出告警',
    /图像生成/.test(state.badgeText),
    `角标「${state.badgeText}」`,
  );
  check(
    '告警用 bad 级（比 warn 更醒目，因为补 Key 也救不了）',
    /(^|\s)bad(\s|$)/.test(state.badgeClass),
    state.badgeClass,
  );

  // 换成正确的视觉模型名后，告警必须消失 —— 否则就是个永远红的假警报。
  const afterFix = await evaluate(`(function () {
    var inp = document.getElementById('modelName');
    inp.value = 'qwen3.8-max';
    inp.dispatchEvent(new Event('input'));
    var badge = document.getElementById('modelBadge');
    return { badgeText: badge.textContent, badgeClass: badge.className };
  })()`);
  check(
    '改成视觉模型名后告警消失（防空警报）',
    !/图像生成/.test(afterFix.badgeText),
    `角标「${afterFix.badgeText}」`,
  );

  ws.close();
  await killAndWait(child);
  cleanupIsolatedUserData(udd);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${'='.repeat(56)}`);
  console.log(`合计 ${results.length} 项，通过 ${passed}，失败 ${results.length - passed}`);
  console.log('='.repeat(56));
  process.exit(passed === results.length ? 0 : 1);
})().catch(async (error) => {
  console.error(error);
  await killAndWait(child);
  cleanupIsolatedUserData(udd);
  process.exit(1);
});
