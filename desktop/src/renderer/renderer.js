'use strict';

/**
 * 渲染进程。
 *
 * 这里只做 UI：读表单、显示状态、渲染日志与结果。所有有副作用的操作（起进程、
 * 读文件）都通过 window.vrh 交给主进程 —— 界面本身没有 Node 权限。
 *
 * 设计上最要紧的一点：**界面永远不猜测运行结果**。成功、失败、质量门未过、
 * 中断，四种状态全部来自主进程对退出码的判定，界面只负责分别呈现。把「质量门
 * 未过」画成红色失败是最容易犯的错。
 */

/**
 * 阶段定义。
 *
 * 中文名在前、层级代号在后（渲染成角标）：阶段条从左到右读起来是一条完整的
 * 中文叙事线（解析视频 → 切分镜头 → …），同时保留 L1–L5 以便和 harness 日志、
 * 命令行参数（--until / --only）对照。
 */
const STAGES = [
  { key: 'parse', label: '解析视频', code: 'L1' },
  { key: 'segment', label: '切分镜头', code: 'L2' },
  { key: 'understand', label: '理解画面', code: 'L3' },
  { key: 'generate', label: '生成提示词', code: 'L4' },
  { key: 'evaluate', label: '评测质量', code: 'L5' },
];

const el = (id) => document.getElementById(id);

/*
 * 模型服务目录。
 *
 * 为什么把它写成数据而不是散在事件处理里：每个服务除了名字，还要给出
 * 「provider 名 / 默认模型 / 默认地址 / 去哪申请 Key」，这四件事必须在
 * 一处定义才不会互相矛盾。之前 harness 的 default.yaml 注释里列了几个
 * 并不存在于 registry 的 provider 名，正是这种分散导致的 —— 注释比实现乐观。
 *
 * needsKey=false 的项会隐藏 Key 输入框：离线的 fake 不需要凭据，显示一个
 * 空的必填框只会让人以为「不填就不能跑」。
 *
 * 国内模型统一走 openai 兼容模式（openaiVlm + 自定义 base_url），
 * 因为它们都提供 OpenAI 形状的 /chat/completions。Gemini 不是这个形状，
 * 所以有独立的 provider。
 */
const PROVIDER_PRESETS = [
  {
    id: 'fake',
    label: '离线占位（不调用模型）',
    provider: 'fake',
    needsKey: false,
    hint: '用于验证流程是否跑通 —— 提示词由内置样例生成，不消耗任何费用。'
      + '正式使用请换成真实模型。',
    badge: '未配置 · 使用离线占位',
    badgeLevel: 'warn',
  },
  {
    id: 'dashscope',
    label: '通义千问 · 阿里云百炼',
    provider: 'openai_vlm',
    model: 'qwen3.8-max',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    needsKey: true,
    hint: '国内直连、无需代理。Key 在阿里云百炼控制台申请。'
      + '旗舰模型；想省钱可改 qwen3.8-flash。',
    badge: '通义千问',
    badgeLevel: 'ok',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    provider: 'openai_vlm',
    model: 'glm-4v-plus-0111',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    needsKey: true,
    hint: '国内直连、提供 OpenAI 兼容接口。Key 在智谱开放平台申请。',
    badge: '智谱 GLM',
    badgeLevel: 'ok',
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    provider: 'openai_vlm',
    model: 'moonshot-v1-8k-vision-preview',
    baseUrl: 'https://api.moonshot.cn/v1',
    needsKey: true,
    hint: '国内直连。注意视觉能力只在带 vision 的模型上可用。',
    badge: 'Kimi',
    badgeLevel: 'ok',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    provider: 'openai_vlm',
    model: 'gpt-4o-mini',
    baseUrl: '',
    needsKey: true,
    hint: '官方接口。国内直连通常需要自备代理，或改用下面的自定义地址。',
    badge: 'OpenAI',
    badgeLevel: 'ok',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    provider: 'gemini_vlm',
    model: 'gemini-2.5-flash',
    baseUrl: '',
    needsKey: true,
    hint: '接口形状与 OpenAI 不同，已用独立实现对接。Key 在 Google AI Studio 申请。',
    badge: 'Gemini',
    badgeLevel: 'ok',
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容网关）',
    provider: 'openai_vlm',
    model: '',
    baseUrl: '',
    needsKey: true,
    hint: '用于中转站、自建网关（one-api / vLLM / Azure OpenAI 等）。'
      + '地址需填到 /v1 这一层。',
    badge: '自定义',
    badgeLevel: 'ok',
  },
];

/** 全局状态。 */

const state = {
  env: null,
  running: false,
  logs: [],
  stageStatus: {},      // stage -> { status, durationS }
  stageDetail: {},      // stage -> 说明文字
  lastResult: null,     // 最近一次运行结果，含 artifacts
  activeStage: null,
  rawNoticeShown: false, // 中英混排提示条只显示一次
};

/* ------------------------------------------------------------------ 初始化 */

async function init() {
  renderStageTrack();
  renderProviderOptions();
  wireEvents();
  subscribeToMain();
  await loadSavedModelConfig();
  await refreshEnvironment();
  await loadPresets();
  await refreshCommandPreview();

  /*
   * 初始化完成的信号。
   *
   * 为什么要有它：状态点变绿只代表**环境探测**回来了，而预设与命令预览是在
   * 之后两个 await 里才填的。外部验证脚本（打包态走 CDP，没有冒烟钩子可用）
   * 如果只盯状态点，就会在中间态下断言，看到「预设 0 项、命令预览为空」——
   * 同一份产物时好时坏，看起来像功能不稳定，实际是测试没有可靠的等待点。
   *
   * 所以这里给外部一个明确的、语义正确的完成标志，而不是让它去猜。
   */
  document.documentElement.dataset.ready = '1';
}

function wireEvents() {
  el('btnRecheck').addEventListener('click', refreshEnvironment);
  el('btnPickRepo').addEventListener('click', pickRepoRoot);
  el('btnClearRepo').addEventListener('click', clearRepoRoot);
  el('btnOpenNotice').addEventListener('click', openHarnessNotice);
  el('btnPickVideo').addEventListener('click', pickVideo);
  el('btnRun').addEventListener('click', () => startRun(false));
  el('btnDryRun').addEventListener('click', () => startRun(true));
  el('btnStop').addEventListener('click', stopRun);
  el('btnClearLogs').addEventListener('click', clearLogs);
  el('btnExportLogs').addEventListener('click', exportLogs);
  el('btnCloseDialog').addEventListener('click', () => el('errorDialog').close());
  el('btnOpenOutput').addEventListener('click', openOutputDir);
  el('btnOpenReport').addEventListener('click', openReport);
  el('btnSavePrompt').addEventListener('click', savePromptEdits);
  el('btnDiscardPrompt').addEventListener('click', discardPromptEdits);

  el('logLevel').addEventListener('change', applyLogFilter);
  el('verify').addEventListener('change', () => {
    syncGateFieldState();
    refreshCommandPreview();
  });

  // 模型设置。切换服务时传上一项 id —— applyProviderPreset 据此判断
  // 输入框里的值是「用户手输的」还是「上一个服务的预填值」，前者不覆盖。
  el('providerPreset').addEventListener('change', (event) => {
    applyProviderPreset(event.target.dataset.prevId || '');
    event.target.dataset.prevId = event.target.value;
    persistModelConfig();
  });
  el('modelName').addEventListener('input', () => {
    el('modelName').classList.remove('invalid');
    refreshModelBadge();
    refreshCommandPreview();
    persistModelConfig();
  });
  el('baseUrl').addEventListener('input', () => {
    refreshCommandPreview();
    persistModelConfig();
  });
  el('apiKey').addEventListener('input', () => {
    el('apiKey').classList.remove('invalid');
    refreshModelBadge();
    persistModelConfig();
  });
  el('btnTestModel').addEventListener('click', testModelConnection);

  /*
   * 显示 / 隐藏 API Key。
   *
   * 密码框能防旁观者，但粘贴出错时用户无法自查 —— 而「Key 粘错/带了空格」
   * 是最高频的失败原因。所以给出切换，而不是二选一。
   */
  el('btnToggleKey').addEventListener('click', () => {
    const input = el('apiKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    el('btnToggleKey').textContent = show ? '隐藏' : '显示';
  });

  wireGroupToggles();
  wireLogCollapse();

  // 任何配置变化都刷新命令预览 —— 让用户随时看到「实际会执行什么」，
  // 这是界面不撒谎的关键。
  for (const id of ['videoPath', 'preset', 'keyframeStrategy', 'cutThreshold',
                    'framesPerShot', 'threshold', 'rounds', 'failOnGate',
                    'noMotion', 'fresh', 'untilStage', 'onlyStage']) {
    const node = el(id);
    if (!node) continue;
    node.addEventListener('change', refreshCommandPreview);
    node.addEventListener('input', refreshCommandPreview);
  }
  for (const radio of document.querySelectorAll('input[name="scope"]')) {
    radio.addEventListener('change', () => {
      syncScopeFieldState();
      refreshCommandPreview();
    });
  }

  el('videoPath').addEventListener('input', () => {
    el('videoPath').classList.remove('invalid');
    refreshCommandPreview();
  });
}

/** 配置分组的「全部收起 / 全部展开」批量开关。 */
function wireGroupToggles() {
  const button = el('btnToggleAllGroups');
  if (!button) return;

  const groups = () => [...document.querySelectorAll('.cfg-group')];
  const allOpen = () => groups().every((g) => g.open);

  const sync = () => {
    button.textContent = allOpen() ? '全部收起' : '全部展开';
  };

  button.addEventListener('click', () => {
    const open = !allOpen();
    for (const group of groups()) group.open = open;
    sync();
  });

  // 用户手动开了任何一个分组，按钮文案也要跟着变。
  for (const group of groups()) group.addEventListener('toggle', sync);
  sync();
}

/**
 * 日志面板折叠。
 *
 * 窄屏默认折叠（用户先看结果，日志次之），桌面端这个按钮是隐藏的、
 * 面板始终展开 —— 桌面端行为与改造前完全一致。
 */
function wireLogCollapse() {
  const button = el('btnToggleLog');
  const panel = el('logPanel');
  if (!button || !panel) return;

  const apply = (collapsed) => {
    panel.classList.toggle('collapsed', collapsed);
    button.setAttribute('aria-expanded', String(!collapsed));
  };

  button.addEventListener('click', () => {
    apply(!panel.classList.contains('collapsed'));
  });

  // 首次进入按当前视口宽度决定默认态，之后由用户控制，不随窗口变化反复翻转。
  apply(window.matchMedia('(max-width: 899px)').matches);

  // 折叠态下把行数显示在按钮上，收起也知道跑了多少日志。
  state.syncLogCount = () => {
    const count = el('logCount').textContent;
    button.textContent = panel.classList.contains('collapsed')
      ? `运行日志 · ${count}`
      : '运行日志';
  };
}

/** 展开日志面板（仅在窄屏折叠态下有意义；桌面端本来就是展开的）。 */
function expandLogPanel() {
  const panel = el('logPanel');
  const button = el('btnToggleLog');
  if (!panel || !button) return;
  panel.classList.remove('collapsed');
  button.setAttribute('aria-expanded', 'true');
  if (typeof state.syncLogCount === 'function') state.syncLogCount();
}

function subscribeToMain() {
  window.vrh.subscribe('vrh:log', (log) => appendLog(log));
  window.vrh.subscribe('vrh:stage', (event) => handleStageEvent(event));
  window.vrh.subscribe('vrh:cost', (cost) => updateCost(cost));
  window.vrh.subscribe('vrh:command', (command) => {
    const node = el('commandPreview');
    node.textContent = command;
    node.hidden = false;
  });
  window.vrh.subscribe('vrh:done', (result) => handleDone(result));
}

/* -------------------------------------------------------------- 环境探测 */

async function refreshEnvironment() {
  setStatus('busy', '正在探测环境…', '');
  const env = await window.vrh.doctor();
  state.env = env;
  renderEnvironment();
  return env;
}

/**
 * 手动指定 harness 目录。
 *
 * 主进程负责弹目录选择器并校验（必须是含 vrh/ 与 .venv/ 的目录），
 * 这里只负责在失败时把原因讲清楚 —— 用户选错目录时最需要的是「为什么不行」，
 * 而不是一句「选择无效」。
 */
async function pickRepoRoot() {
  setStatus('busy', '正在等待选择 harness 目录…', '');
  let result;
  try {
    result = await window.vrh.pickRepo();
  } catch (error) {
    setStatus('bad', '选择失败', error.message);
    return;
  }

  if (result.canceled) {
    // 用户主动取消，回到原有状态即可，不该弹错误。
    renderEnvironment();
    return;
  }

  if (!result.ok) {
    setStatus('bad', '目录无效', result.detail || result.message || '');
    await showNotice('所选目录不能使用', [result.message, result.detail].filter(Boolean));
    renderEnvironment();
    return;
  }

  state.env = result.env;
  renderEnvironment();
  // harness 换了，预设与命令预览都得跟着刷新 —— 否则界面还在显示旧仓库的预设。
  await loadPresets();
  await refreshCommandPreview();
}

/** 清除手选目录，回到自动查找。 */
async function clearRepoRoot() {
  const result = await window.vrh.clearRepo();
  state.env = result.env;
  renderEnvironment();
  await loadPresets();
  await refreshCommandPreview();
}

/**
 * 打开「harness 放置说明」。
 *
 * 主进程保证这个动作一定有反馈（打开文件 / 现写一份 / 弹窗显示正文），
 * 所以这里的 catch 只是最后一道防线 —— 真出错时也要把话说清楚，
 * 不能变成点了没反应的按钮。
 */
async function openHarnessNotice() {
  try {
    const result = await window.vrh.openNotice();
    if (result && result.action === 'dialog') {
      // 已经弹过系统对话框了，界面不必再提示一次。
      return;
    }
    if (result && result.path) {
      setStatus('busy', '已打开放置说明', result.path);
      return;
    }
    // 理论上不会走到这里（主进程必有返回值），但静默失败最糟。
    await showNotice('未能打开放置说明', [
      '程序没有返回可打开的文件。',
      '可以手动到程序目录找「请先阅读 - harness 放置说明.txt」。',
    ]);
  } catch (error) {
    await showNotice('未能打开放置说明', [String(error && error.message || error)]);
  }
}

function renderEnvironment() {
  const env = state.env;
  if (!env) return;

  const banner = el('envBanner');
  const list = el('envBannerList');

  if (env.canRun) {
    setStatus('ok', '已连接', buildEnvDetail(env));
    banner.hidden = true;
    el('btnRun').disabled = false;
    el('btnDryRun').disabled = false;
  } else {
    setStatus('bad', '环境未就绪', '无法启动运行');
    banner.hidden = false;
    el('envBannerTitle').textContent = '检测到阻碍运行的问题';
    list.innerHTML = '';
    for (const problem of env.problems || []) {
      const li = document.createElement('li');
      // hint 可能是多行（如「三选一」的操作指引），用 pre-line 保留换行，
      // 否则会挤成一长串，反而更难读。
      li.innerHTML = [
        `<span class="problem-msg">${escapeHtml(problem.message)}</span>`,
        problem.hint ? `<span class="problem-hint">${escapeHtml(problem.hint)}</span>` : '',
      ].join('');
      list.appendChild(li);
    }
    // 未知即禁用：与其让用户点了运行再失败，不如直接置灰。
    el('btnRun').disabled = true;
    el('btnDryRun').disabled = true;
  }

  renderRepoRootRow(env);
}

/**
 * 在横幅里显示当前用的是哪个 harness 目录。
 *
 * 打包分发后「它到底读了哪个目录」是最常见的问题来源，必须让用户看得见 ——
 * 只报「找不到」而不说「找了哪些位置」，用户无从排查。
 */
function renderRepoRootRow(env) {
  const row = el('envRepoRow');
  const text = el('envRepoText');
  const clearBtn = el('btnClearRepo');
  const noticeBtn = el('btnOpenNotice');
  if (!row) return;

  if (env.repoRoot) {
    text.textContent = env.repoRoot;
    text.title = env.repoRoot;
    // 只有手选过的才给「恢复自动查找」——原本就是自动找到的，按钮无意义。
    clearBtn.hidden = env.repoRootSource !== '上次选择的位置';
    // 找到了就不必再教怎么放。
    if (noticeBtn) noticeBtn.hidden = true;
    row.hidden = false;
    return;
  }

  const searched = (env.searchedRoots || []).length;
  text.textContent = searched
    ? `已查找 ${searched} 个可能位置，均未找到`
    : '尚未定位';
  text.title = (env.searchedRoots || []).join('\n');
  clearBtn.hidden = true;
  // 找不到时把「怎么放」摆出来 —— 此时用户最需要它。
  if (noticeBtn) noticeBtn.hidden = false;
  row.hidden = false;
}

function buildEnvDetail(env) {
  const parts = [];
  if (env.python) parts.push(`Python ${(env.python.version || '').replace(/^Python\s*/i, '')}`);
  if (env.ffmpeg) parts.push(`ffmpeg ${(env.ffmpeg.version || '').split(' ')[2] || ''} (${env.ffmpeg.source})`);
  if (env.harness && env.harness.version) parts.push(`vrh ${env.harness.version}`);
  return parts.filter(Boolean).join(' · ');
}

function setStatus(kind, text, detail) {
  el('statusDot').className = `status-dot ${kind}`;
  el('statusText').textContent = text;
  el('statusDetail').textContent = detail || '';
}

/* ------------------------------------------------------------ 预设加载 */

async function loadPresets() {
  const select = el('preset');
  const previous = select.value;

  // harness 未就绪时不要列预设 —— 列了就是在暗示「这些能用」，
  // 而实际上是空的。用户点了运行才发现不行，比一开始就说明白更糟。
  const envReady = Boolean(state.env && state.env.repoRoot);
  if (!envReady) {
    select.innerHTML = '';
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '（需先指定 harness 目录）';
    select.appendChild(option);
    select.disabled = true;
    return;
  }

  const presets = await window.vrh.presets();
  select.disabled = false;
  select.innerHTML = '';

  // 兜底：harness 在但预设目录读不到（例如 configs/presets 被清空）时，
  // 至少给两个 harness 内置的预设名，让用户仍有可选项。
  const list = presets.length ? presets : ['t2v_generic', 'i2v_generic'];
  for (const name of list) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name === 't2v_generic' ? `${name} · 文生视频`
      : name === 'i2v_generic' ? `${name} · 图生视频` : name;
    select.appendChild(option);
  }

  // 尽力保留用户原来的选择，避免重探环境后选择被重置。
  if (previous && list.includes(previous)) select.value = previous;
}

/* ------------------------------------------------------------ 表单读取 */

/**
 * 载入上次保存的模型配置。
 *
 * 为什么需要持久化：API Key 每次启动都重填是不可接受的 —— 用户会转而把 Key
 * 写进某个便利贴上。存储在 Electron 的 userData 目录（不在源码/安装目录里），
 * 卸载或换用户不会误带出去。
 *
 * 注意这里不做「Key 是否正确」的判断 —— 那要发网络请求。存下来就填回去。
 */
/**
 * 按 `baseUrl` 反推这份配置属于哪个服务预设。
 *
 * 为什么需要：早期版本的配置**没有记录 presetId**。那种情况下如果直接回落到
 * 第一项（离线占位），再拿保存值去覆盖模型名与地址，界面就会呈现自相矛盾的
 * 状态 —— 下拉框写着「离线占位（不调用模型）」，输入框里却填着百炼的地址和
 * 某个模型名。用户会以为自己在用真实模型，实际跑的是占位，白排查半天。
 *
 * `baseUrl` 是配置里最有辨识度的字段（各家的域名互不相同），用它反推最稳。
 * 对不上就返回空串，交由调用方回落 —— 宁可回落，也不要猜错。
 */
function inferPresetIdFromBaseUrl(baseUrl) {
  const target = String(baseUrl || '').trim().replace(/\/+$/, '').toLowerCase();
  if (!target) return '';
  const hit = PROVIDER_PRESETS.find(
    (p) => p.baseUrl && p.baseUrl.replace(/\/+$/, '').toLowerCase() === target,
  );
  return hit ? hit.id : '';
}

async function loadSavedModelConfig() {
  let saved = null;
  try {
    saved = await window.vrh.loadModelConfig();
  } catch {
    saved = null;   // 读取失败不该阻断启动，退化为默认值即可
  }

  /*
   * 预设的确定顺序（先精确、后推断、最后兜底）：
   *   1. 配置里记着 presetId —— 最可靠，直接用
   *   2. 没记（旧版本写的）—— 按 baseUrl 反推
   *   3. 都定不了 —— 回落第一项
   *
   * 少了第 2 步就会产生「选中项与输入框不一致」的矛盾状态，见上面的说明。
   */
  const savedId = (saved && saved.presetId) || '';
  const inferredId = savedId ? '' : inferPresetIdFromBaseUrl(saved && saved.baseUrl);
  const presetId = savedId || inferredId || PROVIDER_PRESETS[0].id;

  const sel = el('providerPreset');
  // 保存的 id 可能来自旧版本、已不存在，回落到第一项而不是留空。
  sel.value = PROVIDER_PRESETS.some((p) => p.id === presetId)
    ? presetId
    : PROVIDER_PRESETS[0].id;
  sel.dataset.prevId = sel.value;

  if (saved) {
    // 先按服务预填，再用保存值覆盖 —— 这样旧版本新增的字段也有合理默认。
    applyProviderPreset('');
    if (saved.model) el('modelName').value = saved.model;
    if (saved.baseUrl) el('baseUrl').value = saved.baseUrl;
    if (saved.apiKey) el('apiKey').value = saved.apiKey;
  } else {
    applyProviderPreset('');
  }

  refreshModelBadge();
}

/** 保存模型配置。写完不提示 —— 输入即保存是这里最省心的交互。 */
async function persistModelConfig() {
  try {
    await window.vrh.saveModelConfig(readModelConfig());
  } catch {
    // 保存失败不影响本次运行（配置已经随 run 请求传给主进程了）。
    // 静默处理，避免每次按键都弹一个「保存失败」。
  }
}

/* -------------------------------------------------------------- 模型设置 */

/** 当前选中的服务定义。始终返回一个有效对象，避免调用处到处判空。 */
function currentProvider() {
  const id = el('providerPreset').value;
  return PROVIDER_PRESETS.find((p) => p.id === id) || PROVIDER_PRESETS[0];
}

/** 填充服务下拉。文案里带上 provider 名，便于和 harness 日志对照。 */
function renderProviderOptions() {
  const sel = el('providerPreset');
  sel.innerHTML = PROVIDER_PRESETS
    .map((p) => `<option value="${p.id}">${escapeHtml(p.label)}</option>`)
    .join('');
}

/**
 * 切换服务后同步表单显隐与预填值。
 *
 * 预填策略：只在当前输入框为空、或内容恰好等于上一个服务的预填值时写入，
 * 避免把用户手输的地址/模型名冲掉（切换过去看一眼再切回来是常见操作）。
 */
function applyProviderPreset(previousId) {
  const preset = currentProvider();
  const prev = PROVIDER_PRESETS.find((p) => p.id === previousId);

  el('providerHint').textContent = preset.hint || '';

  el('fieldApiKey').hidden = !preset.needsKey;
  el('fieldModelName').hidden = false;
  el('fieldBaseUrl').hidden = false;

  const modelInput = el('modelName');
  const baseInput = el('baseUrl');
  const modelUntouched = !modelInput.value.trim() || (prev && modelInput.value === prev.model);
  const baseUntouched = !baseInput.value.trim() || (prev && baseInput.value === prev.baseUrl);

  if (modelUntouched) modelInput.value = preset.model || '';
  if (baseUntouched) baseInput.value = preset.baseUrl || '';

  baseInput.placeholder = preset.baseUrl
    ? preset.baseUrl
    : '留空则使用服务默认地址';

  refreshModelBadge();
  refreshCommandPreview();
}

/** 折叠标题上的状态角标 —— 让「有没有配好」在收起状态下也看得见。 */
/**
 * 判断模型名看起来是不是「图像生成」模型 —— 那类模型不能做视觉理解。
 *
 * 实测踩到过：用户把模型名填成 `qwen-image-2.0-pro`，测试连接一直失败，
 * 排查方向被引向「Key 过期了」「是不是欠费了」，实际是**模型选错了类别**。
 * `qwen-image-*` 是文生图模型，不接受对话式的图像理解调用。
 *
 * 这里只在**保存后、测试前**给一句提醒 —— 检测不了全部情况（模型名千变万化），
 * 但这类错误代价高、提示成本低，值得单独拦一道。
 */
function looksLikeImageGenModel(model) {
  const m = String(model || '').toLowerCase();
  if (!m) return false;
  return /(^|[-_/])(image|t2i|txt2img|dall-?e|stable-?diffusion|cogview|wanx|flux)/.test(m);
}

function refreshModelBadge() {
  const preset = currentProvider();
  const badge = el('modelBadge');
  const key = el('apiKey').value.trim();
  const model = el('modelName').value.trim();

  // 离线占位永远可运行，如实说明它不调用模型即可。
  if (!preset.needsKey) {
    badge.textContent = preset.badge;
    badge.className = 'cfg-badge warn';
    return;
  }
  /*
   * 模型名看起来是图像生成模型 —— 优先于「缺 Key」提示。
   *
   * 顺序有讲究：这类错误不修正的话，Key 填得再对也跑不通，
   * 所以它比「缺 Key」更该先说。
   */
  if (looksLikeImageGenModel(model)) {
    badge.textContent = '模型类别可能不对（疑似图像生成）';
    badge.className = 'cfg-badge bad';
    return;
  }
  if (!key) {
    badge.textContent = '缺 API Key';
    badge.className = 'cfg-badge warn';
    return;
  }
  badge.textContent = preset.badge;
  badge.className = 'cfg-badge ok';
}

/** 从界面读出模型配置。Key 只留在这里，由主进程决定如何传给子进程。 */
function readModelConfig() {
  const preset = currentProvider();
  return {
    presetId: preset.id,
    provider: preset.provider,
    model: el('modelName').value.trim() || preset.model || '',
    baseUrl: el('baseUrl').value.trim(),
    apiKey: preset.needsKey ? el('apiKey').value.trim() : '',
    needsKey: preset.needsKey,
  };
}

/** 测试连接的按钮状态与结果展示。 */
function setTestResult(text, level) {
  const node = el('testModelResult');
  node.textContent = text;
  node.className = `test-result${level ? ` ${level}` : ''}`;
}

/*
 * 把服务端返回的原始报错翻译成「用户能照着做」的一句话。
 *
 * 为什么值得做：服务端的报错虽然信息完整，但对用户等于不可读 ——
 * 阿里云的欠费提示是一个 300+ 字符的 JSON，里面真正有用的只有
 * `"type":"Arrearage"` 和 `#overdue-payment` 两个记号。
 * 用户看到一坨 JSON 只会得出「程序坏了」的结论，而实际上问题在账号侧，
 * 且解决方法非常明确（去充值）。
 *
 * 翻译规则全部来自实测真实响应，不是猜测。命中多条时取第一条 ——
 * 判断顺序按「特异性从高到低」排，避免被宽泛的模式先截胡。
 */
const ERROR_HINTS = [
  {
    // 实测：{"type":"Arrearage"} + 文档锚点 #overdue-payment
    test: /Arrearage|overdue-payment|account is in good standing/i,
    hint: '阿里云账号欠费（错误码 Arrearage）。请到「费用与成本」确认并充值；\n'
        + '充值后余额更新有延迟，等几分钟再试。',
  },
  {
    test: /FreeTierOnly|free tier of the model has been exhausted/i,
    hint: '该模型的免费额度已用尽。可到百炼控制台关闭「免费额度用完即停」，\n'
        + '改为按量付费；或换一个模型。',
  },
  {
    test: /limit_requests|exceeded your current request limit/i,
    hint: '触发限流（错误码 limit_requests）。稍等片刻重试即可；\n'
        + '若持续出现，说明该模型当前并发额度已被占满。',
  },
  {
    test: /insufficient_quota|AllocationQuota/i,
    hint: '配额不足。免费额度已到期或耗尽，且该模型不支持按量计费 ——\n'
        + '需要换用其它模型。',
  },
  {
    test: /Unpurchased|eligible for using the model/i,
    hint: '尚未开通该模型的服务。请到百炼控制台确认已开通，\n'
        + '并检查该模型是否在你的账号可购范围内。',
  },
  {
    test: /InvalidApiKey|invalid_api_key|Authentication|Unauthorized|401/i,
    hint: 'API Key 无效或已被删除。请到控制台重新生成一个。',
  },
  {
    test: /model not found|does not exist|ModelNotExist|unknown model/i,
    hint: '模型名不存在。请核对拼写，或换用界面预设里的模型名。',
  },
  {
    // qwen-image-* 这类是「图像生成」模型，不支持对话式的视觉理解调用
    test: /image length and width|must be larger than/i,
    hint: '图片尺寸不满足模型要求。若在「测试连接」看到这条，属正常现象\n'
        + '（测试图很小）；但真实运行时出现，说明视频关键帧异常。',
  },
];

function explainModelError(message) {
  const text = String(message || '');
  for (const rule of ERROR_HINTS) {
    if (rule.test.test(text)) return rule.hint;
  }
  return '';
}

async function testModelConnection() {
  const cfg = readModelConfig();
  if (cfg.needsKey && !cfg.apiKey) {
    setTestResult('请先填入 API Key', 'bad');
    return;
  }
  // 测试期间禁用按钮，否则连点会并发发多次请求（每次都要付费）。
  const btn = el('btnTestModel');
  btn.disabled = true;
  setTestResult('正在测试…', 'busy');
  try {
    const r = await window.vrh.testModel(cfg);
    if (r && r.ok) {
      setTestResult(`连接成功 · ${r.detail}`, 'ok');
    } else {
      const raw = (r && r.message) || '未知错误';
      const hint = explainModelError(raw);
      // 先给人能照做的结论，再附服务端原文 —— 顺序反了就又变成一坨 JSON。
      setTestResult(hint ? `失败：${hint}\n\n服务端原文：\n${raw}` : `失败：${raw}`, 'bad');
    }
  } catch (error) {
    setTestResult(`失败：${error.message}`, 'bad');
  } finally {
    btn.disabled = false;
  }
}

function readConfig() {
  const scope = document.querySelector('input[name="scope"]:checked').value;
  const videoPath = el('videoPath').value.trim();

  const config = {
    videoPath,
    preset: el('preset').value,
    keyframeStrategy: el('keyframeStrategy').value,
    cutThreshold: numberOrNull(el('cutThreshold').value),
    framesPerShot: numberOrNull(el('framesPerShot').value),
    verify: el('verify').checked,
    threshold: numberOrNull(el('threshold').value),
    rounds: numberOrNull(el('rounds').value),
    failOnGate: el('failOnGate').checked,
    noMotion: el('noMotion').checked,
    fresh: el('fresh').checked,
    // 模型配置整块交给主进程 —— 由它决定注入到子进程的环境变量形态。
    model: readModelConfig(),
  };

  if (scope === 'until') {
    config.scope = 'until';
    config.scopeStage = el('untilStage').value;
    config.dryRun = false;
  } else if (scope === 'only') {
    config.scope = 'only';
    config.scopeStage = el('onlyStage').value;
    config.dryRun = false;
  } else {
    config.scope = 'full';
  }

  return config;
}

function numberOrNull(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 校验表单，返回错误消息或 null。 */
function validate(config) {
  if (!config.videoPath) return { message: '请先选择视频文件', field: 'videoPath' };

  /*
   * 模型配置的校验。
   *
   * 这里只拦「必然失败」的情况（选了真实模型却没给 Key）。地址与模型名不
   * 强制必填 —— 每个服务都有合理默认值，让用户留空反而少一个出错点。
   * 真正的可用性交给「测试连接」按钮去证伪，比静态校验可靠。
   */
  const model = config.model || {};
  if (model.needsKey && !model.apiKey) {
    return {
      message: '请填入 API Key，或把「模型服务」切回离线占位',
      field: 'apiKey',
      group: 'groupModel',
    };
  }

  const gates = [
    ['cutThreshold', config.cutThreshold, '切分阈值必须为正数'],
    ['framesPerShot', config.framesPerShot, '每镜帧数必须为正数'],
  ];
  for (const [field, value, message] of gates) {
    if (value != null && value <= 0) return { message, field };
  }

  if (config.verify) {
    if (config.threshold != null && (config.threshold < 0 || config.threshold > 1)) {
      return { message: '阈值必须在 0 与 1 之间', field: 'threshold' };
    }
    if (config.rounds != null && (config.rounds < 1 || config.rounds > 5)) {
      return { message: '轮数必须在 1 与 5 之间', field: 'rounds' };
    }
  }

  return null;
}

/** 在界面重建一遍 argv，纯粹为了展示 —— 真实参数由主进程组装。 */
async function refreshCommandPreview() {
  const config = readConfig();
  const python = state.env && state.env.python ? state.env.python.path : 'python';
  const args = ['-m', 'vrh.cli', 'run', '--video', config.videoPath || '<未选择>', '--json-logs'];

  if (config.preset) args.push('--preset', config.preset);
  if (config.keyframeStrategy) args.push('--keyframe-strategy', config.keyframeStrategy);
  if (config.framesPerShot != null) args.push('--frames-per-shot', String(config.framesPerShot));
  if (config.cutThreshold != null) args.push('--cut-threshold', String(config.cutThreshold));
  if (config.verify) {
    args.push('--verify');
    if (config.rounds != null) args.push('--rounds', String(config.rounds));
    if (config.threshold != null) args.push('--threshold', String(config.threshold));
    if (config.failOnGate) args.push('--fail-on-gate');
  }
  if (config.scope === 'only') args.push('--only', config.scopeStage);
  if (config.scope === 'until') args.push('--until', config.scopeStage);
  if (config.dryRun) args.push('--dry-run');
  if (config.noMotion) args.push('--no-motion');
  if (config.fresh) args.push('--fresh');

  /*
   * 模型配置通过**环境变量**传给子进程，不是命令行参数。
   *
   * 为什么必须把这一点显示出来：命令预览的承诺是「你会看到实际执行什么」。
   * 模型选择恰恰是最影响行为的一项，如果它不出现在预览里，用户会以为
   * 预览没跟上、或以为模型没生效。所以把环境变量也按 shell 的写法展示。
   *
   * Key 一律显示为 *** —— 预览面板可能被截图分享，且它本身没有脱敏义务。
   */
  const env = modelEnvPreview(config.model);
  const prefix = env ? `${env} ` : '';
  const node = el('commandPreview');
  node.textContent = `${prefix}${python} ${args.join(' ')}`;
  node.hidden = false;
  return args;
}

/** 把模型配置渲染成环境变量前缀（用于命令预览）。 */
function modelEnvPreview(model) {
  if (!model || model.provider === 'fake') return '';
  const parts = [
    `VRH_PROVIDERS__VISION__NAME=${model.provider}`,
  ];
  if (model.model) parts.push(`VRH_PROVIDERS__VISION__MODEL=${model.model}`);
  if (model.baseUrl) parts.push(`VRH_PROVIDERS__VISION__BASE_URL=${model.baseUrl}`);
  if (model.apiKey) parts.push('VRH_PROVIDERS__VISION__API_KEY_ENV=<本次运行注入>');
  return parts.join(' ');
}

function syncGateFieldState() {
  const enabled = el('verify').checked;
  for (const node of el('gateFields').querySelectorAll('input')) node.disabled = !enabled;
  el('threshold').disabled = !enabled;
  el('rounds').disabled = !enabled;
  el('failOnGate').disabled = !enabled;
  el('failOnGateRow').style.opacity = enabled ? '1' : '0.45';
}

function syncScopeFieldState() {
  const scope = document.querySelector('input[name="scope"]:checked').value;
  el('untilStage').disabled = scope !== 'until';
  el('onlyStage').disabled = scope !== 'only';
}

/* -------------------------------------------------------------- 运行控制 */

async function pickVideo() {
  const picked = await window.vrh.pickVideo();
  if (!picked) return;
  el('videoPath').value = picked;
  el('videoPath').classList.remove('invalid');
  el('videoHint').textContent = '';
  await refreshCommandPreview();
}

async function startRun(dryRun) {
  const config = readConfig();
  if (dryRun) {
    config.scope = 'full';
    config.dryRun = true;
  }

  const problem = validate(config);
  if (problem) {
    /*
     * 若出问题的字段在收起的分组里，先把分组展开。
     *
     * 不加这一步的话，用户点「开始运行」会只看到日志里一行报错、表单上
     * 毫无反应 —— 因为那个输入框根本没显示。焦点跑到折叠区域里也是无效的，
     * 浏览器不会自动展开 <details>。
     */
    if (problem.group) {
      const group = el(problem.group);
      if (group) group.open = true;
    }
    const node = el(problem.field);
    if (node) {
      node.classList.add('invalid');
      node.focus();
    }
    appendLocalLog('ERROR', problem.message);
    return;
  }

  resetRunState(dryRun);
  setRunning(true);
  // 窄屏下日志默认是折叠的。用户主动点了运行，就该看到它在动 ——
  // 否则「点了没反应」的错觉会让人反复点击。
  expandLogPanel();

  const response = await window.vrh.run(config);
  if (!response.ok) {
    // 启动阶段就被拒绝了（视频不存在、环境未就绪、已有任务在跑……）。
    // 必须把结果面板里的「运行中」占位一并清掉 —— 否则会出现「按钮已恢复可用、
    // 日志里有报错，但结果区还写着运行中」的自相矛盾状态。
    setRunning(false);
    appendLocalLog('ERROR', response.message || '无法启动运行');
    renderLaunchFailure(response.message || '无法启动运行');
    return;
  }
}

/** 启动失败的结果面板呈现：说清楚「没跑起来」和「跑起来但结果不好」的区别。 */
function renderLaunchFailure(message) {
  const body = el('resultBody');
  body.dataset.kind = 'error';

  const badge = el('resultBadge');
  badge.hidden = false;
  badge.textContent = '未能启动';
  badge.className = 'badge review';

  body.innerHTML = `<div class="result-callout error">
    <div class="result-callout-title">未能启动</div>
    <div>${escapeHtml(message)}</div>
    <div class="result-hint">流水线没有开始执行，因此没有产生任何产物。修正上面的问题后可直接重试。</div>
  </div>`;

  el('btnOpenReport').hidden = true;
}

async function stopRun() {
  el('btnStop').disabled = true;
  const response = await window.vrh.stop();
  appendLocalLog('WARNING', response.message || '已请求停止');
}

function setRunning(running) {
  state.running = running;
  el('btnRun').disabled = running || !(state.env && state.env.canRun);
  el('btnDryRun').disabled = running || !(state.env && state.env.canRun);
  el('btnStop').disabled = !running;
  setStatus(
    running ? 'busy' : (state.env && state.env.canRun ? 'ok' : 'bad'),
    running ? '运行中' : (state.env && state.env.canRun ? '已连接' : '环境未就绪'),
    running ? '正在执行流水线' : buildEnvDetail(state.env || {})
  );
}

function resetRunState(dryRun) {
  state.logs = [];
  state.stageStatus = {};
  state.stageDetail = {};
  state.activeStage = null;
  state.lastResult = null;
  state.rawNoticeShown = false;

  el('logBody').innerHTML = '';
  el('logRawNotice').hidden = true;
  syncLogCount();
  el('resultBadge').hidden = true;
  el('btnOpenReport').hidden = true;
  el('resultBody').innerHTML = '<p class="empty-hint">正在运行，结果会在完成后显示。</p>';
  el('shotList').innerHTML = '';
  // 保存栏跟着镜头列表一起清 —— 否则上一轮的「已修改 N 条」会挂在新结果上，
  // 而它引用的 DOM 已经不存在了。
  const saveBar = el('promptSaveBar');
  if (saveBar) saveBar.hidden = true;
  el('mShots').textContent = '—';
  el('mDuration').textContent = '—';
  el('mCost').textContent = '—';
  el('mScore').textContent = '—';
  el('runMeta').textContent = dryRun ? '干跑预演（仅到切分层）' : '';

  renderStageTrack();
}

/* ------------------------------------------------------------ 阶段进度 */

function renderStageTrack() {
  const track = el('stageTrack');
  track.innerHTML = '';
  for (const stage of STAGES) {
    const status = state.stageStatus[stage.key] || {};
    const div = document.createElement('div');
    div.className = `stage ${status.status || ''}`;
    div.id = `stage-${stage.key}`;

    const bar = document.createElement('div');
    bar.className = 'stage-bar';
    div.appendChild(bar);

    const label = document.createElement('div');
    label.className = 'stage-label';
    const detail = state.stageDetail[stage.key];
    label.innerHTML = `${escapeHtml(stage.label)}<span class="stage-code">${escapeHtml(stage.code)}</span><span class="stage-dur">${
      escapeHtml(status.durationS ? `${status.durationS}s` : detail || '—')
    }</span>`;
    div.appendChild(label);

    track.appendChild(div);
  }
}

function handleStageEvent(event) {
  if (event.type === 'detail') {
    if (state.activeStage) {
      state.stageDetail[state.activeStage] = event.text;
      updateStageNode(state.activeStage);
    }
    return;
  }

  const key = event.stage;
  if (!key) return;

  if (event.type === 'completed') {
    state.stageStatus[key] = { status: 'done', durationS: event.durationS };
    if (state.activeStage === key) state.activeStage = null;
    // 下一层标记为进行中，界面才不会出现「全都完成后突然又动」的跳变。
    const index = STAGES.findIndex((s) => s.key === key);
    const next = STAGES[index + 1];
    if (next && !state.stageStatus[next.key]) {
      state.activeStage = next.key;
    }
  } else if (event.type === 'skipped') {
    state.stageStatus[key] = { status: 'skipped', durationS: null };
    state.stageDetail[key] = '已缓存，跳过';
  } else if (event.type === 'running') {
    state.stageStatus[key] = { status: 'active', durationS: null };
    state.activeStage = key;
  }

  renderStageTrack();
}

function updateStageNode(key) {
  const node = el(`stage-${key}`);
  if (!node) return;
  const label = node.querySelector('.stage-dur');
  const detail = state.stageDetail[key];
  if (label && detail) label.textContent = detail;
}

/* ---------------------------------------------------------------- 日志 */

function appendLog(log) {
  state.logs.push(log);
  appendLogLine(log);
  syncLogCount();
  maybeShowRawNotice();
}

/** 界面自己产生的提示（校验失败等），与 harness 日志走同一展示路径。 */
function appendLocalLog(level, message) {
  const log = { ts: timeNow(), level, logger: 'ui', msg: message };
  state.logs.push(log);
  appendLogLine(log);
  syncLogCount();
}

function syncLogCount() {
  el('logCount').textContent = `${state.logs.length} 行`;
  if (typeof state.syncLogCount === 'function') state.syncLogCount();
}

/**
 * 中英混排说明条。
 *
 * 流水线原始输出保留英文是有意为之 —— 机翻后的错误信息会丢失可搜索关键字，
 * 反而让用户查不到资料。但首次看到英文日志时容易误以为是界面没做好本地化，
 * 所以出现第一行非界面日志时补一句解释，只显示一次。
 */
function maybeShowRawNotice() {
  if (state.rawNoticeShown) return;
  const notice = el('logRawNotice');
  if (!notice) return;
  notice.hidden = false;
  state.rawNoticeShown = true;
}

function appendLogLine(log) {
  const body = el('logBody');
  const empty = body.querySelector('.empty-hint');
  if (empty) empty.remove();

  const line = document.createElement('div');
  line.className = `log-line ${log.level}`;
  line.dataset.level = log.level;

  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = log.ts || '--:--:--';

  const lv = document.createElement('span');
  lv.className = 'lv';
  lv.textContent = log.level;

  const msg = document.createElement('span');
  msg.className = 'msg';
  msg.textContent = log.msg;

  line.append(ts, lv, msg);
  body.appendChild(line);

  applyFilterTo(line);
  if (el('autoScroll').checked) body.scrollTop = body.scrollHeight;
}

function applyLogFilter() {
  for (const line of el('logBody').querySelectorAll('.log-line')) applyFilterTo(line);
}

function applyFilterTo(line) {
  const filter = el('logLevel').value;
  const level = line.dataset.level;
  const order = { ALL: 0, RAW: 1, INFO: 2, WARNING: 3, ERROR: 4, CRITICAL: 5 };
  const threshold = filter === 'ALL' ? 0 : order[filter] || 0;
  const value = level === 'RAW' ? 1 : (order[level] || 2);
  line.classList.toggle('hidden', value < threshold);
}

function clearLogs() {
  state.logs = [];
  el('logBody').innerHTML = '<p class="empty-hint">日志已清空。</p>';
  syncLogCount();
}

async function exportLogs() {
  if (!state.logs.length) {
    appendLocalLog('WARNING', '没有可导出的日志');
    return;
  }
  const content = state.logs
    .map((l) => `${l.ts || '--:--:--'} ${String(l.level).padEnd(7)} ${l.logger ? `[${l.logger}] ` : ''}${l.msg}`)
    .join('\n');
  const name = `vrh-run-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`;
  const response = await window.vrh.exportLogs(content, name);
  if (response && response.ok) {
    appendLocalLog('INFO', `日志已导出到 ${response.path}`);
  }
}

/* -------------------------------------------------------------- 成本 */

function updateCost(cost) {
  el('mCost').textContent = `$${cost.usd.toFixed(4)}`;
}

/* ---------------------------------------------------------- 结果处理 */

function handleDone(result) {
  setRunning(false);
  state.lastResult = result;

  const outcome = result.outcome;
  const artifacts = result.artifacts;

  renderResult(result, artifacts);
  updateMetrics(artifacts);

  if (outcome.kind === 'success' || outcome.kind === 'gate_failed') {
    appendLocalLog(outcome.kind === 'success' ? 'INFO' : 'WARNING', `${outcome.label}（退出码 ${result.exitCode}）`);
  } else if (outcome.kind === 'interrupted') {
    appendLocalLog('WARNING', `${outcome.label}（退出码 ${result.exitCode}）`);
  } else {
    appendLocalLog('ERROR', `${outcome.label}（退出码 ${result.exitCode}）：${outcome.message}`);
  }
}

function renderResult(result, artifacts) {
  const outcome = result.outcome;
  const body = el('resultBody');
  const badge = el('resultBadge');

  // dataset.kind 同时服务于样式与自动化检查：断言「质量门未过」确实被
  // 渲染成警告态，而不是只靠肉眼看颜色。
  el('resultBody').dataset.kind = outcome.kind;

  badge.hidden = false;
  // 中断时不要把退出码摆在徽标上。用户按了停止，进程是被 taskkill 强杀的，
  // 那个退出码只是强杀产生的副产物；把它和「已中断」并列会让人误以为出错了。
  badge.textContent = outcome.kind === 'interrupted'
    ? outcome.label
    : `${outcome.label} · 退出码 ${result.exitCode}`;
  badge.className = `badge ${outcome.kind === 'success' ? 'ok'
    : outcome.kind === 'gate_failed' ? 'warn'
    : outcome.kind === 'interrupted' ? '' : 'review'}`;

  let html = `<div class="result-callout ${outcome.kind}">
    <div class="result-callout-title">${escapeHtml(outcome.label)}</div>
    <div>${escapeHtml(outcome.message)}</div>`;

  if (outcome.kind === 'error') {
    html += `<div class="result-actions">
      <button class="btn btn-quiet" id="btnShowRaw">查看完整输出</button>
    </div>`;
  }
  html += '</div>';

  if (artifacts && artifacts.exists) {
    /*
     * 结果字段按语义分三段，而不是十几项平铺。
     * 中文读者扫读时的预期是「这是什么 → 跑得怎么样 → 东西在哪」，
     * 分段后不需要自己判断哪几项属于评测指标。
     */
    html += '<dl class="kv">';

    html += '<div class="kv-group">基本信息</div>';
    html += kv('视频标识', artifacts.videoId);
    if (artifacts.shotCount) html += kv('镜头数', artifacts.shotCount);
    if (artifacts.totalDurationS != null) html += kv('总时长', `${round(artifacts.totalDurationS, 2)} 秒`);
    if (artifacts.aspectRatio) html += kv('画幅', artifacts.aspectRatio);

    if (artifacts.score) {
      html += '<div class="kv-group">评测结果</div>';
      html += kv('综合分', `${round(artifacts.score.aggregate, 3)} / 达标线 ${artifacts.score.threshold}`);
      html += kv('CLIP 相似度', round(artifacts.score.mean_clip_similarity, 3));
      html += kv('字段准确率', round(artifacts.score.mean_field_accuracy, 3));
      html += kv('需复核镜头', `${artifacts.reviewCount} 个`);
      if (artifacts.score.cache_hit_rate != null) {
        html += kv('缓存命中率', `${round(artifacts.score.cache_hit_rate * 100, 1)}%`);
      }
    }

    html += '<div class="kv-group">产物位置</div>';
    html += kv('产物目录', artifacts.runDir);
    html += '</dl>';

    if (artifacts.prompt && artifacts.prompt.global_prompt) {
      html += `<div class="global-prompt"><span class="label">全局提示词</span>${
        escapeHtml(artifacts.prompt.global_prompt)}</div>`;
    }
  } else if (artifacts && !artifacts.exists) {
    html += '<p class="empty-hint">本次运行未产出目录（在写入产物前就结束了）。</p>';
  }

  body.innerHTML = html;

  const raw = el('btnShowRaw');
  if (raw) raw.addEventListener('click', () => showRawOutput(result));

  const reportPath = artifacts && artifacts.exists
    ? `${artifacts.runDir}\\report.html` : null;
  const reportBtn = el('btnOpenReport');
  if (reportPath) {
    reportBtn.hidden = false;
    reportBtn.onclick = () => window.vrh.openPath(reportPath);
  } else {
    reportBtn.hidden = true;
  }

  renderShotCards(artifacts);
}

function kv(label, value) {
  return `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd>`;
}

function renderShotCards(artifacts) {
  const list = el('shotList');
  list.innerHTML = '';
  if (!artifacts || !artifacts.shotCards || !artifacts.shotCards.length) return;

  const header = document.createElement('div');
  header.className = 'panel-head';
  header.innerHTML = `<h2 class="panel-title">镜头提示词（${artifacts.shotCards.length} 条）</h2>
    <div class="panel-head-actions">
      <span class="badge ${artifacts.reviewCount ? 'review' : 'ok'}">${
    artifacts.reviewCount ? `需复核 ${artifacts.reviewCount} 个` : '全部通过'}</span>
      <button class="btn btn-quiet" id="btnExportPrompt" type="button">导出提示词</button>
    </div>`;
  list.appendChild(header);

  /*
   * 提示词为何是英文的说明。
   *
   * 这是最容易被误解的一处：界面全中文，唯独提示词是英文，用户会以为是
   * 漏翻了、或是配置错了。实际是刻意的 —— 这些文本要投喂给视频生成模型
   * （i2v / t2v），英文是该领域的通用输入，中文会明显降低生成质量。
   *
   * 与其让用户自己猜，不如直接说清楚，并明确「不要改成中文」。
   */
  const langNote = document.createElement('div');
  langNote.className = 'shot-lang-note';
  langNote.innerHTML = '<b>提示词是英文，这是有意为之。</b>'
    + '它们会直接投喂给视频生成模型，英文是该领域的通用输入，'
    + '改成中文会明显降低生成质量。下方的中文标签只用于说明结构，不参与生成。';
  list.appendChild(langNote);

  for (const card of artifacts.shotCards) {
    list.appendChild(buildShotCard(card));
  }

  // 顶部工具栏的按钮要在插入 DOM 之后再绑定（header 是 innerHTML 生成的）。
  const exportBtn = document.getElementById('btnExportPrompt');
  if (exportBtn) exportBtn.addEventListener('click', exportPromptFile);
}

/** 单张镜头卡片。可编辑的部分只有提示词与负向提示词。 */
function buildShotCard(card) {
  const node = document.createElement('div');
  node.className = `shot-card${card.needsReview ? ' review' : ''}`;
  node.dataset.shotId = String(card.shotId);

  // 原始值挂在 dataset 上：用于「有没有改过」的判断，也用于撤回。
  node.dataset.originalPrompt = card.prompt || '';
  node.dataset.originalNegative = card.negativePrompt || '';

  /*
   * 结构化槽位。
   *
   * harness 的 slots 键名是英文（subject / action / scene / ...），而这些值
   * 本来就拼进了英文提示词里，所以键名保持英文与产物一致。但**界面是全中文的**，
   * 直接显示 `subject:` 就成了最突兀的一处中英混排 —— 用户会以为是没翻译完。
   *
   * 解法：显示中文标签，英文键名放进 title 作为对照（鼠标悬停可见）。
   * 这样既读得懂，也能和 prompt.json 里的字段对应上。
   */
  const SLOT_LABELS = {
    subject: '主体',
    action: '动作',
    scene: '场景',
    camera: '运镜',
    lighting: '光照',
    style: '风格',
  };

  const slots = Object.keys(SLOT_LABELS)
    .filter((k) => card.slots && card.slots[k])
    .map((k) => `<span title="${k}（产物中的字段名）"><b>${escapeHtml(SLOT_LABELS[k])}</b>：${escapeHtml(card.slots[k])}</span>`)
    .join('');

  const issues = card.issues && card.issues.length
    ? `<ul class="shot-issues">${card.issues.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`
    : '';

  node.innerHTML = `
    <div class="shot-head">
      <span class="shot-id">${String(card.shotId).padStart(4, '0')}</span>
      <span class="shot-time">${round(card.startS, 2)}–${round(card.endS, 2)}s</span>
      <span class="badge ${card.needsReview ? 'review' : ''}">置信度 ${round(card.confidence, 2)}</span>
      ${card.clipSimilarity != null ? `<span class="badge">CLIP ${round(card.clipSimilarity, 3)}</span>` : ''}
      <button class="btn btn-quiet shot-edit-toggle" type="button">编辑</button>
    </div>
    <div class="shot-prompt-view">
      <p class="shot-prompt">${escapeHtml(card.prompt)}</p>
      ${card.negativePrompt ? `<p class="shot-negative"><b>负向：</b>${escapeHtml(card.negativePrompt)}</p>` : ''}
    </div>
    <div class="shot-prompt-edit" hidden>
      <label class="shot-field">
        <span class="shot-field-label">提示词</span>
        <textarea class="shot-input" rows="3" data-field="prompt">${escapeHtml(card.prompt)}</textarea>
      </label>
      <label class="shot-field">
        <span class="shot-field-label">负向提示词</span>
        <textarea class="shot-input" rows="2" data-field="negativePrompt">${escapeHtml(card.negativePrompt || '')}</textarea>
      </label>
      <div class="shot-edit-actions">
        <button class="btn btn-quiet shot-revert" type="button">撤回本条</button>
        <span class="shot-edit-hint">改动会在点「保存修改」后写入 prompt.json（首次保存会自动备份）</span>
      </div>
    </div>
    ${issues}
    ${slots ? `<div class="shot-slots">${slots}</div>` : ''}
  `;

  wireShotCard(node);
  return node;
}

/** 单张卡片的编辑交互。 */
function wireShotCard(node) {
  const toggle = node.querySelector('.shot-edit-toggle');
  const editBox = node.querySelector('.shot-prompt-edit');
  const viewBox = node.querySelector('.shot-prompt-view');
  const inputs = [...node.querySelectorAll('.shot-input')];

  toggle.addEventListener('click', () => {
    const opening = editBox.hidden;
    editBox.hidden = !opening;
    viewBox.hidden = opening;
    toggle.textContent = opening ? '收起' : '编辑';
    if (opening) inputs[0].focus();
  });

  // 输入即标记「已改」，让保存按钮能反映未保存状态。
  for (const input of inputs) {
    input.addEventListener('input', () => {
      node.classList.add('dirty');
      updateSaveBar();
    });
  }

  node.querySelector('.shot-revert').addEventListener('click', () => {
    node.querySelector('[data-field="prompt"]').value = node.dataset.originalPrompt;
    node.querySelector('[data-field="negativePrompt"]').value = node.dataset.originalNegative;
    node.classList.remove('dirty');
    updateSaveBar();
  });
}

/** 收集界面上所有被修改过的镜头。 */
function collectPromptEdits() {
  const edits = [];
  for (const node of document.querySelectorAll('#shotList .shot-card')) {
    if (!node.classList.contains('dirty')) continue;
    const prompt = node.querySelector('[data-field="prompt"]').value;
    const negative = node.querySelector('[data-field="negativePrompt"]').value;
    if (prompt === node.dataset.originalPrompt && negative === node.dataset.originalNegative) {
      // 改回去了，不算修改
      node.classList.remove('dirty');
      continue;
    }
    edits.push({
      shotId: Number(node.dataset.shotId),
      prompt,
      negativePrompt: negative,
    });
  }
  return edits;
}

/** 保存栏的显示状态：无改动时隐藏，避免占位。 */
function updateSaveBar() {
  const bar = el('promptSaveBar');
  if (!bar) return;
  const edits = collectPromptEdits();
  const count = edits.length;
  bar.hidden = count === 0;
  if (count) {
    el('promptSaveCount').textContent = `已修改 ${count} 条`;
    el('btnSavePrompt').disabled = false;
  }
}

/** 保存修改到 prompt.json。 */
async function savePromptEdits() {
  const artifacts = state.lastResult && state.lastResult.artifacts;
  const videoPath = el('videoPath').value.trim();
  if (!artifacts || !videoPath) {
    await showNotice('无法保存', ['缺少产物信息或视频路径。']);
    return;
  }

  const edits = collectPromptEdits();
  if (!edits.length) return;

  const btn = el('btnSavePrompt');
  btn.disabled = true;
  btn.textContent = '保存中…';

  let result;
  try {
    result = await window.vrh.savePrompt({
      videoPath,
      expectedShotCount: artifacts.shotCards.length,
      shots: edits,
    });
  } catch (error) {
    result = { ok: false, message: error.message };
  } finally {
    btn.textContent = '保存修改';
  }

  if (!result.ok) {
    btn.disabled = false;
    await showNotice('保存失败', [result.message]);
    return;
  }

  // 保存成功：把 dataset 的原值更新为当前值，这样「未保存」状态被清掉，
  // 但用户仍可继续编辑（此时相对的是新值）。
  for (const node of document.querySelectorAll('#shotList .shot-card.dirty')) {
    node.dataset.originalPrompt = node.querySelector('[data-field="prompt"]').value;
    node.dataset.originalNegative = node.querySelector('[data-field="negativePrompt"]').value;
    node.classList.remove('dirty');
    // 同步回只读视图，让收起后看到的就是新内容
    node.querySelector('.shot-prompt-view .shot-prompt').textContent = node.dataset.originalPrompt;
  }
  updateSaveBar();

  const notes = [`已写入 ${result.changed} 条修改。`];
  if (result.backedUp) notes.push(`原始文件已备份为 prompt.json.bak`);
  // 保存后会与 score.json 不再对应 —— 评分是按旧提示词算的，必须说明。
  notes.push('注意：评分与字段准确率仍是修改前的计算结果，需要重新跑评测才会更新。');
  await showNotice('保存完成', notes);
}

/** 导出 prompt.json 副本。 */
async function exportPromptFile() {
  const videoPath = el('videoPath').value.trim();
  if (!videoPath) {
    await showNotice('无法导出', ['请先选择视频并完成一次运行。']);
    return;
  }
  const result = await window.vrh.exportPrompt(videoPath);
  if (result.canceled) return;
  await showNotice(
    result.ok ? '导出完成' : '导出失败',
    [result.ok ? `已保存到：\n${result.path}` : result.message]
  );
}

/**
 * 撤回全部未保存的改动。
 *
 * 只在有改动时才有意义，所以放在保存栏里；不需要二次确认 ——
 * 撤回的是「还没写进文件的东西」，代价仅仅是重新输入，
 * 而弹确认框会拖慢「改错了想重来」这个高频动作。
 */
function discardPromptEdits() {
  for (const node of document.querySelectorAll('#shotList .shot-card')) {
    node.querySelector('[data-field="prompt"]').value = node.dataset.originalPrompt;
    node.querySelector('[data-field="negativePrompt"]').value = node.dataset.originalNegative;
    node.classList.remove('dirty');
    // 顺带收起编辑态，避免用户以为改动还留着
    const editBox = node.querySelector('.shot-prompt-edit');
    const viewBox = node.querySelector('.shot-prompt-view');
    const toggle = node.querySelector('.shot-edit-toggle');
    if (editBox && !editBox.hidden) {
      editBox.hidden = true;
      viewBox.hidden = false;
      toggle.textContent = '编辑';
    }
  }
  updateSaveBar();
}

function showRawOutput(result) {
  el('errorDialogTitle').textContent = `${result.outcome.label} · 退出码 ${result.exitCode}`;
  el('errorDialogMessage').textContent = result.outcome.message;

  const parts = [];
  if (result.report && result.report.trim()) {
    parts.push('--- stdout ---', result.report.trim());
  }
  if (result.stderrTail && result.stderrTail.trim()) {
    parts.push('', '--- stderr ---', result.stderrTail.trim());
  }
  parts.push('', '--- 提示 ---',
    '如需完整堆栈，可在命令行加 --log-level DEBUG 重跑。');
  el('errorDialogRaw').textContent = parts.join('\n');
  el('errorDialog').showModal();
}

/**
 * 通用提示对话框。复用错误对话框的 DOM（同一时刻只会有一个模态），
 * 避免为了几句提示再加一套弹窗结构。
 *
 * lines 里空字符串会被过滤 —— 调用方常写 [a, b].filter(Boolean)，这里再兜一层。
 */
function showNotice(title, lines) {
  el('errorDialogTitle').textContent = title;
  el('errorDialogMessage').textContent = '';
  el('errorDialogRaw').textContent = (lines || []).filter(Boolean).join('\n\n');
  el('errorDialog').showModal();
}

function updateMetrics(artifacts) {
  if (!artifacts || !artifacts.exists) return;
  if (artifacts.shotCount) el('mShots').textContent = String(artifacts.shotCount);
  if (artifacts.totalDurationS != null) {
    el('mDuration').textContent = `${round(artifacts.totalDurationS, 1)}s`;
  }
  if (artifacts.score) {
    el('mScore').textContent = round(artifacts.score.aggregate, 3);
    if (artifacts.score.cost_usd != null) {
      el('mCost').textContent = `$${Number(artifacts.score.cost_usd).toFixed(4)}`;
    }
  }
}

/* ---------------------------------------------------------------- 工具 */

async function openOutputDir() {
  const artifacts = state.lastResult && state.lastResult.artifacts;
  if (!artifacts || !artifacts.runDir) {
    appendLocalLog('WARNING', '尚无产物目录');
    return;
  }
  await window.vrh.reveal(artifacts.runDir);
}

async function openReport() {
  const artifacts = state.lastResult && state.lastResult.artifacts;
  if (!artifacts || !artifacts.runDir) return;
  await window.vrh.openPath(`${artifacts.runDir}\\report.html`);
}

function round(value, digits) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return Number(value).toFixed(digits);
}

function timeNow() {
  return new Date().toTimeString().slice(0, 8);
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ------------------------------------------------------- 自动化测试钩子 */

/**
 * 仅供 `--smoke=` 冒烟测试使用。
 *
 * 它不绕过任何逻辑 —— `__smokeSetConfig` 写的是与用户手填完全相同的表单字段，
 * `__smokeRun` 调的就是「开始运行」按钮绑定的那个 startRun。这样截图里显示的
 * 就是用户真会看到的界面，而不是一条专门为测试铺的捷径。
 */
if (typeof window !== 'undefined') {
  window.__smokeSetConfig = (config) => {
    if (!config) return;
    const setField = (id, value) => {
      const node = el(id);
      if (!node || value == null) return;
      if (node.type === 'checkbox') {
        node.checked = Boolean(value);
      } else {
        node.value = String(value);
      }
      node.dispatchEvent(new Event('change'));
      node.dispatchEvent(new Event('input'));
    };

    setField('videoPath', config.videoPath);
    setField('preset', config.preset);
    setField('keyframeStrategy', config.keyframeStrategy);
    setField('cutThreshold', config.cutThreshold);
    setField('framesPerShot', config.framesPerShot);

    // 质量门：不显式打开就不会有退出码 2，gate 场景必须先开这个。
    if (config.verify != null) {
      const verify = el('verify');
      verify.checked = Boolean(config.verify);
      verify.dispatchEvent(new Event('change'));
    }
    setField('threshold', config.threshold);
    setField('rounds', config.rounds);

    // failOnGate 默认勾选才会以退出码 2 结束，这是 gate 场景的关键开关。
    setField('failOnGate', config.failOnGate);

    setField('noMotion', config.noMotion);
    // fresh 用于强制重跑，验证「不命中缓存」路径下阶段条是否正常推进。
    setField('fresh', config.fresh);

    if (config.runMode === 'until') {
      const radio = document.querySelector('input[name="scope"][value="until"]');
      if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change')); }
    }
  };
}

init();
