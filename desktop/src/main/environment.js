'use strict';

/**
 * 环境探测。
 *
 * 界面上的「运行」按钮是否可用，完全取决于这里的结果 —— 与其等用户点了运行再
 * 报错，不如启动时就探测清楚，把不可用的原因直接摆在界面上。
 *
 * 探测三项：venv 里的 Python、ffmpeg（含 harness 的 tools/ 优先级）、harness 版本。
 *
 * ── repoRoot 的解析（打包后与本仓库开发时行为不同，注意）────────────────
 *
 * 开发态 desktop/ 是 harness 的子目录，上溯三级即得仓库根。但打包成 exe 后
 * 源码进了 app.asar，`__dirname` 指向归档内部，再上溯三级毫无意义 —— 这条
 * 路径假设会静默失效，表现为界面报「找不到 Python」。
 *
 * 所以改成**候选链**：按可靠性从高到低逐个尝试，每个候选都要通过
 * 「看起来像 harness 仓库」的校验才算命中。这样 exe 放在 harness 旁边、
 * 放在上一级、或由用户手动指定，都能工作。
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/** 打包后为 true：源码已进 asar，__dirname 不再指向磁盘上的真实目录。 */
function isPackaged() {
  return Boolean(process.resourcesPath) && __dirname.includes('app.asar');
}

/**
 * 判断一个目录是否像 harness 仓库根。
 *
 * 必须同时满足两条，单看任一条都会误判：
 *   1. `vrh` 包可定位 —— 本项目是 src-layout（pyproject 里
 *      `[tool.setuptools.packages.find] where = ["src"]`），包在 src/vrh/。
 *      同时也接受根级 vrh/，以防将来布局变化。
 *   2. `.venv` 虚拟环境存在 —— 光有源码跑不起来，依赖装在 venv 里。
 *
 * 只查 vrh/ 会把「源码在但环境没建」的目录误判为可用，用户接着会撞上
 * 「找不到 Python」；只查 .venv 则几乎任何 Python 项目都能通过。
 */
function looksLikeRepoRoot(dir) {
  if (!dir) return false;
  try {
    const hasPackage = [
      path.join(dir, 'src', 'vrh', 'cli.py'),
      path.join(dir, 'src', 'vrh', '__init__.py'),
      path.join(dir, 'vrh', 'cli.py'),
      path.join(dir, 'vrh', '__init__.py'),
    ].some((p) => fs.existsSync(p));
    if (!hasPackage) return false;

    const venvPy = process.platform === 'win32'
      ? path.join(dir, '.venv', 'Scripts', 'python.exe')
      : path.join(dir, '.venv', 'bin', 'python');
    return fs.existsSync(venvPy);
  } catch {
    return false;
  }
}

/**
 * exe 所在目录。开发态（electron .）返回 desktop/，打包后返回 exe 所在目录。
 */
function executableDir() {
  if (!isPackaged()) {
    return path.resolve(__dirname, '..', '..');
  }
  // process.execPath 是 exe 全路径；portable 版解包后可能带 app-* 临时目录，
  // 但 electron-builder 的 dir/target 模式下就是 exe 的同级目录。
  return path.dirname(process.execPath);
}

/**
 * 上溯的最大级数。
 *
 * 为什么是 4：打包产物常见落点与到仓库根的距离——
 *
 *   <root>\harness\VRH视频反推.exe        0 级（同级）
 *   <root>\VRH视频反推.exe                0 级
 *   <root>\dist\VRH视频反推.exe           1 级
 *   <root>\desktop\dist\win-unpacked\...  3 级  ← 直接双击构建产物时就是这个
 *   <root>\desktop\release\win-unpacked\  4 级
 *
 * 3 级是实测踩到的场景：用户直接在 `desktop/dist/win-unpacked/` 里双击 exe，
 * 而旧代码只上溯 2 级，于是停在 `desktop/`，永远找不到上一级的仓库根。
 * 4 级多给一档余量，覆盖 release/ 子目录这类布局。
 *
 * 不能无限上溯：每一级都要跑 looksLikeRepoRoot 校验（查 src/vrh + .venv），
 * 上溯到 C:\ 或 D:\ 时目录太大、stat 开销不可控，且误命中风险上升。
 */
const MAX_ASCENT = 4;

/**
 * 从 exe 所在目录逐级上溯，返回候选目录列表（含 0 级即 exe 同级）。
 *
 * 除了直接上溯，每级还试一个 `harness` 子目录 —— 这是便携分发的约定名，
 * 用户很可能把 harness 放在 `dist/harness/` 而不是仓库根。
 */
function ascentCandidates(exeDir, depth = MAX_ASCENT) {
  const out = [];
  let current = exeDir;
  for (let level = 0; level <= depth; level += 1) {
    out.push(current);
    out.push(path.join(current, 'harness'));
    current = path.resolve(current, '..');
    // 已经到盘符根（上溯不再改变路径）就停，避免重复项。
    if (current === path.dirname(current)) break;
  }
  return out;
}

/**
 * repoRoot 候选链（按优先级）。第一个通过 looksLikeRepoRoot 校验的胜出。
 *
 * 顺序设计的理由：
 *   1. 环境变量 —— 显式指定优先于一切猜测，CI/多仓库场景必需
 *   2. 用户上次手选的路径 —— 用户已经明确表达过意图，不该每次重问
 *   3. exe 同级及其上溯若干级（每级含同名 harness/ 子目录）
 *      —— 覆盖「exe 与 harness 放一起」「exe 在 dist/ 里」等便携分发形态
 *   4. 开发态上溯三级 —— 兜底，保证 `npm start` 行为完全不变
 *
 * 近的层级优先于远的：exe 同级有 harness 就不该跑到三级外去用另一个，
 * 否则用户在旁边放一个却生效了远处那个，排查起来毫无头绪。
 */
function repoRootCandidates(userChoice) {
  const list = [];
  const push = (dir) => {
    if (!dir) return;
    const normalized = path.resolve(dir);
    if (!list.includes(normalized)) list.push(normalized);
  };

  push(process.env.VRH_ROOT);
  push(userChoice);

  for (const dir of ascentCandidates(executableDir())) push(dir);

  // 开发态：src/main → src → desktop → 仓库根
  if (!isPackaged()) {
    push(path.resolve(__dirname, '..', '..', '..'));
  }

  return list;
}

/**
 * 解析出可用的 repoRoot。返回 { root, source } 或 null。
 *
 * `source` 用于界面提示 —— 用户需要知道「它到底用了哪个目录」，否则路径猜错时
 * 无从排查。来源文案必须与候选链的实际层级严格对应：曾经因为文案只写
 * 「exe 同级的 harness 目录」，而实际是从上溯三级处找到的，导致用户按文案
 * 去同级目录找、怎么也找不明白为什么生效了。
 */
function resolveRepoRoot(userChoice) {
  const candidates = repoRootCandidates(userChoice);

  for (let i = 0; i < candidates.length; i += 1) {
    const dir = candidates[i];
    if (!looksLikeRepoRoot(dir)) continue;
    return { root: dir, source: describeSource(dir, userChoice), tried: candidates.slice(0, i + 1) };
  }

  return { root: null, source: null, tried: candidates };
}

/**
 * 描述命中目录的来源。判定顺序与 repoRootCandidates 的推入顺序一致：
 * 越靠前的原因越具体，越应先判定。
 */
function describeSource(dir, userChoice) {
  const normalized = dir.replace(/[\\/]+$/, '');
  if (process.env.VRH_ROOT && normalized === path.resolve(process.env.VRH_ROOT)) {
    return '环境变量 VRH_ROOT';
  }
  if (userChoice && path.resolve(dir) === path.resolve(userChoice)) {
    return '上次选择的位置';
  }

  if (isPackaged()) {
    const exeDir = executableDir();
    const relative = path.relative(exeDir, dir);

    // exe 同级目录本身
    if (!relative) return 'exe 同级目录';
    if (!relative.startsWith('..')) return `exe 同级的 ${relative} 目录`;

    // 上溯若干级：用级别数与是否带 harness/ 后缀描述，便于用户按提示复现
    const parts = relative.split(path.sep).filter((p) => p === '..');
    const levels = parts.length;
    const tail = dir.endsWith(`${path.sep}harness`) ? '（含 harness/ 子目录）' : '';
    return `exe 所在目录上溯 ${levels} 级${tail}`;
  }

  if (path.resolve(dir) === path.resolve(__dirname, '..', '..', '..')) {
    return '开发目录';
  }
  return '自动查找';
}

/** 候选 Python 解释器：venv 优先，其次系统 python。 */
function pythonCandidates(repoRoot) {
  const candidates = [];

  if (repoRoot) {
    if (process.platform === 'win32') {
      candidates.push(path.join(repoRoot, '.venv', 'Scripts', 'python.exe'));
    } else {
      candidates.push(path.join(repoRoot, '.venv', 'bin', 'python'));
    }
  }

  // venv 不可用或未定位到仓库时，退回系统 Python。
  // harness 可能装在系统环境里（pip install -e .），这条兜底能救活这种情况。
  if (process.platform === 'win32') {
    candidates.push('python');
  } else {
    candidates.push('python3');
    candidates.push('python');
  }

  return candidates;
}

/**
 * ffmpeg 解析顺序与 harness 保持一致：tools/ 优先，其次 PATH。
 *
 * 之所以要自己复刻一份而不是问 harness，是因为这个探测要在「harness 还没跑起来」
 * 之前就有结果 —— 它本身就是判断能不能跑的前提。
 */
function ffmpegCandidates(repoRoot) {
  const candidates = [];
  const override = process.env.VRH_FFMPEG_DIR;

  if (override) {
    candidates.push(path.join(override, exeName('ffmpeg')));
  }
  if (repoRoot) {
    candidates.push(path.join(repoRoot, 'tools', exeName('ffmpeg')));
  }
  candidates.push('ffmpeg');

  return candidates;
}

function exeName(base) {
  return process.platform === 'win32' ? `${base}.exe` : base;
}

/** 判断一个候选是可执行文件路径（存在）还是裸命令名（交给 PATH）。 */
function isBareCommand(candidate) {
  return !candidate.includes(path.sep) && !candidate.includes('/');
}

/**
 * 探测某个命令的版本号。失败一律返回 null，**绝不抛异常**。
 *
 * 这里的 `try/catch` 不是可有可无的：
 *
 * `execFile` 在某些情况下会**同步抛错**（实测 Windows 上命令无法启动时返回
 * `spawn UNKNOWN`），而这个抛出发生在 `new Promise` 的**执行器内部** ——
 * 它会直接逃出 Promise，**不会被回调里的 `if (error)` 捕获**，也不会变成
 * rejected Promise，而是变成一个同步异常向上冒泡。
 *
 * 后果：`doctor()` 会炸穿，而它的 8 个调用点（`vrh:doctor` 之外的
 * `vrh:artifacts` / `vrh:save-prompt` / `vrh:run` …）大多没有 catch，
 * 于是用户看到的是「Error invoking remote method 'vrh:artifacts':
 * Error: spawn UNKNOWN」这种与真实场景毫不相干的报错。
 *
 * 把调用包进 try/catch，同步抛才会被转成 resolve(null)，
 * 与其他失败路径保持一致。
 */
function probeVersion(command, args = ['--version'], timeoutMs = 8000) {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout: timeoutMs }, (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(String(stdout).split('\n')[0].trim());
      });
    } catch {
      // 同步抛（如 spawn UNKNOWN）—— 当作「探测失败」，不向上冒泡。
      resolve(null);
    }
  });
}

async function resolvePython(repoRoot) {
  for (const candidate of pythonCandidates(repoRoot)) {
    if (isBareCommand(candidate)) {
      const version = await probeVersion(candidate, ['--version']);
      if (version) {
        return { path: candidate, version, bundled: false };
      }
      continue;
    }
    if (fs.existsSync(candidate)) {
      const version = await probeVersion(candidate, ['--version']);
      if (version) {
        return { path: candidate, version, bundled: true };
      }
    }
  }
  return null;
}

/**
 * 只探测 ffmpeg 是否可用，不解析具体路径 —— 具体路径由 harness 自己的
 * resolve_binary() 决定，这里复刻顺序只是为了避免「界面说可用、实际跑不通」。
 */
async function resolveFfmpeg(repoRoot) {
  for (const candidate of ffmpegCandidates(repoRoot)) {
    if (isBareCommand(candidate)) {
      const version = await probeVersion(candidate, ['-version']);
      if (version) {
        return { path: 'PATH', version, source: 'path' };
      }
      continue;
    }
    if (fs.existsSync(candidate)) {
      const version = await probeVersion(candidate, ['-version']);
      if (version) {
        return { path: candidate, version, source: 'tools' };
      }
    }
  }
  return null;
}

/**
 * 通过 harness 自身的 doctor 命令取版本与配置，这是唯一权威来源。
 *
 * 注意 cwd 必须是 repoRoot：vrh 包按可编辑安装注册，且配置与预设按相对路径解析，
 * 换个工作目录会出现「命令能跑但读不到配置」的怪象。
 */
function probeHarness(python, repoRoot) {
  return new Promise((resolve) => {
    /*
     * 同样要包 try/catch —— 理由见 probeVersion 的说明。
     * `python` 即便非空，`execFile` 仍可能同步抛 spawn UNKNOWN。
     */
    try {
      execFile(
        python,
        ['-m', 'vrh.cli', 'doctor'],
        { cwd: repoRoot, timeout: 30000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
        (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          const text = String(stdout);
          const version = (text.match(/^vrh\s+(\S+)/m) || [])[1] || null;
          const preset = (text.match(/^\s+preset\s+(\S+)/m) || [])[1] || null;
          const presets = (text.match(/^\s+presets found\s+(.+)$/m) || [])[1] || null;
          const cache = /cache enabled\s+true/i.test(text);
          const compliance = /compliance\s+enabled/i.test(text);
          const providers = {};
          for (const slot of ['vision', 'llm', 'asr', 'embedding']) {
            const match = text.match(new RegExp(`^\\s+provider\\.${slot}\\s+(\\S+)`, 'm'));
            if (match) providers[slot] = match[1];
          }
          resolve({
            version,
            preset,
            presets: presets ? presets.split(',').map((s) => s.trim()) : [],
            cacheEnabled: cache,
            complianceEnabled: compliance,
            providers,
            runnable: /environment looks runnable/i.test(text),
          });
        }
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * repoRoot 缺失时的报错。提示要给出**可操作的下一步**，不能只说「未找到」——
 * 打包分发场景下用户根本不知道 harness 是什么、该放哪里。
 *
 * 文案设计的三条约束（都是被用户反馈逼出来的）：
 *   1. 不要讲「含 vrh/ 与 .venv/ 的文件夹」—— 用户手里通常没有这个文件夹，
 *      要告诉他**从哪复制什么过来**，而不是让他去辨认特征。
 *   2. 「已依次查找」必须列全，且按层级分组 —— 用户要能一眼看出程序找过哪里，
 *      从而判断自己该往哪放。旧版只列 4 行且不带说明，看不出层级关系。
 *   3. 首选方案要排在最前。绝大多数用户会从第 1 条开始试，别把最优解埋在中间。
 *   4. 必须说明查找的**范围边界**。「已查找 N 个位置」若不解释为什么是这个数，
 *      用户会把「只查了 2 个」理解成程序没认真找 —— 实际是刻意不扫整个磁盘。
 */
function missingRootProblem(tried) {
  const exeDir = executableDir();
  const searched = tried.length
    ? [
      '已依次查找这些位置（就近优先，命中即用）：',
      ...tried.map((d) => `  · ${d}`),
      '',
      '查找范围仅限程序所在目录及其上级，不会扫描整个磁盘 ——',
      '所以 harness 放在别处（例如另一个盘）时，需要用上面第 2 种办法手动指定。',
    ].join('\n')
    : '';

  return {
    kind: 'repoRoot',
    message: '未找到 harness 仓库',
    hint: [
      '本程序只是 harness 的图形界面，自身不含 Python 环境，需要一个 harness 文件夹才能工作。',
      '',
      '三种办法，任选其一：',
      '',
      `  1. 把 harness 文件夹复制到本程序所在目录，改名为 harness`,
      `     （本程序目录：${exeDir}）`,
      '',
      '  2. 点下方的「手动指定」，选中 harness 文件夹本身',
      '     （程序会记住这个位置，下次不用再选）',
      '',
      '  3. 设置环境变量 VRH_ROOT 为 harness 文件夹的完整路径，再重启本程序',
      '',
      'harness 文件夹指的是那个里面有 src、.venv、tools 的文件夹。',
      '如果你是从别人那里拿到的这个程序，它通常会随程序一起提供。',
      '',
      searched,
    ].join('\n'),
  };
}

/**
 * 完整探测。返回结构直接对应界面顶部状态栏要显示的内容。
 *
 * `canRun` 是唯一闸门：只有它为 true 时「开始运行」才可点。
 *
 * @param {string} [userChoice] 用户在此前手选的 harness 目录（持久化在 userData）
 */
async function doctor(userChoice) {
  const resolved = resolveRepoRoot(userChoice);

  if (!resolved.root) {
    return {
      ok: false,
      canRun: false,
      repoRoot: null,
      repoRootSource: null,
      searchedRoots: resolved.tried,
      python: null,
      ffmpeg: null,
      harness: null,
      problems: [missingRootProblem(resolved.tried)],
    };
  }

  const repoRoot = resolved.root;

  // Python 与 ffmpeg 互不依赖，并行探测省一轮往返。
  const [python, ffmpeg] = await Promise.all([
    resolvePython(repoRoot),
    resolveFfmpeg(repoRoot),
  ]);

  if (!python) {
    const venvPath = path.join(
      repoRoot,
      '.venv',
      ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'])
    );
    return {
      ok: false,
      canRun: false,
      repoRoot,
      repoRootSource: resolved.source,
      searchedRoots: resolved.tried,
      python: null,
      ffmpeg,
      harness: null,
      problems: [
        {
          kind: 'python',
          message: '未找到可用的 Python 解释器',
          hint: `期望位置：${venvPath}\n请在该目录运行 python scripts/setup.py 初始化虚拟环境`,
        },
      ],
    };
  }

  const harness = await probeHarness(python.path, repoRoot);
  const problems = [];

  if (!ffmpeg) {
    problems.push({
      kind: 'ffmpeg',
      message: '未找到 ffmpeg',
      hint: 'ffmpeg 是唯一硬依赖。运行 python scripts/get_ffmpeg.py 获取便携版到 tools/',
    });
  }

  if (!harness) {
    problems.push({
      kind: 'harness',
      message: 'harness 无法启动（vrh.cli 不可用）',
      hint: 'venv 可能未安装本包。运行 .venv\\Scripts\\python -m pip install -e . --no-build-isolation',
    });
  }

  return {
    ok: problems.length === 0,
    canRun: problems.length === 0,
    repoRoot,
    repoRootSource: resolved.source,
    searchedRoots: resolved.tried,
    python,
    ffmpeg,
    harness,
    problems,
  };
}

module.exports = { doctor, resolveRepoRoot, looksLikeRepoRoot, isPackaged };
