'use strict';

/**
 * 布局度量。
 *
 * 截图只能看出「不对劲」，说不出「哪里不对劲」。这个脚本把每个区域的
 * 实际几何尺寸打出来 —— 滚动高度超过可见高度的那一项，就是被裁切的元凶。
 *
 * 支持多断点：一次跑完桌面 / 中窄 / 手机三档，并直接输出该断点下的
 * 布局判定结论（是否单列、有无水平溢出、触控目标是否够大）。
 *
 * 用法：
 *   npm start -- --measure            默认按桌面→中窄→手机顺序测三档
 *   npm start -- --measure=400x640    只测指定尺寸
 */

const VIEWPORTS = [
  { w: 1280, h: 900, label: '桌面' },
  { w: 1024, h: 768, label: '中窄（笔记本分屏）' },
  { w: 720, h: 900, label: '窄屏（平板竖屏）' },
  { w: 400, h: 720, label: '手机' },
];

/** 采集当前视口下的几何数据与判定依据。 */
const PROBE = `(() => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      sel,
      top: Math.round(r.top), bottom: Math.round(r.bottom),
      width: Math.round(r.width),
      height: Math.round(r.height),
      visibleHeight: Math.round(el.clientHeight),
      scrollHeight: el.scrollHeight,
      overflow: Math.round(el.scrollHeight - el.clientHeight),
      flex: cs.flex,
      overflowY: cs.overflowY,
      clippedTop: r.top < 0,
    };
  };

  // 水平溢出是窄屏最常见也最致命的毛病：页面横向被撑开，右侧内容点不到。
  const docWidth = Math.max(
    document.documentElement.scrollWidth,
    document.body.scrollWidth
  );

  // 触控目标：窄屏下所有可见按钮必须够大够好点。
  //
  // 复选框/单选框要按它所在的 <label> 量 —— 用户点的是整行文字，
  // 不是那个 15px 的小方块。按 input 自身量会得出假阳性的结论。
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
      // 折叠起来的分组不算 —— 用户看不见也点不到，不该计入触控目标。
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
      if (r.width === 0 || r.height === 0) return false;
      return r.height < 44;
    })
    .map(({ el, box }) => {
      const name = el.id || el.closest('label')?.textContent.trim().slice(0, 12)
        || el.className || el.tagName;
      return String(name).replace(/\s+/g, ' ') + ':' + Math.round(box.getBoundingClientRect().height);
    });

  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    docWidth,
    overflowX: docWidth > window.innerWidth,
    layoutColumns: getComputedStyle(document.querySelector('.layout')).gridTemplateColumns,
    metricColumns: getComputedStyle(document.querySelector('.metrics')).gridTemplateColumns,
    stageColumns: getComputedStyle(document.querySelector('.stage-track')).gridTemplateColumns,
    kvColumns: getComputedStyle(document.querySelector('.kv') || document.body).gridTemplateColumns,
    logCollapsed: document.querySelector('.log-panel')?.classList.contains('collapsed'),
    logToggleVisible: getComputedStyle(document.querySelector('#btnToggleLog')).display !== 'none',
    smallTargets,
    body: box('body'),
    statusbar: box('.statusbar'),
    layout: box('.layout'),
    configPanel: box('.config-panel'),
    mainColumn: box('.main-column'),
    logPanel: box('.log-panel'),
    logBody: box('.log-body'),
    stageTrack: box('#stageTrack'),
  };
})()`;

async function measureAt(win, w, h, label) {
  // setBounds 改的是含边框的外尺寸，setContentSize 才是真正的渲染视口。
  // 先给足空间再收紧，避免被 minWidth/minHeight 卡住比预期更宽。
  win.setBounds({ x: 60, y: 60, width: w + 60, height: h + 120 });
  win.setContentSize(w, h);
  await new Promise((r) => setTimeout(r, 420));

  const data = await win.webContents.executeJavaScript(PROBE);

  const expectedSingle = w < 900;
  const single = !data.layoutColumns.includes(' ') ||
    data.layoutColumns.split(' ').filter(Boolean).length === 1;

  console.log(`\n=== 布局度量 · ${label} ===`);
  console.log(`视口 ${data.viewport.w}×${data.viewport.h}   文档宽 ${data.docWidth}`);

  const problems = [];

  if (expectedSingle && !single) {
    problems.push(`应变为单列，实际为 "${data.layoutColumns}"`);
  }
  if (!expectedSingle && single) {
    problems.push(`应保持双列，实际为 "${data.layoutColumns}"`);
  }
  if (data.overflowX) {
    problems.push(`存在水平溢出：文档宽 ${data.docWidth} > 视口宽 ${data.viewport.w}`);
  }
  if (expectedSingle && data.smallTargets.length) {
    problems.push(`触控目标小于 44px（共 ${data.smallTargets.length} 个）：${data.smallTargets.slice(0, 8).join(', ')}`);
  }

  console.log(`布局列   : ${data.layoutColumns}${expectedSingle ? '（应为单列）' : '（应为双列）'}`);
  console.log(`指标列   : ${data.metricColumns}`);
  console.log(`阶段条列 : ${data.stageColumns}`);
  console.log(`日志折叠 : ${data.logCollapsed ? '已折叠' : '展开中'} / 折叠按钮 ${data.logToggleVisible ? '可见' : '隐藏'}`);

  for (const [name, b] of Object.entries(data)) {
    if (['viewport', 'docWidth', 'overflowX', 'layoutColumns', 'metricColumns',
         'stageColumns', 'kvColumns', 'logCollapsed', 'logToggleVisible',
         'smallTargets'].includes(name)) continue;
    if (!b) continue;
    const flag = b.clippedTop ? '  ← 顶部被裁切' : (b.overflow > 1 ? `  ← 内容溢出 ${b.overflow}px` : '');
    console.log(
      `${name.padEnd(13)} top=${String(b.top).padStart(6)} w=${String(b.width).padStart(5)} ` +
      `h=${String(b.height).padStart(5)} 可见=${String(b.visibleHeight).padStart(5)} ` +
      `滚动=${String(b.scrollHeight).padStart(5)} flex=${b.flex}${flag}`
    );
  }

  if (problems.length) {
    console.log('判定：');
    for (const p of problems) console.log(`  ! ${p}`);
  } else {
    console.log('判定：通过');
  }

  return { label, w, h, data, problems };
}

async function measure(win) {
  const arg = process.argv.find((a) => a.startsWith('--measure='));
  const list = arg
    ? (() => {
        const [w, h] = arg.slice('--measure='.length).split('x').map(Number);
        return [{ w, h, label: `自定义 ${w}×${h}` }];
      })()
    : VIEWPORTS;

  const results = [];
  for (const vp of list) {
    results.push(await measureAt(win, vp.w, vp.h, vp.label));
  }

  const failed = results.filter((r) => r.problems.length);
  console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 档通过 ===`);
  if (failed.length) {
    for (const r of failed) {
      console.log(`  ! ${r.label}（${r.w}×${r.h}）`);
      for (const p of r.problems) console.log(`      ${p}`);
    }
  }
  console.log('');
  return results;
}

module.exports = { measure };
