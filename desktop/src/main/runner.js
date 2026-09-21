'use strict';

/**
 * 运行器：把界面上的配置翻译成 vrh CLI 的 argv，spawn 子进程，流式解析输出。
 *
 * 三个关键决策：
 *
 * 1. **spawn 而非 exec**。exec 会缓冲全部输出直到进程结束，实时日志就没了。
 *    spawn 逐块吐出数据，才能让界面一边跑一边显示。
 *
 * 2. **用 --json-logs**。harness 已经把 stderr 上的日志做成了 NDJSON，这是现成的
 *    机器可读通道，不需要为 GUI 另加 API。stdout 保持人类报告，两者天然分离。
 *
 * 3. **退出码承载语义**。0/1/2/130 各自代表不同的结果类型，尤其 2 不是失败
 *    （见 classifyOutcome），界面必须区别对待。
 */

const { spawn } = require('child_process');
const modelConfig = require('./model-config');

/** 退出码 → 语义。这是界面差异化反馈的依据。 */
const EXIT_CODES = {
  0: { kind: 'success', label: '运行成功' },
  1: { kind: 'error', label: '运行出错' },
  2: { kind: 'gate_failed', label: '质量门未通过' },
  130: { kind: 'interrupted', label: '已中断' },
};

/**
 * 由表单配置组装 CLI 参数。
 *
 * 只传递用户显式设置过的项，其余交给 harness 的默认值 —— 界面不应该复刻一份
 * 默认值，否则 harness 改了默认值，界面就与它不一致了。
 */
function buildArgs(config) {
  const args = ['-m', 'vrh.cli', 'run', '--video', config.videoPath, '--json-logs'];

  if (config.preset) args.push('--preset', config.preset);
  if (config.keyframeStrategy) args.push('--keyframe-strategy', config.keyframeStrategy);
  if (config.framesPerShot != null) args.push('--frames-per-shot', String(config.framesPerShot));
  if (config.cutThreshold != null) args.push('--cut-threshold', String(config.cutThreshold));
  if (config.maxShots != null) args.push('--max-shots', String(config.maxShots));

  if (config.verify) {
    args.push('--verify');
    if (config.rounds != null) args.push('--rounds', String(config.rounds));
    if (config.threshold != null) args.push('--threshold', String(config.threshold));
    if (config.failOnGate) args.push('--fail-on-gate');
  }

  // 运行范围：--only 与 --until 互斥，由界面上的单选项保证。
  if (config.scope === 'only' && config.scopeStage) {
    args.push('--only', config.scopeStage);
  } else if (config.scope === 'until' && config.scopeStage) {
    args.push('--until', config.scopeStage);
  }

  if (config.dryRun) args.push('--dry-run');
  if (config.fresh) args.push('--fresh');
  if (config.noMotion) args.push('--no-motion');
  if (config.noAudio) args.push('--no-audio');
  if (config.logLevel) args.push('--log-level', config.logLevel);

  return args;
}

/** 把一行 NDJSON 解析成日志对象；解析失败则当作原始文本。 */
function parseLogLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && 'msg' in parsed) {
        return {
          ts: parsed.ts || '',
          level: String(parsed.level || 'INFO').toUpperCase(),
          logger: parsed.logger || '',
          msg: String(parsed.msg || ''),
        };
      }
    } catch {
      // 落到下面按原始文本处理。日志行可能是多行 JSON 的一部分，不能丢。
    }
  }

  return { ts: '', level: 'RAW', logger: '', msg: line };
}

/**
 * 从日志行中提取阶段进度。
 *
 * harness 的 orchestrator 会打印 `stage '<name>' complete in <t>s`，
 * 以及 `skipping '<name>' (already complete)` / `re-running '<name>' (...)`。
 * 界面据此推进进度条，无需侵入 harness。
 */
const STAGE_ORDER = ['parse', 'segment', 'understand', 'generate', 'evaluate'];

function extractStageEvent(log) {
  const complete = log.msg.match(/stage '(\w+)' complete in ([\d.]+)s/);
  if (complete && STAGE_ORDER.includes(complete[1])) {
    return { type: 'completed', stage: complete[1], durationS: parseFloat(complete[2]) };
  }

  const running = log.msg.match(/^(?:skipping|re-running) '(\w+)'/);
  if (running && STAGE_ORDER.includes(running[1])) {
    const skipped = log.msg.startsWith('skipping');
    return { type: skipped ? 'skipped' : 'running', stage: running[1] };
  }

  // 阶段内部的实质进展，用来填充当前阶段的状态文字。
  const inner = [
    [/L2: (\d+) shots, (\d+) keyframes/, (m) => `切分完成：${m[1]} 个镜头，${m[2]} 个关键帧`],
    [/L3: annotated (\d+)\/(\d+) shots/, (m) => `标注中：${m[1]}/${m[2]} 个镜头`],
    [/L4: rendered (\d+) shot prompts/, (m) => `已生成 ${m[1]} 条镜头提示词`],
    [/L5: aggregate=([\d.]+) threshold=([\d.]+) passed=(\w+)/,
      (m) => `评测：综合分 ${m[1]} / 阈值 ${m[2]} · ${m[3] === 'True' ? '通过' : '未通过'}`],
  ];
  for (const [pattern, format] of inner) {
    const match = log.msg.match(pattern);
    if (match) return { type: 'detail', text: format(match) };
  }

  return null;
}

/** 从日志行中提取成本摘要。 */
function extractCost(log) {
  const match = log.msg.match(/cost: \$([\d.]+) \| vision (\d+) calls \/ (\d+) frames \| llm (\d+) calls/);
  if (!match) return null;
  return {
    usd: parseFloat(match[1]),
    visionCalls: parseInt(match[2], 10),
    frames: parseInt(match[3], 10),
    llmCalls: parseInt(match[4], 10),
  };
}

/**
 * 判定运行结果。
 *
 * 关键：退出码 2 **不是失败**。它意味着流水线完整跑完并产出了结果，只是分数
 * 未达阈值。把它渲染成红色「运行失败」会让用户以为工具坏了 —— 实际只需要调低
 * 阈值或复核镜头。这个区分是整个错误反馈设计里最容易被做错的一点。
 */
function classifyOutcome(code, signal, aborted) {
  if (aborted) {
    return {
      kind: 'interrupted',
      label: '已中断',
      isFailure: false,
      message: '运行被手动停止。已完成的阶段已写入检查点，可从断点继续。',
    };
  }

  if (signal) {
    return {
      kind: 'error',
      label: '进程异常终止',
      isFailure: true,
      message: `子进程被信号 ${signal} 终止。`,
    };
  }

  const entry = EXIT_CODES[code];
  if (!entry) {
    return {
      kind: 'error',
      label: `未知退出码 ${code}`,
      isFailure: true,
      message: `harness 返回了未预期的退出码 ${code}。`,
    };
  }

  // 逐一分支，不用「兜底即成功」的写法 —— 那样任何新增的退出码都会静默变成
  // 成功。130（中断）就曾因此被误判为运行成功。
  switch (entry.kind) {
    case 'gate_failed':
      return {
        kind: 'gate_failed',
        label: entry.label,
        isFailure: false,
        message: '流水线已完整运行并产出结果，但综合分未达阈值。这不属于故障 —— 可调低阈值，或复核被标记的镜头。',
      };
    case 'interrupted':
      return {
        kind: 'interrupted',
        label: entry.label,
        isFailure: false,
        message: '运行已中断。已完成的阶段已写入检查点，可重新运行以从断点继续。',
      };
    case 'error':
      return {
        kind: 'error',
        label: entry.label,
        isFailure: true,
        message: '运行失败。详见日志面板中的错误信息。',
      };
    case 'success':
      return { kind: 'success', label: entry.label, isFailure: false, message: '运行成功。' };
    default:
      return {
        kind: 'error',
        label: `未处理的退出码 ${code}`,
        isFailure: true,
        message: `退出码 ${code} 没有对应的处置逻辑，已按失败处理以免误报成功。`,
      };
  }
}

/**
 * 启动一次运行。
 *
 * @param {object} config  表单配置
 * @param {object} runtime { pythonPath, repoRoot }
 * @param {object} hooks   事件回调：onLog / onStage / onCost / onReport / onDone
 * @returns {object}       控制器，含 stop()
 */
function startRun(config, runtime, hooks) {
  const args = buildArgs(config);

  /*
   * 模型配置 → 子进程环境变量。
   *
   * 为什么不走命令行参数：API Key 出现在 argv 里就等于公开了 —— 任务管理器
   * 和 ps 都能看到同机其他用户的完整命令行。环境变量虽然也不是密不透风，
   * 但不会进入进程列表，也不会被 shell 历史记录。
   *
   * 此外 harness 的 CLI 本来就没有 provider 开关，环境变量是唯一的运行时
   * 覆盖手段（VRH_ 前缀 + __ 分层）。
   */
  const modelEnv = modelConfig.toEnv(config.model);

  const child = spawn(runtime.pythonPath, args, {
    cwd: runtime.repoRoot,
    env: {
      ...process.env,
      // 强制 UTF-8，否则 Windows 上中文路径与日志会乱码。
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      ...modelEnv,
    },
    windowsHide: true,
  });

  let aborted = false;
  let settled = false;
  let stdoutBuffer = '';
  let stderrBuffer = '';
  const reportChunks = [];

  /*
   * 命令回显。
   *
   * 只拼 argv，**不含环境变量** —— 这本就是 argv 的真实内容，如实反映即可。
   * 但用户在界面上看到的命令预览里是有模型信息的，若这里只回显 argv，
   * 日志与预览会对不上，让人以为模型没生效。所以补一行说明，而不是把
   * 环境变量混进命令行字符串（那样会误导成「Key 是命令行参数」）。
   */
  hooks.onCommand?.([runtime.pythonPath, ...args].join(' '));
  hooks.onModel?.(modelConfig.describe(config.model));

  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    reportChunks.push(chunk);
    // stdout 是人类报告，不参与日志流，但要在结束时一并交出。
  });

  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk;

    // 按行切分，保留最后一段不完整的行等待下一块数据 —— 一次 chunk 不一定
    // 刚好落在行边界上，直接切会截断 JSON。
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() || '';

    for (const line of lines) {
      const log = parseLogLine(line);
      if (!log) continue;

      hooks.onLog?.(log);

      const stageEvent = extractStageEvent(log);
      if (stageEvent) hooks.onStage?.(stageEvent);

      const cost = extractCost(log);
      if (cost) hooks.onCost?.(cost);
    }
  });

  child.on('error', (error) => {
    if (settled) return;
    settled = true;
    hooks.onDone?.({
      outcome: {
        kind: 'error',
        label: '无法启动 harness',
        isFailure: true,
        message: `${error.message}。请确认 Python 解释器路径有效（设置页可重新探测）。`,
      },
      exitCode: null,
      report: reportChunks.join(''),
      stderrTail: stderrBuffer,
    });
  });

  child.on('close', (code, signal) => {
    if (settled) return;
    settled = true;

    // 冲掉缓冲区里最后一行（正常结束时通常为空）。
    if (stderrBuffer.trim()) {
      const log = parseLogLine(stderrBuffer);
      if (log) {
        hooks.onLog?.(log);
        const stageEvent = extractStageEvent(log);
        if (stageEvent) hooks.onStage?.(stageEvent);
      }
    }

    hooks.onDone?.({
      outcome: classifyOutcome(code, signal, aborted),
      exitCode: code,
      report: reportChunks.join(''),
      stderrTail: stderrBuffer,
    });
  });

  return {
    pid: child.pid,
    stop() {
      if (settled || aborted) return false;
      aborted = true;

      // Windows 上 child.kill() 只杀直接子进程，Python 拉起的 ffmpeg 会变成孤儿
      // 继续占用 CPU。必须整棵进程树一起终止。
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill('SIGINT');
      }
      return true;
    },
  };
}

module.exports = {
  startRun,
  buildArgs,
  parseLogLine,
  extractStageEvent,
  extractCost,
  classifyOutcome,
  STAGE_ORDER,
};
