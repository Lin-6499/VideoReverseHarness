'use strict';

/**
 * 探针：捕获一次真实运行收到的全部事件，用于诊断界面与实际数据是否一致。
 *
 * 存在的理由：冒烟测试只能看到「界面最后长什么样」。当界面显示不对时，
 * 得先分清楚是「主进程没发事件」还是「渲染层收下了却画错了」——
 * 这个脚本把事件流原样打印出来，让两者可分辨。
 *
 * 用法：npx electron scripts/probe-events.js
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');

const environment = require('../src/main/environment');
const runner = require('../src/main/runner');

let mainWindow = null;
let activeRun = null;

const collected = { logs: [], stages: [], costs: [], commands: [], done: null };

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

app.whenReady().then(async () => {
  ipcMain.handle('vrh:doctor', async () => environment.doctor());
  ipcMain.handle('vrh:presets', async () => ['t2v_generic', 'i2v_generic']);
  ipcMain.handle('vrh:reveal', async () => true);
  ipcMain.handle('vrh:open-path', async () => true);
  ipcMain.handle('vrh:artifacts', async () => null);
  ipcMain.handle('vrh:stop', async () => {
    if (!activeRun) return { ok: false, message: '当前没有运行中的任务' };
    const stopped = activeRun.stop();
    return { ok: stopped, message: stopped ? '已发送停止信号' : '停止失败' };
  });

  ipcMain.handle('vrh:run', async (_event, config) => {
    const env = await environment.doctor();
    if (!env.canRun) return { ok: false, message: '环境未就绪' };
    if (!config.videoPath || !fs.existsSync(config.videoPath)) {
      return { ok: false, message: '视频文件不存在' };
    }

    activeRun = runner.startRun(
      config,
      { pythonPath: env.python.path, repoRoot: env.repoRoot },
      {
        onLog: (log) => {
          collected.logs.push({ level: log.level, msg: String(log.msg).slice(0, 100) });
          send('vrh:log', log);
        },
        onStage: (ev) => { collected.stages.push(ev); send('vrh:stage', ev); },
        onCost: (c) => { collected.costs.push(c); send('vrh:cost', c); },
        onCommand: (cmd) => { collected.commands.push(cmd); send('vrh:command', cmd); },
        onDone: (result) => {
          activeRun = null;
          collected.done = { kind: result.outcome.kind, exitCode: result.exitCode, label: result.outcome.label };
          send('vrh:done', { ...result, artifacts: null });
        },
      }
    );
    return { ok: true, pid: activeRun.pid };
  });

  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });
  await mainWindow.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 2500));

  const videoPath = path.resolve(__dirname, '..', '..', 'samples', 'clip.mp4');
  // 双重 JSON 编码：config 要穿过 executeJavaScript 的源码层，再做一次
  // JSON.parse 才能还原反斜杠，避免 Windows 路径被吃掉一层。
  const payload = JSON.stringify(JSON.stringify({ videoPath, preset: 't2v_generic', fresh: true }));
  await mainWindow.webContents.executeJavaScript(`window.__smokeSetConfig(JSON.parse(${payload}))`);
  await new Promise((r) => setTimeout(r, 200));
  await mainWindow.webContents.executeJavaScript(`document.getElementById('btnRun').click()`);

  for (let i = 0; i < 120 && !collected.done; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 1000));

  const dom = await mainWindow.webContents.executeJavaScript(`(() => ({
    stages: [...document.querySelectorAll('#stageTrack .stage')].map((e) => ({
      label: e.querySelector('.stage-label') ? e.querySelector('.stage-label').textContent.trim() : '',
      cls: e.className,
    })),
    badge: document.getElementById('resultBadge').textContent.trim(),
    badgeHidden: document.getElementById('resultBadge').hidden,
    body: document.getElementById('resultBody').textContent.trim().slice(0, 180),
    logCount: document.getElementById('logCount').textContent.trim(),
  }))()`);

  console.log('\n===== 事件流诊断 =====');
  console.log('命令        : ' + (collected.commands[0] || '(无)'));
  console.log('日志条数    : ' + collected.logs.length);
  console.log('级别分布    : ' + JSON.stringify(collected.logs.reduce((a, l) => {
    a[l.level] = (a[l.level] || 0) + 1; return a;
  }, {})));
  console.log('阶段事件数  : ' + collected.stages.length);
  console.log('阶段事件    : ' + JSON.stringify(collected.stages));
  console.log('成本事件数  : ' + collected.costs.length);
  console.log('结束判定    : ' + JSON.stringify(collected.done));
  console.log('\n----- 日志原文 -----');
  collected.logs.forEach((l, i) => console.log(String(i).padStart(2) + ' [' + l.level + '] ' + l.msg));
  console.log('\n----- 界面 DOM -----');
  console.log(JSON.stringify(dom, null, 2));
  console.log('');

  app.exit(0);
});
