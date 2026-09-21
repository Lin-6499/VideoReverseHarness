// 探针：error 场景下界面到底显示了什么。
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

// 复用真实主进程的 IPC 注册
const environment = require('../src/main/environment');
const artifacts = require('../src/main/artifacts');
const runner = require('../src/main/runner');
const fs = require('fs');

let mainWindow = null;
let activeRun = null;

app.whenReady().then(async () => {
  ipcMain.handle('vrh:doctor', async () => environment.doctor());
  ipcMain.handle('vrh:presets', async () => {
    const env = await environment.doctor();
    const dir = path.join(env.repoRoot, 'configs', 'presets');
    try { return fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => f.replace(/\.yaml$/, '')); }
    catch { return []; }
  });
  ipcMain.handle('vrh:run', async (_e, config) => {
    const env = await environment.doctor();
    if (!env.canRun) return { ok: false, message: '环境未就绪，无法启动运行' };
    if (!config.videoPath) return { ok: false, message: '请先选择视频文件' };
    if (!fs.existsSync(config.videoPath)) {
      return { ok: false, message: `视频文件不存在：${config.videoPath}` };
    }
    return { ok: true, pid: 12345 };
  });
  ipcMain.handle('vrh:stop', async () => ({ ok: true, message: '已发送停止信号' }));
  ipcMain.handle('vrh:reveal', async () => true);
  ipcMain.handle('vrh:open-path', async () => true);
  ipcMain.handle('vrh:artifacts', async () => null);
  ipcMain.handle('vrh:pick-video', async () => null);

  mainWindow = new BrowserWindow({
    width: 1600, height: 1000, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: false,
    },
  });
  await mainWindow.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 2500));

  const result = await mainWindow.webContents.executeJavaScript(`(async () => {
    window.__smokeSetConfig({ videoPath: 'D:////HarnessTest////samples////does-not-exist.mp4', preset: 't2v_generic' });
    await new Promise((r) => setTimeout(r, 100));
    document.getElementById('btnRun').click();
    await new Promise((r) => setTimeout(r, 1500));
    return {
      logCount: document.getElementById('logCount').textContent.trim(),
      logLines: [...document.querySelectorAll('#logBody .log-line')].map((e) => e.textContent.trim()),
      resultKind: document.getElementById('resultBody').dataset.kind || null,
      badgeHidden: document.getElementById('resultBadge').hidden,
      resultBody: document.getElementById('resultBody').textContent.trim().slice(0, 200),
      btnRunDisabled: document.getElementById('btnRun').disabled,
      btnStopDisabled: document.getElementById('btnStop').disabled,
      statusText: document.getElementById('statusText').textContent.trim(),
      resultBodyHtml: document.getElementById('resultBody').innerHTML.slice(0, 400),
    };
  })()`);

  console.log('PROBE_RESULT=' + JSON.stringify(result, null, 2));
  app.exit(0);
});
