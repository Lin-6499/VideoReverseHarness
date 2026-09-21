'use strict';

/**
 * 分离启动打包应用，使其不随调用方会话结束而退出。
 *
 * 为什么必须分离：每次工具调用都是独立会话，会话一结束，其子进程就被收走，
 * 导致 CDP 端口刚开就断。detached + unref 让进程脱离父进程组，交由系统托管。
 *
 * 另：必须清掉 NODE_OPTIONS。当前环境注入了 IDE 的 language shim，
 * Electron 打包应用检测到该变量会直接拒绝启动（不是应用缺陷）。
 *
 * 用法：node scripts/launch-packaged-detached.js
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const UNPACKED = path.resolve(__dirname, '..', 'dist', 'win-unpacked');
const EXE = path.join(UNPACKED, 'VRH 视频反推.exe');
const LOG = path.resolve(__dirname, '..', 'pkg-run.log');
const ERR = path.resolve(__dirname, '..', 'pkg-run.err');

if (!fs.existsSync(EXE)) {
  console.error(`未找到打包产物：${EXE}\n请先运行 npm run dist`);
  process.exit(1);
}

// 复制环境变量并剔除 NODE_OPTIONS —— 打包应用不接受它。
const env = { ...process.env };
delete env.NODE_OPTIONS;

/*
 * 调试端口走应用自有的 `--debug-port=` 开关，不直接传 Chromium 的
 * `--remote-debugging-port`。
 *
 * 原因：打包后的 Electron 应用按自己的规则解析 argv，遇到不认识的开关会报
 * 「bad option」直接退出。实测过两条错路：
 *   - `--remote-debugging-port=9222`  → 应用拒绝，进程立刻死
 *   - `ELECTRON_EXTRA_LAUNCH_ARGS`    → 不是真实存在的 Electron 变量，无效
 * 正确做法是应用自己在 app ready 前用 app.commandLine.appendSwitch 转写
 * （见 main.js）。这样打包态也能被外部调试，而不用把诊断脚本塞回 asar。
 */
const PORT = Number(process.env.VRH_DEBUG_PORT || 9222);

/*
 * 先探测端口是否已被占用。
 *
 * 曾经的现象：上一个实例刚被 taskkill，端口还没释放就启动新实例，
 * 新实例拿不到端口（或旧进程还没完全退出），结果 err 里什么都没有、
 * 进程却已经不在了 —— 看起来像「应用启动失败」，实际是时序问题。
 * 这里先确认端口是空的，不是就明确报出来，而不是让调用方等到超时。
 */
function portBusy() {
  return new Promise((resolve) => {
    const http = require('http');
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/version' }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

const out = fs.openSync(LOG, 'w');
const err = fs.openSync(ERR, 'w');

(async () => {
  // 端口被占用时不要硬启 —— 会得到一个「启动成功但连不上」的假象。
  if (await portBusy()) {
    console.error(`端口 ${PORT} 已被占用。可能是上一个实例还在退出途中。`);
    console.error('请先 taskkill /F /IM "VRH 视频反推.exe"，等两秒再试。');
    process.exit(2);
  }

  const child = spawn(EXE, [`--debug-port=${PORT}`], {
    cwd: UNPACKED,
    env,
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: false,
  });

  child.unref();

  console.log(`已分离启动：PID ${child.pid}`);
  console.log(`日志：${LOG}`);
  console.log('等待 CDP 端口就绪…');

  // 轮询端口，等条件而非等固定时间 —— 冷启动耗时取决于磁盘与杀软扫描。
  const deadline = Date.now() + 60000;

  while (Date.now() < deadline) {
    const body = await probe();
    if (body) {
      const info = JSON.parse(body);
      console.log(`\nCDP 已就绪：${info.Browser}`);
      console.log('可以运行 node scripts/inspect-packaged.js');
      process.exit(0);
    }
    // 进程已死就别等了 —— 直接看 err，比空等 60 秒有用。
    if (child.exitCode !== null || child.signalCode !== null) {
      console.error(`\n进程已退出（code=${child.exitCode}），看 ${ERR}`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.error('\nCDP 端口在 60 秒内未就绪，请查看 pkg-run.err');
  process.exit(1);
})();

function probe() {
  const http = require('http');
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/version' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(res.statusCode === 200 ? body : null));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
  });
}
