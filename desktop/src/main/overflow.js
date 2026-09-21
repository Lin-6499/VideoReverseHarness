'use strict';

/**
 * 水平溢出定位。
 *
 * 文档宽超出视口宽时，肉眼只能看出「右边被切了」，说不出是哪个元素撑的。
 * 这个脚本遍历所有元素，找出右边界超出视口宽的那些，按超出量排序。
 *
 * 用法：npm start -- --overflow=400x720
 */

const PROBE = `(() => {
  const vw = window.innerWidth;
  const offenders = [];
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    const right = r.right;
    const over = Math.round(right - vw);
    if (over > 1 || r.width > vw + 1) {
      offenders.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        cls: (el.className && typeof el.className === 'string') ? el.className : '',
        left: Math.round(r.left),
        right: Math.round(right),
        width: Math.round(r.width),
        over,
        scrollW: el.scrollWidth,
        minW: cs.minWidth,
        flexBasis: cs.flexBasis,
      });
    }
  }
  offenders.sort((a, b) => Math.max(b.over, b.width - vw) - Math.max(a.over, a.width - vw));

  // 纵向可达性：截图只能看到首屏，看不到下面还有没有内容。
  // 把各区块的纵向位置列出来，就能确认没被裁掉、也没被压在视口外。
  const sections = [
    ['状态栏', '.statusbar'],
    ['布局容器', '.layout'],
    ['主列', '.main-column'],
    ['控制面板', '.control-panel'],
    ['指标', '.metrics'],
    ['结果面板', '.result-panel'],
    ['配置面板', '.config-panel'],
    ['日志面板', '.log-panel'],
  ].map(([name, sel]) => {
    const el = document.querySelector(sel);
    if (!el) return { name, missing: true };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      name,
      top: Math.round(r.top + window.scrollY),
      height: Math.round(r.height),
      scrollH: el.scrollHeight,
      display: cs.display,
      order: cs.order,
      flex: cs.flex,
      visible: r.height > 0,
    };
  });

  return {
    viewport: vw,
    docScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    docScrollHeight: document.documentElement.scrollHeight,
    offenders: offenders.slice(0, 25),
    sections,
  };
})()`;

async function findOverflow(win, w, h) {
  win.setBounds({ x: 60, y: 60, width: w + 60, height: h + 120 });
  win.setContentSize(w, h);
  await new Promise((r) => setTimeout(r, 420));

  const data = await win.webContents.executeJavaScript(PROBE);

  console.log(`\n=== 水平溢出定位 · 视口 ${data.viewport} ===`);
  console.log(`documentElement.scrollWidth = ${data.docScrollWidth}`);
  console.log(`body.scrollWidth            = ${data.bodyScrollWidth}`);
  console.log(`documentElement.scrollHeight= ${data.docScrollHeight}（整页高度）`);

  if (!data.offenders.length) {
    console.log('未发现超出视口的元素。');
  } else {
    console.log('\n超出视口的元素（按严重程度排序）：');
    for (const o of data.offenders) {
      const label = `<${o.tag}${o.id ? '#' + o.id : ''}${o.cls ? '.' + String(o.cls).split(' ').join('.') : ''}>`;
      console.log(
        `  left=${String(o.left).padStart(5)} right=${String(o.right).padStart(5)} ` +
        `w=${String(o.width).padStart(5)} 超出=${String(o.over).padStart(5)} ` +
        `scrollW=${String(o.scrollW).padStart(5)} minW=${o.minW}  ${label}`
      );
    }
  }

  console.log('\n纵向区块位置：');
  for (const s of data.sections) {
    if (s.missing) {
      console.log(`  ${s.name.padEnd(10)} 不存在`);
      continue;
    }
    const flag = !s.visible ? '  ← 高度为 0，不可见！' : '';
    console.log(
      `  ${s.name.padEnd(10)} top=${String(s.top).padStart(6)} h=${String(s.height).padStart(5)} ` +
      `scrollH=${String(s.scrollH).padStart(5)} display=${s.display.padEnd(5)} order=${s.order}${flag}`
    );
  }
  console.log('');
  return data;
}

module.exports = { findOverflow };
