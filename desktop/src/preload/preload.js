'use strict';

/**
 * 预加载脚本：渲染进程与主进程之间唯一的桥。
 *
 * 这里只暴露一组窄接口，而不是把 ipcRenderer 整个交出去。渲染进程拿到的是
 * 具体动作（探测环境、启动运行），而不是「可以往任意频道发任意消息」的能力。
 */

const { contextBridge, ipcRenderer } = require('electron');

/** 主进程 → 渲染进程的推送频道。逐一订阅，不用通配。 */
const PUSH_CHANNELS = ['vrh:log', 'vrh:stage', 'vrh:cost', 'vrh:command', 'vrh:done'];

contextBridge.exposeInMainWorld('vrh', {
  /** 环境探测，返回 { ok, canRun, python, ffmpeg, harness, problems }。 */
  doctor: () => ipcRenderer.invoke('vrh:doctor'),

  /**
   * 手动指定 harness 目录。
   *
   * 打包后应用无法靠相对路径找到 harness（Python 侧不会被打进 exe），
   * 这条通道是唯一的兜底。返回 { ok, repoRoot?, env?, message?, canceled? }。
   */
  pickRepo: () => ipcRenderer.invoke('vrh:pick-repo'),

  /** 清除手选目录，回到自动查找。 */
  clearRepo: () => ipcRenderer.invoke('vrh:clear-repo'),

  /**
   * 打开「harness 放置说明」。
   *
   * 用户点这个按钮时通常正是程序跑不起来的时候，所以主进程保证它一定有反馈
   * （打开文件 / 现写一份 / 弹窗显示正文）。返回 { ok, path, action }。
   */
  openNotice: () => ipcRenderer.invoke('vrh:open-notice'),

  /** 弹出文件选择器，返回绝对路径或 null。 */
  pickVideo: () => ipcRenderer.invoke('vrh:pick-video'),

  /** 启动运行。config 为表单配置。 */
  run: (config) => ipcRenderer.invoke('vrh:run', config),

  /** 停止当前运行（会终止整棵进程树）。 */
  stop: () => ipcRenderer.invoke('vrh:stop'),

  /** 读取指定视频已有产物。 */
  artifacts: (videoPath) => ipcRenderer.invoke('vrh:artifacts', videoPath),

  /**
   * 保存镜头提示词的修改，写回 prompt.json。
   * edits: { videoPath, expectedShotCount, shots: [{ shotId, prompt, negativePrompt }] }
   */
  savePrompt: (edits) => ipcRenderer.invoke('vrh:save-prompt', edits),

  /** 把当前 prompt.json 另存为。 */
  exportPrompt: (videoPath, defaultName) =>
    ipcRenderer.invoke('vrh:export-prompt', { videoPath, defaultName }),

  /** 在文件管理器中定位文件。 */
  reveal: (targetPath) => ipcRenderer.invoke('vrh:reveal', targetPath),

  /** 用系统默认程序打开文件。 */
  openPath: (targetPath) => ipcRenderer.invoke('vrh:open-path', targetPath),

  /** 导出日志文本。 */
  exportLogs: (content, defaultName) =>
    ipcRenderer.invoke('vrh:export-logs', { content, defaultName }),

  /** 列出可用预设。 */
  presets: () => ipcRenderer.invoke('vrh:presets'),

  /**
   * 模型配置的持久化。
   *
   * 存在 Electron 的 userData 目录，不在源码/安装目录里 —— 卸载或换用户时
   * 不会把 Key 一起带走。返回值有意不含任何校验，读取失败时渲染层退化为默认值。
   */
  loadModelConfig: () => ipcRenderer.invoke('vrh:load-model-config'),
  saveModelConfig: (config) => ipcRenderer.invoke('vrh:save-model-config', config),

  /**
   * 测试模型连通性。
   *
   * 会真的发一次带图的请求（很小的图），用于在跑整个流水线之前确认
   * Key、地址、模型名三者都对。返回 { ok, detail? , message? }。
   */
  testModel: (config) => ipcRenderer.invoke('vrh:test-model', config),

  /**
   * 订阅主进程推送。返回取消订阅函数 —— 组件销毁时调用，避免监听器泄漏。
   */
  subscribe(channel, handler) {
    if (!PUSH_CHANNELS.includes(channel)) {
      throw new Error(`未知频道：${channel}`);
    }
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
