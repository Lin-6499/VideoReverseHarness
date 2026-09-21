'use strict';

/**
 * Electron 主进程。
 *
 * 这是整个应用里唯一有权 spawn 子进程的层。渲染进程通过 preload 暴露的窄接口
 * 请求它做事 —— `nodeIntegration: false` + `contextIsolation: true`，界面拿不到
 * Node API，也就无法绕过这里直接执行命令。
 *
 * 职责边界：主进程做「有副作用的事」（起进程、读文件），渲染进程只做 UI。
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');

const environment = require('./environment');
const runner = require('./runner');
const artifacts = require('./artifacts');
const notice = require('./harness-notice');
const modelConfig = require('./model-config');

let mainWindow = null;
let activeRun = null;

// --------------------------------------------------------------------------- //
// 用户配置持久化
// --------------------------------------------------------------------------- //

/**
 * 配置文件放在 userData 而非应用目录。
 *
 * 打包后的应用目录可能是只读的（Program Files）或每次解包重置的（portable），
 * 写在那里会丢。userData 是 %APPDATA%\<productName>，跨版本升级也保留。
 */
function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function readConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // 首次启动没有配置文件属正常情况，不是错误。
    return {};
  }
}

function writeConfig(patch) {
  const merged = { ...readConfig(), ...patch };
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2), 'utf8');
    return true;
  } catch {
    // 写不进去不该阻断主流程 —— 用户本次仍可用，只是下次要重选。
    return false;
  }
}

/** 用户手选的 harness 目录（未选过则为 undefined）。 */
function userRepoRoot() {
  const value = readConfig().repoRoot;
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * 窗口图标路径（不存在时返回 null）。
 *
 * 开发态在 desktop/build/icon.png；打包后 electron-builder 会把
 * buildResources 排除在 asar 之外，此时靠 exe 自身嵌入的图标，
 * 窗口图标留空也不影响观感 —— 所以这里只是「有就用」，不报错。
 */
function iconPath() {
  const candidates = [
    path.join(__dirname, '..', '..', 'build', 'icon.png'),
    path.join(process.resourcesPath || '', 'build', 'icon.png'),
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch { /* 忽略 */ }
  }
  return null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    // 下限必须留到窄屏断点（<900px）以下，否则响应式样式永远触发不了 ——
    // 用户把窗口缩到 1040 就被挡住了，单列布局形同虚设。
    minWidth: 360,
    minHeight: 480,
    title: 'VRH — 视频反推',
    backgroundColor: '#14161a',
    // 窗口图标用 512 的 PNG（.ico 交给 exe 资源，窗口这里 PNG 更稳）。
    // 打包后 build/ 不在 asar 里，所以用存在性判断兜一层 —— 缺图标不该让应用起不来。
    ...(iconPath() ? { icon: iconPath() } : {}),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      // 安全边界：界面脚本不得直接访问 Node。
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 等首帧就绪再显示，避免白屏闪烁。
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (process.argv.includes('--dev')) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 外部链接交给系统浏览器，不在应用窗口里打开。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// --------------------------------------------------------------------------- //
// IPC 处理
// --------------------------------------------------------------------------- //

/** 环境探测。界面启动时调用一次，之后可由用户手动重试。 */
ipcMain.handle('vrh:doctor', async () => {
  try {
    return await environment.doctor(userRepoRoot());
  } catch (error) {
    return {
      ok: false,
      canRun: false,
      problems: [{ kind: 'unknown', message: `环境探测失败：${error.message}`, hint: '' }],
    };
  }
});

/**
 * 让用户手动指定 harness 目录。
 *
 * 打包分发后应用无法再靠相对路径猜出 harness 在哪（它不会被打进 exe），
 * 这条通道是唯一的退路。选中后立刻校验，通过才持久化 —— 否则用户会陷入
 * 「选了但没用，且不知道下次还会不会被记住」的困惑。
 */
ipcMain.handle('vrh:pick-repo', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 harness 文件夹',
    properties: ['openDirectory'],
    buttonLabel: '使用此目录',
  });
  if (result.canceled || !result.filePaths.length) {
    return { ok: false, canceled: true };
  }

  const chosen = result.filePaths[0];
  if (!environment.looksLikeRepoRoot(chosen)) {
    return {
      ok: false,
      canceled: false,
      message: '这个文件夹不像是 harness',
      detail: [
        'harness 文件夹里应该有 src、.venv、tools 这几个子文件夹。',
        '如果你选中的是它们的上一级或下一级，请改选正确的那一层。',
        '',
        `你选的是：${chosen}`,
      ].join('\n'),
    };
  }

  writeConfig({ repoRoot: chosen });
  const env = await environment.doctor(chosen);
  return { ok: true, repoRoot: chosen, env };
});

/** 清除手选的 harness 目录，回到自动查找。 */
ipcMain.handle('vrh:clear-repo', async () => {
  writeConfig({ repoRoot: null });
  return { ok: true, env: await environment.doctor(undefined) };
});

/**
 * 打开「harness 放置说明」。
 *
 * 用户点这个按钮时，处境几乎一定是「程序跑不起来、不知道该把 harness 放哪」。
 * 所以这里绝不能失败：
 *   1. 优先打开程序目录里那份说明（随 zip 分发、或用便携目录自带的）
 *   2. 找不到就**现写一份**到临时目录再打开 —— 而不是报「文件不存在」
 *   3. 连临时目录都写不进去时，退回把正文显示在弹窗里，而不是无声失败
 *
 * 另外顺手把说明补写进程序目录（如果之前没有）。便携目录是用户自己的文件夹，
 * 写一份说明进去成本极低，但下次他再遇到问题就有东西可看。
 */
ipcMain.handle('vrh:open-notice', async () => {
  const exeDir = path.dirname(app.getPath('exe'));
  const searchDirs = app.isPackaged
    ? [exeDir, process.cwd()]
    : [path.join(__dirname, '..', '..'), exeDir, process.cwd()];

  // 1. 已有说明：直接打开。
  const existing = notice.findNotice(searchDirs);
  if (existing) {
    const error = await shell.openPath(existing);
    if (!error) {
      return { ok: true, path: existing, action: 'opened' };
    }
    // 打不开（极少见：默认程序被改坏）→ 走下面的弹窗兜底。
    return showNoticeInDialog(existing, error);
  }

  // 2. 没有说明：写一份到程序目录再打开。用户自己的目录，可写性通常没问题。
  try {
    const written = notice.writeNotice(exeDir, { programDir: exeDir });
    const error = await shell.openPath(written);
    if (!error) return { ok: true, path: written, action: 'created' };
    return showNoticeInDialog(written, error);
  } catch (writeError) {
    // 3. 程序目录写不进去（如装在 Program Files 且无权限）→ 用弹窗显示正文。
    return showNoticeInDialog(null, writeError.message);
  }
});

/**
 * 兜底：把说明正文显示在弹窗里。
 *
 * 为什么要有这条路径：用户点「放置说明」时正是最需要帮助的时刻，
 * 此时报「无法打开文件」等于把他推回原点。弹窗显示正文虽然朴素，
 * 但信息完整、必定可用。
 */
async function showNoticeInDialog(attemptedPath, reason) {
  const detail = attemptedPath
    ? `无法打开文件：${attemptedPath}\n原因：${reason}`
    : `无法写入说明文件。原因：${reason}`;
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'harness 放置说明',
    message: '程序需要先找到 harness 文件夹才能工作',
    detail: `${detail}\n\n${notice.buildNoticeText({ programDir: path.dirname(app.getPath('exe')) })}`,
    buttons: ['知道了'],
    noLink: true,
  });
  return { ok: true, path: attemptedPath, action: 'dialog' };
}

/** 选择视频文件。返回绝对路径。 */
ipcMain.handle('vrh:pick-video', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择视频文件',
    properties: ['openFile'],
    filters: [
      { name: '视频', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

/** 启动一次运行。 */
ipcMain.handle('vrh:run', async (_event, config) => {
  if (activeRun) {
    return { ok: false, message: '已有运行在进行中' };
  }

  const env = await environment.doctor(userRepoRoot());
  if (!env.canRun) {
    return { ok: false, message: '环境未就绪，无法启动运行' };
  }

  if (!config.videoPath) {
    return { ok: false, message: '请先选择视频文件' };
  }
  if (!fs.existsSync(config.videoPath)) {
    return { ok: false, message: `视频文件不存在：${config.videoPath}` };
  }

  activeRun = runner.startRun(
    config,
    { pythonPath: env.python.path, repoRoot: env.repoRoot },
    {
      onLog: (log) => send('vrh:log', log),
      onStage: (event) => send('vrh:stage', event),
      onCost: (cost) => send('vrh:cost', cost),
      onCommand: (command) => send('vrh:command', command),
      onDone: (result) => {
        activeRun = null;
        // 产物在子进程完全退出后才可靠，这里统一读取后再通知界面。
        let collected = null;
        try {
          collected = artifacts.collectArtifacts(
            path.join(env.repoRoot, 'output'),
            config.videoPath
          );
        } catch {
          collected = null;
        }
        send('vrh:done', { ...result, artifacts: collected });
      },
    }
  );

  return { ok: true, pid: activeRun.pid };
});

/** 停止当前运行。 */
ipcMain.handle('vrh:stop', async () => {
  if (!activeRun) return { ok: false, message: '当前没有运行中的任务' };
  const stopped = activeRun.stop();
  return { ok: stopped, message: stopped ? '已发送停止信号' : '停止失败' };
});

/** 读取已有产物（用于打开历史结果）。 */
ipcMain.handle('vrh:artifacts', async (_event, videoPath) => {
  const env = await environment.doctor(userRepoRoot());
  if (!env.python || !env.repoRoot) return null;
  try {
    return artifacts.collectArtifacts(path.join(env.repoRoot, 'output'), videoPath);
  } catch {
    return null;
  }
});

/**
 * 保存用户对镜头提示词的修改，写回 prompt.json。
 *
 * 每次都重新探测环境取 runDir，而不信任界面传来的路径 —— 渲染进程是
 * 不可信边界，让它指定任意写入位置等于把文件系统交出去。
 */
ipcMain.handle('vrh:save-prompt', async (_event, edits) => {
  const env = await environment.doctor(userRepoRoot());
  if (!env.repoRoot || !edits || !edits.videoPath) {
    return { ok: false, message: '环境未就绪或参数缺失' };
  }
  const id = artifacts.videoId(edits.videoPath);
  const runDir = path.join(env.repoRoot, 'output', id);
  return artifacts.savePromptEdits(runDir, edits);
});

/** 把当前 prompt.json 另存为。 */
ipcMain.handle('vrh:export-prompt', async (_event, { videoPath, defaultName }) => {
  const env = await environment.doctor(userRepoRoot());
  if (!env.repoRoot || !videoPath) return { ok: false, message: '环境未就绪' };

  const id = artifacts.videoId(videoPath);
  const runDir = path.join(env.repoRoot, 'output', id);

  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出提示词',
    defaultPath: defaultName || `prompt-${id}.json`,
    filters: [
      { name: 'JSON', extensions: ['json'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };

  return artifacts.exportPrompt(runDir, result.filePath);
});

/** 在文件管理器中定位产物目录。 */
ipcMain.handle('vrh:reveal', async (_event, targetPath) => {
  if (targetPath && fs.existsSync(targetPath)) {
    shell.showItemInFolder(targetPath);
    return true;
  }
  return false;
});

/** 用系统默认程序打开文件（例如 report.html）。 */
ipcMain.handle('vrh:open-path', async (_event, targetPath) => {
  if (targetPath && fs.existsSync(targetPath)) {
    await shell.openPath(targetPath);
    return true;
  }
  return false;
});

/** 把日志导出到用户选择的文件。 */
ipcMain.handle('vrh:export-logs', async (_event, { content, defaultName }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出日志',
    defaultPath: defaultName || 'vrh-run.log',
    filters: [{ name: '日志', extensions: ['log', 'txt', 'json'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false };
  fs.writeFileSync(result.filePath, content, 'utf8');
  return { ok: true, path: result.filePath };
});

/** 读取 harness 已有的预设列表，供界面下拉框使用。 */
ipcMain.handle('vrh:presets', async () => {
  const env = await environment.doctor(userRepoRoot());
  if (!env.repoRoot) return [];
  const dir = path.join(env.repoRoot, 'configs', 'presets');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => f.replace(/\.yaml$/, ''));
  } catch {
    return [];
  }
});

// --------------------------------------------------------------------------- //
// 模型配置
// --------------------------------------------------------------------------- //

/**
 * 定位 `test-model.py` 的**真实文件系统路径**（可交给外部进程的那种）。
 *
 * ── 为什么不能直接用 path.join(__dirname, ...) ──────────────────────
 * Python **无法读取 asar 内部的路径** —— 它只是普通的文件读取，不知道 asar
 * 是归档格式。打包后 `__dirname` 指向 `app.asar/src/main`，于是 spawn 出去的
 * Python 会报 `can't open file`，而错误信息看起来像路径拼错，很容易查错方向。
 *
 * 解法是 `asarUnpack`：让 electron-builder 把这个文件额外释放到
 * `app.asar.unpacked/` 的真实目录下，路径规则就是简单地把 `app.asar`
 * 替换成 `app.asar.unpacked`。
 *
 * ── 顺序很关键：必须先试 unpacked，再试 __dirname ──────────────────
 * 第一版是反过来写的（先试 packed，存在就返回），打包态实测**直接踩坑**：
 * Electron 给 `fs` 打了 asar 补丁，`fs.existsSync('.../app.asar/src/main/x.py')`
 * 会返回 `true`（Electron 自己能透明读 asar），于是它返回了 asar 内路径、
 * 再也没走到 unpacked 分支 —— 而把这条路径交给 Python 就是 `can't open file`。
 *
 * 也就是说：`existsSync` 为真**不代表**「外部进程读得到」。这个区别只在
 * 「Electron 内部的 fs」与「Electron 之外的进程」之间才显现，所以开发态
 * 与单纯读代码都发现不了，只能靠打包态实跑。
 *
 * 因此这里判断的是「**路径里有没有 asar**」这个结构性事实，而不是依赖
 * existsSync 的返回 —— 只要 `__dirname` 落在 asar 内，就一律改走 unpacked。
 * 开发态 `__dirname` 不含 asar，第一条分支自然不成立，直接返回原路径。
 */
function testScriptPath() {
  const asarSegment = `${path.sep}app.asar${path.sep}`;
  const direct = path.join(__dirname, 'test-model.py');

  // 路径落在 asar 内：必须换到 unpacked 的真实目录，否则外部进程读不到。
  if (direct.includes(asarSegment)) {
    const unpacked = direct.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`);
    if (fs.existsSync(unpacked)) return unpacked;
    // unpacked 不存在说明 asarUnpack 配置漏了，交给调用方给明确报错。
    return null;
  }

  // 开发态（或未打包运行）：__dirname 就是真实目录，直接可用。
  if (fs.existsSync(direct)) return direct;

  // 兜底：某些布局下 asar 可能不在 __dirname 的上级，用 app.getAppPath() 再试一次。
  const appPath = app.getAppPath();
  if (appPath.includes(asarSegment)) {
    const fromAppPath = path
      .join(appPath, 'src', 'main', 'test-model.py')
      .replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`);
    if (fs.existsSync(fromAppPath)) return fromAppPath;
  }

  return null;
}

ipcMain.handle('vrh:load-model-config', async () => modelConfig.load());

ipcMain.handle('vrh:save-model-config', async (_event, config) => {
  try {
    const normalized = modelConfig.normalize(config);
    if (!normalized.ok) return { ok: false, message: normalized.message };
    modelConfig.save(normalized.config);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: `保存失败：${error.message}` };
  }
});

/**
 * 测试模型连通性。
 *
 * 为什么值得单独做一个功能：模型配置有三处可能出错 —— Key 无效、地址写错、
 * 模型名不存在 —— 而它们的报错都发生在流水线第 3 层。用户要先等前面的
 * 解析与切分跑完（几十秒到几分钟）才会看到失败，且日志里混在大量输出中。
 * 这里提前用一张极小的图打一次请求，把「三选一」的排查压缩成一次点击。
 *
 * 实现上直接调用 harness 自己的 provider —— 复用它的错误语义与请求形状，
 * 而不是在 Electron 里另写一份 HTTP 逻辑（那样两边会漂移，测试通过但实际跑不通）。
 */
ipcMain.handle('vrh:test-model', async (_event, config) => {
  const env = await environment.doctor(userRepoRoot());
  if (!env.repoRoot || !env.python || !env.python.path) {
    return { ok: false, message: 'harness 环境未就绪，无法测试模型连接' };
  }

  const normalized = modelConfig.normalize(config);
  if (!normalized.ok) return { ok: false, message: normalized.message };

  // 离线占位不需要联网，直接说明它可用即可 —— 别去发一个假的真请求。
  if (normalized.config.provider === 'fake') {
    return { ok: true, detail: '离线占位可用（不调用模型，无网络请求）' };
  }

  const script = testScriptPath();
  if (!script) {
    return {
      ok: false,
      message: '测试脚本未随程序一起打包（test-model.py 缺失），请重新打包',
    };
  }
  const child = spawn(env.python.path, [script], {
    cwd: env.repoRoot,
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      // 与真实运行走完全相同的注入路径 —— 否则测通了但跑不通。
      ...modelConfig.toEnv(normalized.config),
    },
    windowsHide: true,
  });

  const result = await new Promise((resolve) => {
    let out = '';
    let err = '';
    // 超时兜底：网络挂起时不能让界面永远停在「正在测试…」。
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      resolve({ ok: false, message: '测试超时（超过 60 秒无响应）' });
    }, 60000);

    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, message: `无法启动测试进程：${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, detail: out.trim() || '连接正常' });
      else resolve({ ok: false, message: (err.trim() || out.trim() || `进程退出码 ${code}`).slice(0, 600) });
    });
  });

  return result;
});

// --------------------------------------------------------------------------- //
// 生命周期
// --------------------------------------------------------------------------- //

/*
 * 支持 `--debug-port=<端口>` 开启 Chromium 调试端口。
 *
 * 为什么需要这个开关，而不能直接传 `--remote-debugging-port`：
 * 打包后的 Electron 应用按自己的规则解析 argv，不认识的开关会直接报
 * 「bad option」并退出 —— 也就是「想让外部调试打包产物」这件事本身就做不到。
 * 而打包态又恰恰是最需要外部验证的形态（诊断脚本都已排除在 asar 之外）。
 *
 * 所以这里显式接受一个自有开关，在 app ready 之前把它转成 Chromium 开关。
 * 用 `=` 传值而非空格，是为了避开 argv 解析的歧义（与 --smoke= / --procs= 一致）。
 */
const debugPortArg = process.argv.find((a) => a.startsWith('--debug-port='));
if (debugPortArg) {
  const port = Number(debugPortArg.slice('--debug-port='.length));
  // 只接受合法端口号，避免把任意字符串塞进 Chromium 开关。
  if (Number.isInteger(port) && port > 0 && port < 65536) {
    app.commandLine.appendSwitch('remote-debugging-port', String(port));
    // 允许从本机任意来源连入调试端口（仅本机，不监听外部地址）。
    app.commandLine.appendSwitch('remote-allow-origins', '*');
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // 界面冒烟测试：非交互环境下驱动真实界面并截图。
  // 用 `npm start -- --smoke=<场景>` 触发，正常使用时完全不参与。
  const smokeArg = process.argv.find((a) => a.startsWith('--smoke='));
  if (smokeArg) {
    require('./smoke').run(mainWindow, smokeArg.slice('--smoke='.length));
  }

  // 布局度量：打印各区域实际几何尺寸，用于定位裁切与溢出。
  if (process.argv.includes('--measure') || process.argv.some((a) => a.startsWith('--measure='))) {
    require('./measure').measure(mainWindow).then(() => {
      setTimeout(() => app.exit(0), 300);
    });
  }

  // 首屏填充检查：核对由 JS 异步填充的控件（预设、阶段标签、命令预览）是否到位。
  if (process.argv.includes('--fill')) {
    require('./fill').checkFill(mainWindow).then(({ problems }) => {
      setTimeout(() => app.exit(problems.length ? 1 : 0), 300);
    });
  }

  // 停止操作的进程树验证：确认点停止后 Python 与 ffmpeg 真的消失，
  // 而不只是界面上显示「已中断」。
  // 用 --procs=1 而不是裸 --procs：Electron 会吞掉它不认识的裸参数，
  // 导致应用根本没启动（表现为 ipcMain undefined）。
  if (process.argv.some((a) => a.startsWith('--procs='))) {
    require('./procs').run(mainWindow).then(({ problems, skipped }) => {
      // skipped 表示「没等到可中断的窗口」，属于采样作废而非验证失败，
      // 不应报错退出 —— 否则会被误读成发现了缺陷。
      setTimeout(() => app.exit(skipped ? 0 : (problems.length ? 1 : 0)), 400);
    });
  }

  // 水平溢出定位：找出究竟是哪个元素撑破了视口。
  const overflowArg = process.argv.find((a) => a.startsWith('--overflow='));
  if (overflowArg) {
    const [w, h] = overflowArg.slice('--overflow='.length).split('x').map(Number);
    require('./overflow').findOverflow(mainWindow, w, h).then(() => {
      setTimeout(() => app.exit(0), 300);
    });
  }
});

app.on('window-all-closed', () => {
  // 关窗前先清理子进程，避免残留的 Python/ffmpeg 继续占用资源。
  if (activeRun) activeRun.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (activeRun) activeRun.stop();
});
