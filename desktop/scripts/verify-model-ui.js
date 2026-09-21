'use strict';

/**
 * 模型设置界面的渲染验证。
 *
 * 为什么单独验：模型面板的显隐逻辑是多分支的（离线占位隐藏 Key 框、切换服务
 * 预填不同默认值），而「界面上到底显示了什么」读代码看不出来。尤其要确认
 * **离线占位下不显示 Key 输入框** —— 显示一个空的必填框会让人以为不填就不能跑，
 * 这会把「跑通流程」这个最简单的入门路径挡在门外。
 *
 * 用 CDP 连开发态窗口，直接在页面里操作 DOM 并读回结果。
 *
 * **必须隔离 userData**：本脚本会往 Key 输入框填占位值，而输入框的 input
 * 监听器会立刻持久化 —— 不隔离就会覆盖用户真实保存的 API Key（实测发生过）。
 */

const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const {
  makeIsolatedUserData,
  cleanupIsolatedUserData,
} = require('./lib/isolated-user-data');

const ROOT = path.resolve(__dirname, '..');
const PORT = 9227;

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

// 提到模块作用域，好让 catch 分支也能清理（中途失败时不留临时目录）。
let udd = null;

(async () => {
  console.log('=== 模型设置界面验证 ===\n');

  // 开发态启动。直接用 electron.exe 而非 .cmd 包装 ——
  // 后者会多一层 shell，退出时子进程容易残留。
  const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

  /*
   * 必须隔离 userData：本脚本会往 Key 输入框里填占位值，而输入框的
   * `input` 监听器会立刻持久化 —— 不隔离就会**覆盖用户真实保存的 Key**。
   * 详见 lib/isolated-user-data.js 的说明。
   */
  udd = makeIsolatedUserData('model-ui');
  const child = spawn(
    ELECTRON,
    ['.', `--debug-port=${PORT}`, ...udd.args],
    {
      cwd: ROOT,
      stdio: 'ignore',
      env: (() => {
        const e = { ...process.env };
        delete e.NODE_OPTIONS;
        delete e.ELECTRON_RUN_AS_NODE;
        return e;
      })(),
    },
  );

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

  // ---------------------------------------------------------- 1. 结构存在
  console.log('【1. 面板结构】');
  const structure = await evaluate(`(() => {
    const g = document.getElementById('groupModel');
    return {
      groupExists: Boolean(g),
      groupOpen: Boolean(g && g.open),
      isFirst: g ? g === document.querySelector('.cfg-group') : false,
      badgeText: (document.getElementById('modelBadge') || {}).textContent || '',
      optionCount: document.getElementById('providerPreset').options.length,
      hasKeyField: Boolean(document.getElementById('fieldApiKey')),
      hasTestBtn: Boolean(document.getElementById('btnTestModel')),
    };
  })()`);
  check('「模型设置」分组存在', structure.groupExists);
  check('分组默认展开（是必须填的第 0 步）', structure.groupOpen);
  check('排在最前（第一组）', structure.isFirst);
  check('服务下拉已填充', structure.optionCount >= 6, `${structure.optionCount} 项`);
  check('有 API Key 输入框', structure.hasKeyField);
  check('有「测试连接」按钮', structure.hasTestBtn);
  check('有状态角标', Boolean(structure.badgeText), structure.badgeText);

  // ------------------------------------------------- 2. 离线占位隐藏 Key
  console.log('\n【2. 离线占位：不显示 Key 框】');
  const fakeState = await evaluate(`(() => {
    const sel = document.getElementById('providerPreset');
    sel.value = 'fake';
    sel.dispatchEvent(new Event('change'));
    return {
      keyHidden: document.getElementById('fieldApiKey').hidden,
      modelHidden: document.getElementById('fieldModelName').hidden,
      badge: document.getElementById('modelBadge').textContent,
      badgeWarn: document.getElementById('modelBadge').className.includes('warn'),
    };
  })()`);
  check('Key 输入框被隐藏（无需凭据）', fakeState.keyHidden === true);
  check('角标如实说明是离线占位', /离线|未配置/.test(fakeState.badge), fakeState.badge);
  check('角标用警示色（提醒没接真实模型）', fakeState.badgeWarn === true);

  // ------------------------------------------------- 3. 切换到 Gemini
  console.log('\n【3. 切换到 Gemini：预填默认值】');
  const geminiState = await evaluate(`(() => {
    const sel = document.getElementById('providerPreset');
    sel.value = 'gemini';
    sel.dispatchEvent(new Event('change'));
    return {
      keyHidden: document.getElementById('fieldApiKey').hidden,
      model: document.getElementById('modelName').value,
      basePlaceholder: document.getElementById('baseUrl').placeholder,
      hint: document.getElementById('providerHint').textContent,
      badge: document.getElementById('modelBadge').textContent,
    };
  })()`);
  check('Key 输入框显示出来', geminiState.keyHidden === false);
  check('模型名已预填 gemini', /gemini/.test(geminiState.model), geminiState.model);
  check('说明文字已更新', geminiState.hint.length > 0, geminiState.hint.slice(0, 40));
  check('缺 Key 时角标提示', /缺/.test(geminiState.badge), geminiState.badge);

  // ------------------------------------------------- 4. 国内模型预填地址
  console.log('\n【4. 国内模型：预填接口地址】');
  const qwenState = await evaluate(`(() => {
    const sel = document.getElementById('providerPreset');
    sel.value = 'dashscope';
    sel.dispatchEvent(new Event('change'));
    return {
      model: document.getElementById('modelName').value,
      baseUrl: document.getElementById('baseUrl').value,
    };
  })()`);
  check('国内模型预填了模型名', qwenState.model.length > 0, qwenState.model);
  check('国内模型预填了接口地址（开箱即用）',
    /^https:\/\//.test(qwenState.baseUrl), qwenState.baseUrl);

  // --------------------------------------------- 5. 校验：缺 Key 应拦下
  console.log('\n【5. 缺 Key 时运行被拦下并展开分组】');
  const validation = await evaluate(`(() => {
    const g = document.getElementById('groupModel');
    g.open = false;                       // 模拟用户收起了分组
    document.getElementById('apiKey').value = '';
    document.getElementById('videoPath').value = 'D:\\\\HarnessTest\\\\samples\\\\x.mp4';
    const cfg = readConfig();
    const problem = validate(cfg);
    return { hasProblem: Boolean(problem), field: problem && problem.field, group: problem && problem.group };
  })()`);
  check('缺 Key 被校验拦下', validation.hasProblem === true, validation.field || '');
  check('指明了要展开哪个分组', validation.group === 'groupModel', validation.group || '');

  // ------------------------------------------------- 6. Key 显示切换
  console.log('\n【6. Key 显示/隐藏切换】');
  const toggle = await evaluate(`(() => {
    const input = document.getElementById('apiKey');
    const btn = document.getElementById('btnToggleKey');
    input.value = 'sk-test-not-a-real-key';
    const before = input.type;
    btn.click();
    const after = input.type;
    btn.click();
    return { before, after, restored: input.type, label: btn.textContent };
  })()`);
  check('初始为密码框（防旁观）', toggle.before === 'password');
  check('可切换为明文（便于核对粘贴）', toggle.after === 'text');
  check('可切回密码框', toggle.restored === 'password');

  // ------------------------------------------------- 7. 命令预览含模型
  console.log('\n【7. 命令预览如实反映模型选择】');
  const preview = await evaluate(`(() => {
    const sel = document.getElementById('providerPreset');
    sel.value = 'dashscope';
    sel.dispatchEvent(new Event('change'));
    document.getElementById('apiKey').value = 'sk-preview-test';
    refreshCommandPreview();
    return document.getElementById('commandPreview').textContent;
  })()`);
  check('预览里出现 provider 环境变量', /VRH_PROVIDERS__VISION__NAME=openai_vlm/.test(preview));
  check('预览里出现模型名', /VRH_PROVIDERS__VISION__MODEL=qwen-vl-max/.test(preview));
  check('预览里不出现 Key 明文（防截图泄露）',
    !preview.includes('sk-preview-test'), '已脱敏');
  check('预览里有 Key 已注入的提示',
    /注入/.test(preview), preview.split('python')[0].slice(0, 60));

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${'='.repeat(56)}`);
  console.log(`合计 ${results.length} 项，通过 ${passed}，失败 ${results.length - passed}`);
  console.log('='.repeat(56));
  if (passed < results.length) {
    console.log('\n未通过：');
    results.filter((r) => !r.ok).forEach((r) => console.log(`  · ${r.label}`));
  }

  ws.close();
  child.kill('SIGTERM');
  cleanupIsolatedUserData(udd);
  process.exit(passed === results.length ? 0 : 1);
})().catch((error) => {
  console.error(error);
  cleanupIsolatedUserData(udd);
  process.exit(1);
});
