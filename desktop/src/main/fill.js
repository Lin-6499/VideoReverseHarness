'use strict';

/**
 * 首屏填充检查。
 *
 * 截图里控件是空的，有两种可能：
 *   1) 数据没加载进来（真实缺陷）
 *   2) 截图时机早于填充（截图假象）
 * 截图分不清这两者，所以直接读 DOM 状态。
 *
 * 注意必须「等到就位」而不是「等固定秒数」：init() 的第一步
 * refreshEnvironment() 要拉起 Python 与 ffmpeg 探版本，冷启动可能数秒，
 * 固定等待会把「还没轮到」误判成「没加载」。
 *
 * 用法：npm start -- --fill
 */

const PROBE = `(() => {
  const sel = document.getElementById('preset');
  const opts = [...sel.options];
  return {
    optionCount: opts.length,
    values: opts.map((o) => o.value),
    labels: opts.map((o) => o.textContent),
    selectedIndex: sel.selectedIndex,
    selectedValue: sel.value,
    selectedLabel: sel.options[sel.selectedIndex]?.textContent || '',
    stageLabels: [...document.querySelectorAll('#stageTrack .stage-label')].map((e) => e.textContent.trim()),
    commandPreview: document.getElementById('commandPreview').textContent.trim().slice(0, 90),
    configGroups: [...document.querySelectorAll('.cfg-group')].map((g) => ({
      title: g.querySelector('.cfg-summary').textContent.trim(),
      open: g.open,
    })),
    toggleAllLabel: document.getElementById('btnToggleAllGroups').textContent.trim(),
    logNoticeHidden: document.getElementById('logRawNotice').hidden,
  };
})()`;

/** 等到预设与命令预览都填充完毕，或超时。返回耗时毫秒。 */
async function waitForFill(win, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const done = await win.webContents.executeJavaScript(
      `(() => {
         const sel = document.getElementById('preset');
         const cmd = document.getElementById('commandPreview');
         return sel.options.length > 0 && cmd && !cmd.hidden
           && cmd.textContent.trim().length > 0;
       })()`
    ).catch(() => false);
    if (done) return Date.now() - started;
    await new Promise((r) => setTimeout(r, 200));
  }
  return Date.now() - started;
}

async function checkFill(win) {
  // 抓渲染进程的报错：init() 是串行 await 的，中间任何一步抛异常都会
  // 让后面的初始化静默不执行（预设不加载、命令预览为空）。
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });

  const waited = await waitForFill(win);
  await new Promise((r) => setTimeout(r, 300));
  const data = await win.webContents.executeJavaScript(PROBE);

  console.log('\n=== 首屏填充检查 ===');
  console.log(`初始化耗时 : ${waited}ms（等预设与命令预览就位）`);
  console.log(`预设项数   : ${data.optionCount}`);
  console.log(`预设取值   : ${data.values.join(', ')}`);
  console.log(`预设文案   : ${data.labels.join(' | ')}`);
  console.log(`当前选中   : [${data.selectedIndex}] ${data.selectedValue} → "${data.selectedLabel}"`);

  console.log('\n阶段标签   :');
  for (const l of data.stageLabels) console.log(`  ${l}`);

  console.log(`\n命令预览   : ${data.commandPreview}…`);

  console.log('\n配置分组   :');
  for (const g of data.configGroups) {
    console.log(`  ${g.open ? '[展开]' : '[收起]'} ${g.title}`);
  }
  console.log(`批量按钮   : "${data.toggleAllLabel}"`);

  if (errors.length) {
    console.log('\n渲染进程报错：');
    for (const e of errors) console.log(`  ! ${e}`);
  }

  const problems = [];
  if (data.optionCount === 0) problems.push('预设下拉一项都没有 —— 预设未加载');
  if (!data.selectedValue) problems.push('预设下拉未选中任何项');
  if (data.stageLabels.length !== 5) problems.push(`阶段条应有 5 项，实际 ${data.stageLabels.length}`);
  if (!data.stageLabels.every((l) => /[\u4e00-\u9fa5]/.test(l))) {
    problems.push('阶段标签缺少中文名');
  }
  if (data.configGroups.length !== 5) problems.push(`配置分组应有 5 组，实际 ${data.configGroups.length}`);
  if (!data.configGroups.slice(0, 2).every((g) => g.open)) {
    problems.push('前两组应默认展开');
  }
  if (!data.commandPreview) problems.push('命令预览为空 —— 初始化链可能中途断了');
  // 中英混排提示条在还没跑过流水线时应保持隐藏。
  if (!data.logNoticeHidden) problems.push('尚未运行就显示了「原始输出」提示条');

  console.log('');
  if (problems.length) {
    for (const p of problems) console.log(`  ! ${p}`);
  } else {
    console.log('判定：通过');
  }
  console.log('');
  return { data, problems };
}

module.exports = { checkFill };
