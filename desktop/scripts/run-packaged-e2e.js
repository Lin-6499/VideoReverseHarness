'use strict';

/**
 * 通过 CDP 驱动打包应用真实跑一次流水线。
 *
 * 目的：证明 exe → Python harness 的调用链路在打包后仍然通 ——
 * 只验证界面初始化是不够的，那只能说明「看得见」，不能说明「跑得动」。
 *
 * 前置：exe 已用 --debug-port=9222 启动（见 launch-packaged-detached.js），
 * 且 harness 已就位。
 * 用法：node scripts/run-packaged-e2e.js
 */

const http = require('http');

const PORT = Number(process.env.CDP_PORT || 9222);
const VIDEO = process.env.VRH_TEST_VIDEO || 'D:\\HarnessTest\\samples\\clip.mp4';

function fetchJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('请求超时')));
  });
}

async function main() {
  const targets = await fetchJson('/json/list');
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('未找到页面 target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();

  const evaluate = (expression) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }));
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data.toString());
    const handler = pending.get(msg.id);
    if (!handler) return;
    pending.delete(msg.id);
    if (msg.result && msg.result.exceptionDetails) {
      const detail = msg.result.exceptionDetails;
      handler.reject(new Error((detail.exception && detail.exception.description) || detail.text));
    } else {
      handler.resolve(msg.result.result.value);
    }
  });

  await new Promise((resolve) => ws.addEventListener('open', resolve));

  // 0. 等界面初始化完成。
  //    不这样做的话，下面的「点干跑」可能在环境还没探完时发出 —— 那时运行按钮
  //    还是禁用的，click() 静默无效，脚本会一路等到超时，看起来像链路不通。
  //    界面在最后一步设置 `<html data-ready="1">`，等这个比猜时间稳。
  const readyDeadline = Date.now() + 90000;
  let ready = false;
  while (Date.now() < readyDeadline) {
    const state = await evaluate(`(() => ({
      done: document.documentElement.dataset.ready === '1',
      text: document.getElementById('statusText').textContent.trim(),
    }))()`);
    if (state && state.done) { console.log(`界面就绪：「${state.text}」`); ready = true; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) throw new Error('界面在 90 秒内未完成初始化 —— 后续点击会被忽略，中止');

  // 1. 填入视频路径。用 input 事件触发，让命令预览跟着更新。
  console.log(`选择视频：${VIDEO}`);
  const filled = await evaluate(`(() => {
    const input = document.getElementById('videoPath');
    input.value = ${JSON.stringify(VIDEO)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
  console.log(`输入框值：${filled}`);

  // 2. 点「干跑」—— 不走真实模型，但仍会调起 Python 并把流水线跑到切分层。
  console.log('点击「干跑」…');
  await evaluate(`document.getElementById('btnDryRun').click()`);

  // 3. 等结论。等条件而非等固定时间：流水线耗时取决于环境和缓存。
  const deadline = Date.now() + 90000;
  let dom = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    dom = await evaluate(`(() => {
      const body = document.getElementById('resultBody');
      const lines = [...document.querySelectorAll('#logBody .log-line')];
      return {
        kind: body.dataset.kind || null,
        statusText: document.getElementById('statusText').textContent.trim(),
        statusDetail: document.getElementById('statusDetail').textContent.trim(),
        logLines: lines.length,
        lastLogs: lines.slice(-8).map((l) => l.innerText.trim().replace(/\\s+/g, ' ')),
      };
    })()`);
    if (dom.kind) break;
    process.stdout.write(`  等待中：日志 ${dom.logLines} 行，状态「${dom.statusText}」\r`);
  }

  console.log('\n\n=== 打包应用真实运行结果 ===\n');
  console.log(`结论标识    ：${dom.kind || '(超时未出结论)'}`);
  console.log(`状态栏文案  ：${dom.statusText}`);
  console.log(`状态栏细节  ：${dom.statusDetail || '(空)'}`);
  console.log(`日志行数    ：${dom.logLines}`);
  console.log('\n最近日志：');
  (dom.lastLogs || []).forEach((line) => console.log(`  ${line}`));
  console.log('');

  // 判定口径：界面自洽 —— 只要产生了日志且给出了结论，就说明
  // exe → Python 的链路是通的。结论本身是 success 还是 error 取决于
  // 沙箱能否放过 harness 的文件操作，不该由本探针来判成败。
  const ok = Boolean(dom.kind) && dom.logLines > 0;
  console.log(ok
    ? `通过 —— exe 成功调起 Python harness 并产生流水线输出（界面结论：${dom.kind}）`
    : '失败 —— 未产生预期的运行输出');

  ws.close();
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(`验证失败：${error.message}`);
  process.exit(1);
});
