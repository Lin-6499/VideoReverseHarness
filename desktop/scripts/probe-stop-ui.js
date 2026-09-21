'use strict';

/**
 * 探针：中断后界面是否处于「可以重试」的状态。
 *
 * 中断最容易被做错的地方不是提示文字，而是**按钮状态**：
 * 如果停止后「开始运行」没恢复可用，用户就被卡死了。
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');
const environment = require('../src/main/environment');
const runner = require('../src/main/runner');

let win = null;
let activeRun = null;

function send(ch, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, payload);
}

app.whenReady().then(async () => {
  ipcMain.handle('vrh:doctor', async () => environment.doctor());
  ipcMain.handle('vrh:presets', async () => ['t2v_generic', 'i2v_generic']);
  ipcMain.handle('vrh:reveal', async () => true);
  ipcMain.handle('vrh:open-path', async () => true);
  ipcMain.handle('vrh:artifacts', async () => null);
  ipcMain.handle('vrh:stop', async () => {
    if (!activeRun) return { ok: false, message: '当前没有运行中的任务' };
    const r = activeRun.stop();
    return { ok: r, message: r ? '已发送停止信号' : '停止失败' };
  });
  ipcMain.handle('vrh:run', async (_e, config) => {
    const env = await environment.doctor();
    if (!env.canRun) return { ok: false, message: '环境未就绪' };
    if (!config.videoPath || !fs.existsSync(config.videoPath)) return { ok: false, message: '视频不存在' };
    activeRun = runner.startRun(config, { pythonPath: env.python.path, repoRoot: env.repoRoot }, {
      onLog: (l) => send('vrh:log', l),
      onStage: (e) => send('vrh:stage', e),
      onCost: (c) => send('vrh:cost', c),
      onCommand: (c) => send('vrh:command', c),
      onDone: (result) => { activeRun = null; send('vrh:done', { ...result, artifacts: null }); },
    });
    return { ok: true, pid: activeRun.pid };
  });

  win = new BrowserWindow({
    width: 1600, height: 1000, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: false,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 2500));

  const videoPath = path.resolve(__dirname, '..', '..', 'samples', 'clip.mp4');
  const payload = JSON.stringify(JSON.stringify({ videoPath, preset: 't2v_generic', fresh: true }));
  await win.webContents.executeJavaScript(`window.__smokeSetConfig(JSON.parse(${payload}))`);
  await new Promise((r) => setTimeout(r, 200));
  await win.webContents.executeJavaScript(`document.getElementById('btnRun').click()`);

  // 连点采样，看按钮状态与日志随时间怎么变
  const samples = [];
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    const s = await win.webContents.executeJavaScript(`(() => ({
      logs: document.querySelectorAll('#logBody .log-line').length,
      btnRun: document.getElementById('btnRun').disabled ? 'disabled' : 'enabled',
      btnStop: document.getElementById('btnStop').disabled ? 'disabled' : 'enabled',
      status: document.getElementById('statusText').textContent.trim(),
      stages: [...document.querySelectorAll('#stageTrack .stage')].map((e) => (e.className.replace('stage ', '') || '待')).join(','),
    }))()`);
    s.tick = i;
    samples.push(s);
    if (i === 4) {
      // 第 2.5 秒点停止
      await win.webContents.executeJavaScript(`document.getElementById('btnStop').click()`);
      s.note = 'stop-clicked';
    }
  }

  console.log('TIME_SERIES=' + JSON.stringify(samples, null, 1));
  app.exit(0);
});
