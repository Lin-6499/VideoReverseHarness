'use strict';

/**
 * 模型配置：持久化 + 注入子进程。
 *
 * ── 为什么单独一个模块 ────────────────────────────────────────────
 * 这件事有两个必须放一起考虑的约束，分散写必然出错：
 *
 * 1. **API Key 绝不能进 argv。** 命令行参数在进程列表（任务管理器、ps）里
 *    对同机其他用户可见，也会被日志与崩溃报告捕获。所以 Key 只走环境变量，
 *    而且要传给子进程就得在 spawn 的 env 里给 —— 这就是本模块存在的主因。
 *
 * 2. **harness 的配置入口是环境变量。** CLI 没有任何 provider 参数
 *    （见 harness 的 cli.py），唯一的运行时覆盖手段是 `VRH_` 前缀 + `__`
 *    分层的环境变量，例如 VRH_PROVIDERS__VISION__NAME。
 *    所以「界面上选模型」最终必须翻译成环境变量，而不是命令行开关。
 *
 * ── 存储位置 ──────────────────────────────────────────────────────
 * Electron 的 userData 目录（Windows 下是 %APPDATA%/<appName>/）。
 * 不放源码目录：那里可能被同步盘、版本控制或卸载程序带走。
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const CONFIG_FILENAME = 'model-config.json';

/** Key 注入子进程时使用的环境变量名（对应 harness 的 api_key_env）。 */
const KEY_ENV_NAME = 'VRH_VISION_API_KEY';

/** 各 provider 需要的必填信息，用于本地的「能不能跑」预检。 */
const PROVIDER_RULES = {
  fake: { needsKey: false, label: '离线占位' },
  openai_vlm: { needsKey: true, label: 'OpenAI 兼容接口' },
  gemini_vlm: { needsKey: true, label: 'Google Gemini' },
};

function configPath() {
  return path.join(app.getPath('userData'), CONFIG_FILENAME);
}

/**
 * 读取已保存的配置。
 *
 * 任何异常都退化为「无配置」而不是抛出：配置文件损坏不该让应用起不来，
 * 大不了用户重填一次。
 */
function load() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

/**
 * 保存配置。
 *
 * 用「写临时文件 + 改名」而不是直接覆盖：直接写时若进程被中断，
 * 会留下一个半截的 JSON —— 下次启动读不出来，用户的 Key 就没了。
 * 同一分区内的 rename 是原子的。
 */
function save(config) {
  const target = configPath();
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });

  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(tmp, target);

  // 收紧权限，尽量只让当前用户可读（Windows 上 chmod 语义有限，尽力而为）。
  try { fs.chmodSync(target, 0o600); } catch { /* 非致命 */ }

  return target;
}

/**
 * 校验界面传来的模型配置，返回规范化结果。
 *
 * 只做「本地可判定」的检查 —— Key 是否真的有效必须发请求才知道，
 * 那属于「测试连接」的职责，不在这里假装能判断。
 */
function normalize(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const provider = String(cfg.provider || 'fake');
  const rule = PROVIDER_RULES[provider];
  if (!rule) {
    return { ok: false, message: `不支持的模型服务：${provider}` };
  }

  const apiKey = String(cfg.apiKey || '').trim();
  if (rule.needsKey && !apiKey) {
    return { ok: false, message: `${rule.label} 需要填入 API Key` };
  }

  return {
    ok: true,
    config: {
      provider,
      model: String(cfg.model || '').trim(),
      // 结尾斜杠会让 URL 出现 //v1，部分网关直接 404。
      baseUrl: String(cfg.baseUrl || '').trim().replace(/\/+$/, ''),
      apiKey,
    },
  };
}

/**
 * 把模型配置翻译成子进程的环境变量。
 *
 * 返回的 env 是**叠加**在现有环境之上的增量，调用方自行合并 ——
 * 这样调用处不必关心保留哪些既有变量。
 */
function toEnv(modelConfig) {
  const normalized = normalize(modelConfig);
  if (!normalized.ok) return {};

  const cfg = normalized.config;
  const env = {};

  // 离线占位：显式设回 fake，否则会继承上一个运行残留的环境变量。
  if (cfg.provider === 'fake') {
    env.VRH_PROVIDERS__VISION__NAME = 'fake';
    return env;
  }

  env.VRH_PROVIDERS__VISION__NAME = cfg.provider;
  if (cfg.model) env.VRH_PROVIDERS__VISION__MODEL = cfg.model;
  if (cfg.baseUrl) env.VRH_PROVIDERS__VISION__BASE_URL = cfg.baseUrl;

  /*
   * Key 走「间接引用」而不是直接塞进 provider 的配置值：
   * harness 的 api_key_env 存的是**变量名**，值从同名环境变量读。
   * 这样 Key 不会出现在任何配置文件、日志或命令预览里。
   */
  if (cfg.apiKey) {
    env.VRH_PROVIDERS__VISION__API_KEY_ENV = KEY_ENV_NAME;
    env[KEY_ENV_NAME] = cfg.apiKey;
  }

  return env;
}

/** 是否配置了可用的真实模型（供界面提示用）。 */
function describe(modelConfig) {
  const normalized = normalize(modelConfig);
  if (!normalized.ok) return normalized.message;
  const cfg = normalized.config;
  if (cfg.provider === 'fake') return '离线占位（不调用模型）';
  return `${cfg.provider}${cfg.model ? ` · ${cfg.model}` : ''}`;
}

module.exports = {
  CONFIG_FILENAME,
  KEY_ENV_NAME,
  PROVIDER_RULES,
  describe,
  load,
  normalize,
  save,
  toEnv,
};
