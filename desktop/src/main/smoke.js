'use strict';

/**
 * 界面冒烟测试。
 *
 * 为什么需要它：Electron 是 GUI 程序，在无人值守的环境里没法「看一眼」。
 * 但界面里最容易出错的地方 —— 阶段进度是否跟着推进、退出码 2 是否显示成
 * 黄色而非红色、日志级别过滤是否真的生效 —— 都不是靠读代码能确认的。
 *
 * 做法：拉起真实的窗口、加载真实的 renderer、喂进真实的运行数据，
 * 再把 DOM 的实际状态和截图取回来。验证的是「界面真的这样显示了」，
 * 而不是「我写的代码看起来应该这样显示」。
 *
 * 关于断言口径 —— 重要：
 * 断言只针对**界面行为**，不要求流水线一定跑到底。原因是运行环境里存在一个
 * 与产品无关的干扰：harness 在切分层会删掉重复关键帧以省 API 成本，而沙箱的
 * safe-delete 策略会拦截这次删除，导致 Python 进程以退出码 1 中止。
 * 所以「本轮运行成功」不是一个可以假定的前提。
 *
 * 界面该做的是：**不管流水线走到哪一步，都把真实状态如实显示出来**。
 * 因此这里的判据是「界面是否与收到的数据一致」，而不是「结果是否为成功」。
 * 具体地：
 *   - 收到 outcome=success   → 必须画成成功
 *   - 收到 outcome=gate_failed → 必须画成黄色警告（不是红色故障）
 *   - 收到 outcome=error     → 必须画成错误，并给出原因与完整输出入口
 *   - 收到 outcome=interrupted → 必须画成中断，且不暴露误导性的退出码
 *   - 阶段条必须与阶段事件一致（跑完的标 done，没跑的不许假装在跑）
 *
 * 场景：
 *   idle      只探测环境，看首屏与连接状态
 *   success   跑一次完整流程，看结果卡片
 *   gate      开质量门并设一个达不到的阈值，看退出码 2 的呈现（关键差异点）
 *   error     选一个不存在的视频，看启动前的拦截反馈
 *   stop      启动后立即停止，看中断态
 *   fresh     带 --fresh 强制重跑，看阶段条在不命中缓存时是否正常
 */

const path = require('path');
const fs = require('fs');

const runner = require('./runner');
const artifacts = require('./artifacts');

const SHOT_DIR = path.resolve(__dirname, '..', '..', 'screenshots');
const PROGRESS = path.resolve(__dirname, '..', '..', 'smoke-progress.log');
// harness 仓库根：冒烟脚本只在开发态运行，所以上溯三级即可。
// 打包态的验证走 scripts/ 下的 CDP 脚本（这些诊断脚本不进 asar）。
const REPO_ROOT_PATH = path.resolve(__dirname, '..', '..', '..');
const SAMPLE = path.resolve(REPO_ROOT_PATH, 'samples', 'clip.mp4');
const MISSING = path.resolve(REPO_ROOT_PATH, 'samples', 'does-not-exist.mp4');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 把进度实时落盘。
 *
 * 为什么不能只靠 console.log：在管道里跑的时候 stdout 是块缓冲的，
 * 脚本没结束就一行都看不到 —— 上一次调试因此白等了十分钟才判断出卡住。
 * 写文件是行缓冲的，随时可以 tail。
 */
function progress(msg) {
  const line = `${new Date().toISOString().slice(11, 19)}  ${msg}\n`;
  try {
    fs.appendFileSync(PROGRESS, line, 'utf8');
  } catch {
    /* 进度记录失败不该影响测试本身 */
  }
}

/** 等界面里出现某个条件，或超时。返回是否命中。 */
async function waitFor(win, expr, timeoutMs = 120000, label = '') {
  const deadline = Date.now() + timeoutMs;
  let lastBeat = 0;
  while (Date.now() < deadline) {
    const hit = await win.webContents.executeJavaScript(`(() => { try { return !!(${expr}); } catch (e) { return false; } })()`);
    if (hit) return true;
    // 每 10 秒留一次心跳，卡住时能一眼看出卡在哪一步。
    if (Date.now() - lastBeat > 10000) {
      lastBeat = Date.now();
      const snap = await win.webContents
        .executeJavaScript(`(() => {
          const lc = document.getElementById('logCount');
          const st = document.getElementById('stageTrack');
          const stages = st ? [...st.querySelectorAll('.stage')].map((e) => {
            const n = e.querySelector('.stage-label')?.textContent.replace(/\\s*\\S+$/, '').trim() || '?';
            const s = e.className.replace(/^stage\\s*/, '').trim() || '待';
            return n + ':' + s;
          }).join(' ') : '';
          return { logs: lc ? lc.textContent.trim() : '-', stages };
        })()`)
        .catch(() => ({ logs: '-', stages: '' }));
      progress(`  等待${label ? ' ' + label : ''}… 日志 ${snap.logs} | ${snap.stages}`);
    }
    await sleep(300);
  }
  return false;
}

/** 把界面上关键元素的真实文本取回来。 */
async function snapshotDom(win) {
  return win.webContents.executeJavaScript(`(() => {
    const txt = (sel) => { const el = document.querySelector(sel); return el ? el.textContent.trim() : null; };
    const stages = [...document.querySelectorAll('#stageTrack .stage')].map((el) => ({
      name: el.querySelector('.stage-label')?.textContent.replace(/\\s*\\S+$/, '').trim() || '',
      raw: el.querySelector('.stage-label')?.textContent.trim() || '',
      state: el.className.replace(/^stage\\s*/, '').trim(),
    }));
    const mv = (id) => { const el = document.getElementById(id); return el ? el.textContent.trim() : null; };
    return {
      statusDot: document.querySelector('#statusDot')?.className || null,
      statusText: txt('#statusText'),
      statusDetail: txt('#statusDetail'),
      canRun: !document.getElementById('btnRun')?.disabled,
      // 停止按钮此刻是否可用。stop 场景靠它确认「点下去真的会生效」，
      // 否则 runner 会因进程已结束而静默忽略，场景变成假通过。
      stopEnabled: !document.getElementById('btnStop')?.disabled,
      bannerVisible: !document.getElementById('envBanner')?.hidden,
      stages,
      metrics: {
        shots: mv('mShots'),
        duration: mv('mDuration'),
        cost: mv('mCost'),
        score: mv('mScore'),
      },
      resultKind: document.getElementById('resultBody')?.dataset.kind || null,
      resultBadge: txt('#resultBadge'),
      resultBodyText: txt('#resultBody'),
      calloutClass: document.querySelector('#resultBody .result-callout')?.className || null,
      shotCards: document.querySelectorAll('#shotList .shot-card').length,
      logLines: document.querySelectorAll('#logBody .log-line').length,
      logCount: txt('#logCount'),
      visibleLogLines: document.querySelectorAll('#logBody .log-line:not(.hidden)').length,
      reportBtnVisible: !document.getElementById('btnOpenReport')?.hidden,
    };
  })()`);
}

async function shot(win, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  // capturePage 只抓窗口可见区域。先确认窗口尺寸，避免截出被裁切的画面 —— 
  // 一张裁掉右半边的截图会让人误判成「布局塌了」。
  const [w, h] = win.getContentSize();
  const image = await win.webContents.capturePage();
  const file = path.join(SHOT_DIR, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  const size = image.getSize();
  console.log(`[smoke]   截图 ${path.basename(file)} → 窗口 ${w}x${h}，图像 ${size.width}x${size.height}`);
  return file;
}

/** 让界面走真实的运行链路 —— 点按钮，而不是绕过 IPC 塞数据。 */
async function drive(win, config, dryRun) {
  // config 要穿过「Node 字符串 → executeJavaScript 源码 → 页面里再被 JSON.parse」
  // 三层转义。直接把对象插进模板字符串会让 Windows 反斜杠被吃掉一层，
  // 出现 D:////HarnessTest 这种被破坏的路径。这里显式做一次编码。
  const payload = JSON.stringify(JSON.stringify(config));
  return win.webContents.executeJavaScript(`
    (async () => {
      window.__smokeSetConfig(JSON.parse(${payload}));
      await new Promise((r) => setTimeout(r, 80));
      document.getElementById('${dryRun ? 'btnDryRun' : 'btnRun'}').click();
      return 'clicked';
    })()
  `);
}

/* --------------------------------------------------------- 布局断点检查 */

/** 各断点的期望行为。宽档必须与改造前的桌面端一致，否则就算回归。 */
const LAYOUT_CASES = [
  { w: 1280, h: 900, label: '桌面', single: false, metrics: 4, logToggle: false },
  { w: 1024, h: 768, label: '中窄', single: false, metrics: 2, logToggle: false },
  { w: 720, h: 900, label: '窄屏', single: true, metrics: 2, logToggle: true },
  { w: 400, h: 720, label: '手机', single: true, metrics: 1, logToggle: true },
];

const LAYOUT_PROBE = `(() => {
  const cols = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    return getComputedStyle(el).gridTemplateColumns;
  };
  const count = (sel) => (cols(sel) || '').split(' ').filter(Boolean).length;

  const targetOf = (el) => {
    if (el.type === 'checkbox' || el.type === 'radio' || el.classList.contains('inline-select')) {
      return el.closest('label') || el;
    }
    return el;
  };

  const smallTargets = [...document.querySelectorAll('button, select, input[type="checkbox"], input[type="radio"]')]
    .map((el) => ({ el, box: targetOf(el) }))
    .filter(({ el }) => {
      if (el.closest('dialog')) return false;
      if (el.closest('.cfg-group:not([open])')) return false;
      if (el.closest('.log-panel.collapsed')) return false;
      for (const node of [el, targetOf(el)]) {
        const cs = getComputedStyle(node);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      }
      return true;
    })
    .filter(({ box }) => {
      const r = box.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.height < 44;
    })
    .map(({ el, box }) => {
      const name = el.id || el.closest('label')?.textContent.trim().slice(0, 10) || el.tagName;
      return String(name).replace(/\\s+/g, ' ') + ':' + Math.round(box.getBoundingClientRect().height);
    });

  // 文字被裁切：元素声明了截断且内容确实放不下。
  const truncated = [...document.querySelectorAll('.panel-title, .metric-label, .cfg-summary, .field label')]
    .filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow === 'ellipsis')
    .map((el) => el.textContent.trim().slice(0, 14));

  return {
    viewport: window.innerWidth,
    docWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    // 窄屏的 .layout 是 display:contents（透明的中间层），此时网格列数读不出东西。
    // 真正该验证的是三个区块的纵向次序 —— 那才是用户眼睛看到的东西。
    verticalOrder: (() => {
      const nodes = [
        ['控制与结果', document.querySelector('.main-column')],
        ['参数配置', document.querySelector('.config-panel')],
        ['运行日志', document.querySelector('.log-panel')],
      ].filter(([, el]) => el);
      return nodes
        .map(([name, el]) => ({ name, top: el.getBoundingClientRect().top }))
        .sort((a, b) => a.top - b.top)
        .map((n) => n.name)
        .join(' → ');
    })(),
    sideBySide: (() => {
      const main = document.querySelector('.main-column');
      const cfg = document.querySelector('.config-panel');
      if (!main || !cfg) return false;
      // 顶边相近 ⇒ 并排；相差明显 ⇒ 上下堆叠。
      return Math.abs(main.getBoundingClientRect().top - cfg.getBoundingClientRect().top) < 8;
    })(),
    metricCount: count('.metrics'),
    stageCount: count('.stage-track'),
    logToggleVisible: getComputedStyle(document.querySelector('#btnToggleLog')).display !== 'none',
    logCollapsed: document.querySelector('.log-panel')?.classList.contains('collapsed'),
    smallTargets,
    truncated,
  };
})()`;

async function runLayoutChecks(win, report, note) {
  for (const cs of LAYOUT_CASES) {
    win.setBounds({ x: 60, y: 60, width: cs.w + 60, height: cs.h + 120 });
    win.setContentSize(cs.w, cs.h);
    await sleep(450);

    const data = await win.webContents.executeJavaScript(LAYOUT_PROBE);
    const tag = `${cs.label} ${cs.w}×${cs.h}`;
    note(`布局 ${tag}：${data.sideBySide ? '双列并排' : '单列堆叠'} · 次序 ${data.verticalOrder} · ` +
         `指标 ${data.metricCount} 列 · 日志按钮${data.logToggleVisible ? '可见' : '隐藏'}`);

    report.shots.push(await shot(win, `layout-${cs.w}x${cs.h}`));
    report[`layout_${cs.w}`] = data;

    if (data.sideBySide !== !cs.single) {
      report.problems.push(
        `${tag}：应${cs.single ? '为单列堆叠' : '保持左右并排'}，实际${data.sideBySide ? '并排' : '堆叠'}`
      );
    }
    if (data.metricCount !== cs.metrics) {
      report.problems.push(`${tag}：指标应为 ${cs.metrics} 列，实际 ${data.metricCount} 列`);
    }
    if (data.logToggleVisible !== cs.logToggle) {
      report.problems.push(
        `${tag}：日志折叠按钮应${cs.logToggle ? '可见' : '隐藏'}，实际${data.logToggleVisible ? '可见' : '隐藏'}`
      );
    }

    // 窄屏下必须把「控制与结果」放最前 —— 小屏用户先要操作和结果，不是参数。
    if (cs.single && !data.verticalOrder.startsWith('控制与结果')) {
      report.problems.push(`${tag}：纵向次序应为「控制与结果」最前，实际 ${data.verticalOrder}`);
    }
    // 日志必须排在配置之后，否则会把配置从中截断（曾经就是这个毛病）。
    if (cs.single && data.verticalOrder.split(' → ').pop() !== '运行日志') {
      report.problems.push(`${tag}：日志应排在最后，实际次序 ${data.verticalOrder}`);
    }

    // 水平溢出是最致命的排版问题 —— 右侧内容会被裁掉且无法点到。
    if (data.docWidth > data.viewport + 1) {
      report.problems.push(
        `${tag}：存在水平溢出，文档宽 ${data.docWidth} > 视口宽 ${data.viewport}`
      );
    }

    // 触控目标只在窄屏要求 —— 桌面端鼠标点击不需要 44px，强行放大反而破坏信息密度。
    if (cs.single && data.smallTargets.length) {
      report.problems.push(
        `${tag}：触控目标小于 44px（${data.smallTargets.length} 个）：${data.smallTargets.join(', ')}`
      );
    }

    if (data.truncated.length) {
      report.problems.push(`${tag}：文字被截断：${data.truncated.join(' / ')}`);
    }
  }
}

async function run(win, scenario) {
  const report = { scenario, steps: [], problems: [] };
  const note = (msg) => {
    report.steps.push(msg);
    console.log('[smoke]', msg);
    progress(msg);
  };

  progress(`=== 场景 ${scenario} 开始 ===`);

  /*
   * 把「未捕获的 Promise 异常」变成一条明确的失败，而不是静静地挂着。
   *
   * 起因是一次真实的事故：runPromptEditChecks 里引用了作用域外的变量，
   * 抛出的 ReferenceError 没人接，进程既不退出也不报错 —— 整个场景就这样
   * 空转到 5 分钟超时被杀，日志里只在最后几行提了一句，排查代价极高。
   *
   * 用例里任何一处 await 抛错，都应该立刻变成「这个问题」，而不是变成等待。
   */
  const onRejection = (reason) => {
    const text = String((reason && reason.stack) || reason);
    report.problems.push(`未捕获的异步异常：${text.split('\n').slice(0, 3).join(' | ')}`);
    progress(`!! 未捕获异常：${text.split('\n')[0]}`);
    finish(win, report);
  };
  process.on('unhandledRejection', onRejection);

  // 记录渲染进程的报错：界面里有 JS 异常必须暴露出来，不能静默失败。
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) report.problems.push(`renderer console: ${message}`);
  });
  win.webContents.on('preload-error', (_e, p, err) => {
    report.problems.push(`preload error at ${p}: ${err.message}`);
  });

  // 等页面加载完成（可能已经完成，所以先查 readyState）。
  const ready = await win.webContents.executeJavaScript(`document.readyState`);
  if (ready !== 'complete') {
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  }

  // 放大到足够容纳「配置栏 + 主列 + 日志」三区并排，否则截图会挤在一起，
  // 看不出真实布局。屏幕不够大时退回工作区尺寸，不做无谓的挣扎。
  try {
    const { screen } = require('electron');
    const work = screen.getPrimaryDisplay().workArea;
    const width = Math.min(1600, work.width);
    const height = Math.min(1000, work.height);
    win.setBounds({ x: work.x, y: work.y, width, height });
    win.setContentSize(width, height);
    await sleep(600);
    const [cw, ch] = win.getContentSize();
    note(`窗口调整为 ${width}×${height}，实际内容区 ${cw}×${ch}`);
  } catch (e) {
    note(`窗口调整跳过：${e.message}`);
  }
  await sleep(1200);

  note('环境探测中…');
  const envOk = await waitFor(
    win,
    `!document.getElementById('statusDot').classList.contains('busy') && document.getElementById('statusText').textContent.trim().length > 0`,
    60000,
    '环境探测'
  );
  if (!envOk) report.problems.push('状态栏长时间停留在探测中 —— 环境探测未回填界面');

  let dom = await snapshotDom(win);
  note(`首屏：状态点=${dom.statusDot} 文本="${dom.statusText}" 可运行=${dom.canRun} 问题横幅=${dom.bannerVisible}`);
  report.initial = dom;
  report.shots = [await shot(win, `${scenario}-1-idle`)];

  if (scenario === 'idle') {
    if (!dom.canRun) report.problems.push(`环境就绪但运行按钮被禁用：${dom.statusText}`);
    if (dom.logLines !== 0) report.problems.push(`首屏不该有日志行，实际 ${dom.logLines} 行`);
    return finish(win, report);
  }

  // 布局场景：不跑流水线，只在各断点下量几何尺寸。
  // 界面「跑不跑得通」由别的场景负责，这里只回答「排版对不对」。
  if (scenario === 'layout') {
    await runLayoutChecks(win, report, note);
    return finish(win, report);
  }
  // 用 harness 真实存在的预设名，否则运行会在参数校验阶段就失败，
  // 测到的是「参数错误」而不是我们想验证的那个场景。
  const config = {
    videoPath: scenario === 'error' ? MISSING : SAMPLE,
    preset: 't2v_generic',
    runMode: 'full',
  };

  if (scenario === 'gate') {
    // 质量门场景必须真的开质量门，否则退出码是 0，测不到 exit 2 的呈现。
    // 阈值设成 1.0（不可能达到），保证一定触发未通过分支。
    config.verify = true;
    config.threshold = 1.0;
    config.failOnGate = true;
    config.rounds = 1;
  }

  if (scenario === 'fresh' || scenario === 'stop') {
    // 强制重跑：绕开缓存，让五个阶段都真的执行一遍。
    // stop 场景尤其需要 —— 命中缓存时整条流水线不到 1 秒就结束了，
    // 根本来不及点停止，那样测到的是「运行已完成」而不是「中断」。
    //
    // 必须在这里设置：drive() 一旦执行，配置就发出去了，之后再改 config
    // 不会影响本次运行（曾经写成 drive 之后再设，于是 stop 场景一直假通过）。
    config.fresh = true;
  }

  note(`启动运行：${config.videoPath}`);
  await drive(win, config, scenario === 'dry');

  if (scenario === 'stop') {
    // 等到第一条日志出现再点停止。原因是 harness 启动 + ffmpeg 抽音轨大概要
    // 2 秒才开始输出；固定 sleep 一段时间很可能在「一条日志都还没有」的时候
    // 就点了停止，那验证的是「刚起步就中断」，而不是「跑到一半被中断」。
    note('等待首条日志…');
    const gotLog = await waitFor(win, `document.querySelectorAll('#logBody .log-line').length > 0`, 60000, '首条日志');
    if (!gotLog) report.problems.push('运行长时间没有任何日志输出 —— 流式日志可能没通');

    // 再确认「停止按钮可用」才点。只等日志不够稳：日志可能来自启动阶段，
    // 而流水线此刻已收尾 —— 那样点下去仍然测到「已完成」。
    const stillRunning = await waitFor(win, `!document.getElementById('btnStop').disabled`, 30000, '运行中');
    if (!stillRunning) report.problems.push('点了运行但停止按钮始终不可用 —— 无法验证中断');

    report.midRun = await snapshotDom(win);
    report.shots.push(await shot(win, `${scenario}-2-running`));
    note(`点击停止前：日志 ${report.midRun.logLines} 行，状态栏「${report.midRun.statusText}」`);
    await win.webContents.executeJavaScript(`document.getElementById('btnStop').click()`);
  }

  note('等待结果…');
  const settled = await waitFor(win, `document.getElementById('resultBadge') && !document.getElementById('resultBadge').hidden`, 180000, '结果');
  if (!settled) {
    report.problems.push('超时：结果徽标始终未出现');
    report.final = await snapshotDom(win);
    report.shots.push(await shot(win, `${scenario}-3-timeout`));
    return finish(win, report);
  }

  await sleep(800);
  dom = await snapshotDom(win);
  report.final = dom;
  note(`结果：kind=${dom.resultKind} 徽标="${dom.resultBadge}" 镜头卡=${dom.shotCards} 日志行=${dom.logLines}`);
  note(`阶段：${dom.stages.map((s) => `${s.name}:${s.state || '(待)'}`).join(' | ')}`);
  note(`指标：镜头=${dom.metrics.shots} 时长=${dom.metrics.duration} 花费=${dom.metrics.cost} 分数=${dom.metrics.score}`);
  report.shots.push(await shot(win, `${scenario}-4-result`));

  // ---- 断言：界面必须与收到的数据自洽 ----
  //
  // 这里不做「一定要成功」这种断言。流水线能否跑到最后取决于运行环境
  // （见文件头说明），不是界面能控制的。界面能控制的是：**别撒谎**。
  // 所以判据统一是「显示的东西和实际发生的事是否一致」。

  const KIND_LABEL = {
    success: '成功',
    gate_failed: '质量门未过（黄色警告）',
    interrupted: '已中断',
    error: '运行出错',
  };

  // 1) 结果面板不能停在「运行中」—— 运行已结束，界面必须给出结论。
  if (!dom.resultKind) {
    report.problems.push('运行已结束但结果面板没有给出任何结论');
  }
  if (String(dom.resultBodyText || '').includes('运行中')) {
    report.problems.push('运行结束后结果区仍显示「运行中」—— 界面状态自相矛盾');
  }

  // 2) 给定的场景若有确定预期，必须命中。
  //    只断言「必然发生」的：error 场景一定失败、interrupted 场景一定是中断。
  //    success / gate 可能因环境限制退化成 error，那种情况只做一致性检查。
  if (scenario === 'error' && dom.resultKind !== 'error') {
    report.problems.push(`错误场景结果面板应为 error，实际 ${dom.resultKind}`);
  }
  if (scenario === 'stop' && dom.resultKind !== 'interrupted') {
    report.problems.push(`中断场景结果面板应为 interrupted，实际 ${dom.resultKind}`);
  }
  if (scenario === 'gate' && dom.resultKind === 'gate_failed') {
    // 这是本测试最想覆盖的分支：退出码 2 必须是警告而不是故障。
    if (!String(dom.calloutClass || '').includes('gate_failed')) {
      report.problems.push(`质量门未过未使用警告样式（callout="${dom.calloutClass}"），会被误读成程序故障`);
    }
    if (dom.metrics.score === '—') {
      report.problems.push('质量门未过但界面没显示综合分 —— 用户无从判断差多少');
    }
  }

  // 3) 任何出错都必须给出原因，而不是只甩一个退出码。
  if (dom.resultKind === 'error') {
    if (!dom.resultBodyText || dom.resultBodyText.length < 15) {
      report.problems.push('出错但没有向用户展示原因');
    }
  }

  // 4) 结果类型必须在已知集合内 —— 防止出现界面自己发明的状态。
  if (dom.resultKind && !(dom.resultKind in KIND_LABEL)) {
    report.problems.push(`结果类型不在已知集合内：${dom.resultKind}`);
  }

  // 5) 中断时徽标不该暴露退出码。用户按了停止，退出码是强杀副产物，
  //    摆在徽标上会让人误以为程序本身出了问题。
  if (scenario === 'stop' && /\d/.test(dom.resultBadge || '')) {
    report.problems.push(`中断徽标里出现了数字（"${dom.resultBadge}"）—— 会把强杀退出码误读成故障`);
  }

  // 6) 阶段条必须与实际进度自洽：跑完的标 done，没跑的不许标 active。
  //    注意 skipped（命中缓存）与 done（真跑了）都算完成，不算缺陷。
  const stillActive = dom.stages.filter((s) => s.state === 'active');
  if (stillActive.length && dom.resultKind) {
    report.problems.push(`运行已结束但仍有阶段显示进行中：${stillActive.map((s) => s.name).join(', ')}`);
  }

  // 7) 成功路径下必须有产物可看。
  if (dom.resultKind === 'success') {
    if (dom.shotCards === 0) report.problems.push('运行成功但镜头卡片为 0');
    if (!dom.metrics.cost || dom.metrics.cost === '—') report.problems.push('运行成功但未显示成本');
    if (!dom.reportBtnVisible) report.problems.push('运行成功但「打开审阅页」按钮未出现');
  }

  // 8) 中断场景：停止前必须真的收到过日志，否则说明流式输出没通。
  if (scenario === 'stop') {
    if (!report.midRun || report.midRun.logLines === 0) {
      report.problems.push('停止前日志面板没有任何内容 —— 流式日志可能没通');
    }
    if (report.midRun && dom.logLines < report.midRun.logLines) {
      report.problems.push('停止后日志行数减少 —— 日志被意外清空');
    }
    // 停止按钮在点击前必须真的可用。若点的是已结束的运行，runner 会因 settled
    // 静默忽略停止请求，界面会正确地显示「运行出错」—— 这时场景虽然没报错，
    // 但实际什么都没验证到，属于假通过，必须显式拦下。
    if (report.midRun && !report.midRun.stopEnabled) {
      report.problems.push('点击停止时按钮已不可用 —— 停止请求会被忽略，本场景未真正验证中断');
    }
  }

  // 日志级别过滤是否真的生效
  const filterWorks = await win.webContents.executeJavaScript(`(() => {
    const sel = document.getElementById('logLevel');
    if (!sel) return 'no-select';
    const total = document.querySelectorAll('#logBody .log-line').length;
    sel.value = 'ERROR'; sel.dispatchEvent(new Event('change'));
    const errOnly = document.querySelectorAll('#logBody .log-line:not(.hidden)').length;
    sel.value = 'ALL'; sel.dispatchEvent(new Event('change'));
    const back = document.querySelectorAll('#logBody .log-line:not(.hidden)').length;
    return { total, errOnly, back };
  })()`);
  note(`日志过滤：${JSON.stringify(filterWorks)}`);
  report.filter = filterWorks;
  if (filterWorks && typeof filterWorks === 'object') {
    if (filterWorks.errOnly > filterWorks.total) {
      report.problems.push('过滤后可见行数超过总行数 —— 过滤逻辑有误');
    }
    if (filterWorks.back !== filterWorks.total) {
      report.problems.push(`恢复「全部级别」后未回到全部行：${filterWorks.back} ≠ ${filterWorks.total}`);
    }
    // 只有当日志里确实存在非 ERROR 行时，才要求过滤能隐藏掉一些东西。
    // 否则（例如启动就被拒绝的场景只有一行 ERROR）「没隐藏任何行」是正确的。
    const nonError = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('#logBody .log-line')].filter((e) => e.dataset.level !== 'ERROR' && e.dataset.level !== 'CRITICAL').length`
    );
    if (nonError > 0 && filterWorks.errOnly === filterWorks.total) {
      report.problems.push(`存在 ${nonError} 行非 ERROR 日志，但选择「仅 ERROR」后一行也没被隐藏 —— 过滤未生效`);
    }
    report.filterDetail = { ...filterWorks, nonError };
  }

  // 提示词编辑场景：跑完之后验证「编辑 → 保存 → 落盘」这条链路。
  // 只在确实生成了产物时才有意义 —— 没有 prompt.json 就无从编辑。
  if (scenario === 'prompt-edit') {
    await runPromptEditChecks(win, report, note);
  }

  return finish(win, report);
}

function finish(win, report) {
  // 幂等：正常路径与「未捕获异常」的兜底路径都可能调到这里。
  // 不加这道锁，异常兜底会先退出进程，正常路径再走一遍就可能重复写报告。
  if (report.__finished) return;
  report.__finished = true;

  console.log('\n' + '='.repeat(60));
  console.log(`场景 ${report.scenario}：${report.problems.length ? '发现问题' : '通过'}`);
  if (report.problems.length) {
    for (const p of report.problems) console.log('  ! ' + p);
  }
  console.log('截图：');
  for (const s of report.shots || []) console.log('  ' + s);
  console.log('='.repeat(60) + '\n');

  const out = path.resolve(__dirname, '..', '..', 'smoke-report.json');
  let all = [];
  try {
    all = JSON.parse(fs.readFileSync(out, 'utf8'));
  } catch {
    all = [];
  }
  // 内部标记不进报告文件，避免污染可读的产物。
  const { __finished, ...clean } = report;
  all.push(clean);
  fs.writeFileSync(out, JSON.stringify(all, null, 2), 'utf8');

  setTimeout(() => {
    require('electron').app.exit(report.problems.length ? 1 : 0);
  }, 500);
}

/**
 * 提示词编辑链路验证：编辑 → 未保存态 → 保存 → prompt.json 真的变了。
 *
 * 为什么要读回磁盘核对，而不只看界面提示：界面说「已保存」是一回事，
 * 文件里到底写没写进去是另一回事。这是本项目一贯的口径 ——
 * 界面态正确 ≠ 副作用正确。
 *
 * 验证完会**还原改动**，避免污染后续场景与用户的产物。
 */
async function runPromptEditChecks(win, report, note) {
  // 没有镜头卡片就说明没有 prompt.json 可编辑，直接跳过（不算失败）。
  const ready = await win.webContents.executeJavaScript(
    `document.querySelectorAll('#shotList .shot-card').length > 0`
  );
  if (!ready) {
    note('提示词编辑：无镜头卡片可取，跳过');
    report.promptEdit = { skipped: true };
    return;
  }

  // 复用 artifacts 的 videoId，别在这里另写一份 —— 算法一旦不一致，
  // 测试会去读一个不存在的目录，还以为是功能坏了。
  const promptPath = path.join(REPO_ROOT_PATH, 'output', artifacts.videoId(SAMPLE), 'prompt.json');
  const before = readJsonSafe(promptPath);
  if (!before) {
    note('提示词编辑：prompt.json 不存在，跳过');
    report.promptEdit = { skipped: true };
    return;
  }
  const originalFirst = before.shots[0].prompt;

  // ---- 1. 展开第一条的编辑态，改掉提示词 ----
  const opened = await win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('#shotList .shot-card');
    if (!card) return null;
    card.querySelector('.shot-edit-toggle').click();
    const editBox = card.querySelector('.shot-prompt-edit');
    const input = card.querySelector('[data-field="prompt"]');
    if (!input) return null;
    input.value = '【冒烟测试】改过的提示词 ' + Date.now();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return {
      editVisible: !editBox.hidden,
      dirty: card.classList.contains('dirty'),
      saveBarVisible: !document.getElementById('promptSaveBar').hidden,
      saveCount: document.getElementById('promptSaveCount').textContent,
      typed: input.value,
    };
  })()`);

  note(`提示词编辑：展开=${opened && opened.editVisible} 已改=${opened && opened.dirty} ` +
       `保存栏=${opened && opened.saveBarVisible} 「${opened && opened.saveCount}」`);

  if (!opened) {
    report.problems.push('找不到镜头卡片的编辑入口 —— 无法编辑提示词');
    return;
  }
  if (!opened.editVisible) report.problems.push('点「编辑」后编辑区未展开');
  if (!opened.dirty) report.problems.push('修改提示词后卡片未标记为已改动');
  if (!opened.saveBarVisible) report.problems.push('有未保存改动但保存栏未出现 —— 用户不知道要保存');

  report.shots.push(await shot(win, `${report.scenario}-5-editing`));

  // ---- 2. 点保存，等保存栏收起（说明 dirty 被清掉） ----
  //
  // 注意：保存成功会弹出模态对话框（「保存完成」）。模态是 dialog.showModal()，
  // 它不阻塞 JS 执行，但会挡住后续点击 —— 所以这里等的是保存栏状态，
  // 并在核对完之后把弹窗关掉，否则后面的还原步骤点不到按钮。
  await win.webContents.executeJavaScript(`document.getElementById('btnSavePrompt').click()`);
  const saved = await waitFor(
    win,
    `document.getElementById('promptSaveBar').hidden`,
    20000,
    '保存完成'
  );
  if (!saved) {
    report.problems.push('点保存后保存栏未消失 —— 保存流程可能卡住');
  }

  // 读一下弹窗内容，顺便验证「已写入 N 条」的提示是否给出
  const notice = await win.webContents.executeJavaScript(`(() => {
    const dlg = document.getElementById('errorDialog');
    return {
      open: dlg ? dlg.open : null,
      title: (document.getElementById('errorDialogTitle') || {}).textContent || '',
      body: (document.getElementById('errorDialogRaw') || {}).textContent || '',
    };
  })()`);
  note(`保存提示：open=${notice.open} 标题「${notice.title}」`);
  report.saveNotice = notice;

  if (notice.open && notice.title.includes('失败')) {
    report.problems.push(`保存失败并给出提示：${notice.body.slice(0, 120)}`);
  }

  // 关掉模态，否则后面点不到任何东西
  if (notice.open) {
    await win.webContents.executeJavaScript(`document.getElementById('errorDialog').close()`);
    await sleep(300);
  }

  // ---- 3. 读回磁盘核对：这才是决定性证据 ----
  const after = readJsonSafe(promptPath);
  const written = after && after.shots[0].prompt;
  const changedOnDisk = written === opened.typed;
  note(`提示词落盘核对：${changedOnDisk ? '一致' : `不一致（磁盘="${String(written).slice(0, 30)}"）`}`);
  if (!changedOnDisk) {
    report.problems.push('界面提示已保存，但 prompt.json 内容未变化 —— 保存未真正落盘');
  }

  // 备份文件应已生成（首次保存）
  const backupPath = `${promptPath}.bak`;
  const backupExists = fs.existsSync(backupPath);
  note(`备份文件：${backupExists ? '已生成 prompt.json.bak' : '未生成'}`);
  if (!backupExists) {
    report.problems.push('首次保存未生成 prompt.json.bak —— 用户改错后无法回退');
  }

  // ---- 4. 还原，避免污染产物 ----
  const restored = await win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('#shotList .shot-card');
    if (!card) return false;
    // 重新展开、填入原值、保存
    if (card.querySelector('.shot-prompt-edit').hidden) card.querySelector('.shot-edit-toggle').click();
    const input = card.querySelector('[data-field="prompt"]');
    input.value = ${JSON.stringify(originalFirst)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  if (restored) {
    await win.webContents.executeJavaScript(`document.getElementById('btnSavePrompt').click()`);
    // 还原也会弹模态，先等保存栏收起（说明写完了），再关弹窗
    await waitFor(win, `document.getElementById('promptSaveBar').hidden`, 15000, '还原保存');
    await win.webContents.executeJavaScript(`(() => {
      const d = document.getElementById('errorDialog');
      if (d && d.open) d.close();
    })()`);
    await sleep(400);

    const back = readJsonSafe(promptPath);
    const ok = back && back.shots[0].prompt === originalFirst;
    note(`改动还原：${ok ? '已恢复原值' : '还原失败（产物可能被测试污染）'}`);
    if (!ok) report.problems.push('测试未能还原提示词改动，产物已被污染');
  }

  report.promptEdit = {
    editVisible: opened.editVisible,
    dirty: opened.dirty,
    saveBarVisible: opened.saveBarVisible,
    saveCount: opened.saveCount,
    changedOnDisk,
    backupExists,
    noticeTitle: notice && notice.title,
    restored,
  };

  report.shots.push(await shot(win, `${report.scenario}-6-saved`));

  // 收尾：测试产生的 .bak 不该留在用户的产物目录里。
  // 放在最后做 —— 前面还要用它核对「备份确实生成了」。
  try {
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
  } catch { /* 清不掉不影响判定 */ }
}

/** 读 JSON，失败返回 null（冒烟脚本不该因文件问题崩掉）。 */
function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { run };
