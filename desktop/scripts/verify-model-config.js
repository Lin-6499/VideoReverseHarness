'use strict';

/**
 * 模型配置链路验证。
 *
 * 为什么必须单独验：这条链路上任何一环静默失效，症状都是「界面选好了模型，
 * 但实际还在用离线占位」—— 提示词照样出来、程序照样显示成功，只是内容毫无
 * 意义。这类「看起来成功了」的失败最危险，因为没人会去查。
 *
 * 覆盖四段：
 *   1. normalize 的输入校验（该拦的拦住）
 *   2. toEnv 的环境变量翻译（形状必须与 harness 的 __ 分层规则一致）
 *   3. **Key 绝不进入 argv**（这是安全约束，不是风格偏好）
 *   4. 真实子进程注入 —— 让 Python 报出它实际读到的配置，证明确实生效
 *
 * 第 4 段是核心：前 3 段只证明「我这样拼的字符串是对的」，只有第 4 段
 * 能证明「harness 真的照这个跑了」。
 */

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HARNESS = 'D:\\HarnessTest';
const PYTHON = path.join(HARNESS, '.venv', 'Scripts', 'python.exe');

/*
 * model-config.js 依赖 electron 的 app.getPath，纯 Node 下没有 electron。
 *
 * 这里不改写模块解析器（那样很脆），而是临时包一层 Module.prototype.require：
 * 加载目标模块的期间，把 'electron' 换成替身；加载完立刻还原，不影响后续 require。
 * 只需要 getPath，所以替身极简。
 */
const Module = require('module');
const electronStub = {
  app: { getPath: () => path.join(ROOT, '.verify-model-config') },
};

function loadWithElectronStub(request) {
  const original = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'electron') return electronStub;
    return original.apply(this, arguments);
  };
  try {
    const resolved = require.resolve(request);
    delete require.cache[resolved];
    return require(resolved);
  } finally {
    Module.prototype.require = original;
  }
}

const modelConfig = loadWithElectronStub(path.join(ROOT, 'src', 'main', 'model-config.js'));
const runner = loadWithElectronStub(path.join(ROOT, 'src', 'main', 'runner.js'));

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok });
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
}

const DASHSCOPE = {
  provider: 'openai_vlm',
  model: 'qwen-vl-max',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/',
  apiKey: 'sk-secret-value-12345',
};

(async () => {
  console.log('=== 模型配置链路验证 ===\n');

  // ---------------------------------------------------------------- 1. 校验
  console.log('【1. 输入校验】');
  check('缺 Key 时被拦下', !modelConfig.normalize({ provider: 'openai_vlm' }).ok);
  check('Gemini 缺 Key 时被拦下', !modelConfig.normalize({ provider: 'gemini_vlm' }).ok);
  check('未知 provider 被拦下', !modelConfig.normalize({ provider: 'nope' }).ok);
  check('离线占位无需 Key 即通过',
    modelConfig.normalize({ provider: 'fake' }).ok);
  check('Key 前后空格被裁掉',
    modelConfig.normalize({ provider: 'gemini_vlm', apiKey: '  k  ' }).config.apiKey === 'k');
  check('地址结尾斜杠被裁掉（避免 //v1）',
    modelConfig.normalize(DASHSCOPE).config.baseUrl
      === 'https://dashscope.aliyuncs.com/compatible-mode/v1');

  // ------------------------------------------------------- 2. 环境变量翻译
  console.log('\n【2. 环境变量翻译】');
  const env = modelConfig.toEnv(DASHSCOPE);
  check('provider 名被翻译', env.VRH_PROVIDERS__VISION__NAME === 'openai_vlm', env.VRH_PROVIDERS__VISION__NAME);
  check('模型名被翻译', env.VRH_PROVIDERS__VISION__MODEL === 'qwen-vl-max', env.VRH_PROVIDERS__VISION__MODEL);
  check('地址被翻译', Boolean(env.VRH_PROVIDERS__VISION__BASE_URL));
  check('Key 走间接引用（api_key_env 存变量名）',
    env.VRH_PROVIDERS__VISION__API_KEY_ENV === modelConfig.KEY_ENV_NAME,
    env.VRH_PROVIDERS__VISION__API_KEY_ENV);
  check('Key 值单独放在同名变量里', env[modelConfig.KEY_ENV_NAME] === DASHSCOPE.apiKey);

  const fakeEnv = modelConfig.toEnv({ provider: 'fake' });
  check('离线占位显式设回 fake（防残留）', fakeEnv.VRH_PROVIDERS__VISION__NAME === 'fake');
  check('离线占位不带 Key', !fakeEnv[modelConfig.KEY_ENV_NAME]);
  check('离线占位不带模型名', !fakeEnv.VRH_PROVIDERS__VISION__MODEL);

  // ------------------------------------------------- 3. Key 不得进入 argv
  console.log('\n【3. Key 不进 argv（安全约束）】');
  // 复刻 runner.js 的组装方式，确认 Key 只出现在 env 里。
  const args = runner.buildArgs({ videoPath: 'D:\\a.mp4' });
  const argvText = [PYTHON, ...args].join(' ');
  check('argv 里没有 Key 值', !argvText.includes(DASHSCOPE.apiKey));
  check('argv 里没有 Key 变量名', !argvText.includes(modelConfig.KEY_ENV_NAME));
  check('argv 里没有 provider 覆盖（走 env 而非开关）',
    !argvText.includes('VRH_PROVIDERS'));

  // ------------------------------------------------- 4. 真实子进程注入
  console.log('\n【4. 真实子进程注入（关键）】');
  const probe = `
import json
from vrh.config import load_settings
s = load_settings()
v = s.providers.vision
print(json.dumps({
    "name": v.name,
    "model": v.model,
    "baseUrl": v.base_url,
    "apiKeyEnv": v.api_key_env,
    "resolvedKey": __import__("os").environ.get(v.api_key_env, "") if v.api_key_env else "",
}))
`;
  const child = spawnSync(PYTHON, ['-c', probe], {
    cwd: HARNESS,
    // 关键：与 runner.js 完全相同的合并方式
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...modelConfig.toEnv(DASHSCOPE) },
    encoding: 'utf8',
  });

  if (child.status !== 0) {
    check('子进程读取配置', false, (child.stderr || '').trim().slice(0, 200));
  } else {
    const got = JSON.parse(child.stdout.trim());
    check('harness 读到正确的 provider', got.name === 'openai_vlm', got.name);
    check('harness 读到正确的模型名', got.model === 'qwen-vl-max', got.model);
    check('harness 读到正确的地址', got.baseUrl.includes('dashscope'), got.baseUrl);
    check('harness 能按名字取到 Key 值（链路闭环）',
      got.resolvedKey === DASHSCOPE.apiKey,
      got.resolvedKey ? '已取到' : '取不到');
  }

  const fakeChild = spawnSync(PYTHON, ['-c', probe], {
    cwd: HARNESS,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...modelConfig.toEnv({ provider: 'fake' }) },
    encoding: 'utf8',
  });
  if (fakeChild.status === 0) {
    const got = JSON.parse(fakeChild.stdout.trim());
    check('切回离线占位后 provider 确实是 fake', got.name === 'fake', got.name);
  } else {
    check('切回离线占位', false, (fakeChild.stderr || '').trim().slice(0, 150));
  }

  // ------------------------------------------------------ 5. 持久化往返
  console.log('\n【5. 持久化往返】');
  const saved = modelConfig.save(modelConfig.normalize(DASHSCOPE).config);
  const loaded = modelConfig.load();
  check('保存后能读回', Boolean(loaded), saved);
  check('读回的内容一致', loaded && loaded.model === 'qwen-vl-max');
  check('读回后 Key 仍在', loaded && loaded.apiKey === DASHSCOPE.apiKey);
  // 清理，不留痕迹
  try { require('fs').unlinkSync(saved); } catch { /* 尽力而为 */ }
  try { require('fs').rmdirSync(path.dirname(saved)); } catch { /* 尽力而为 */ }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${'='.repeat(56)}`);
  console.log(`合计 ${results.length} 项，通过 ${passed}，失败 ${results.length - passed}`);
  console.log('='.repeat(56));
  if (passed < results.length) {
    console.log('\n未通过：');
    results.filter((r) => !r.ok).forEach((r) => console.log(`  · ${r.label}`));
  }
  process.exit(passed === results.length ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
