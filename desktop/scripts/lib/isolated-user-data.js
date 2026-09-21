'use strict';

/**
 * 验证脚本的「用户数据隔离」。
 *
 * ── 为什么必须做 ────────────────────────────────────────────────
 * 界面把模型配置写进 Electron 的 userData 目录
 * （Windows 下是 %APPDATA%\<appName>\model-config.json）。而验证脚本
 * 需要在界面里**真的敲进一个 Key** 才能验证「输入 → 保存 → 读回」这条链路。
 *
 * 两者一叠加就出事：脚本往输入框里填 `sk-test-not-a-real-key`，输入框的
 * `input` 监听器立刻 `persistModelConfig()`，于是**测试占位值覆盖了用户
 * 真实保存的 API Key**。
 *
 * 这不是假想 —— 实测踩到过：用户报告「我明明配好了却一直连接失败」，
 * 查配置发现里面躺着 22 个字符的 `sk-test-not-a-real-key`
 * （来自 verify-model-ui.js），真实 Key 已被抹掉。
 *
 * ── 解法 ────────────────────────────────────────────────────────
 * Electron 内建 `--user-data-dir=<路径>` 开关（Chromium 提供，在主进程代码
 * 运行前就生效，无需改应用）。启动时指到一个临时目录，脚本怎么折腾都碰不到
 * 用户的真实配置。
 *
 * ── 用法 ────────────────────────────────────────────────────────
 * ```javascript
 * const { makeIsolatedUserData, cleanupIsolatedUserData } = require('./lib/isolated-user-data');
 *
 * const udd = makeIsolatedUserData('model-ui');
 * const child = spawn(ELECTRON, [ROOT, `--debug-port=${PORT}`, ...udd.args], {...});
 * // ... 验证 ...
 * cleanupIsolatedUserData(udd);
 * ```
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 建一个隔离的 userData 目录，返回可直接展开进 argv 的参数。
 *
 * 放在**系统临时目录**而不是项目目录下：这样它天然不会被 git 看见，
 * 也不会被 `verify:zip-content` 之类的「扫项目目录」逻辑误伤。
 *
 * @param {string} tag 用途标记，出现在目录名里便于排查残留
 * @returns {{dir: string, args: string[]}}
 */
function makeIsolatedUserData(tag) {
  const dir = path.join(
    os.tmpdir(),
    `vrh-verify-udd-${tag}-${process.pid}-${Date.now()}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    // 用 `=` 传值而非空格，与项目里 --debug-port= / --smoke= 的约定一致，
    // 避免 argv 解析歧义。
    args: [`--user-data-dir=${dir}`],
  };
}

/**
 * 删除隔离目录。
 *
 * **失败不抛异常。** 验证脚本的价值在于断言结果，清理失败不该把整体判负；
 * 而且临时目录残留对系统无害（系统会自行回收）。这里只把情况说出来。
 */
function cleanupIsolatedUserData(udd) {
  if (!udd || !udd.dir) return;
  try {
    fs.rmSync(udd.dir, { recursive: true, force: true });
  } catch {
    // 删除守卫可能拦住大批量删除；这是环境限制，不是脚本缺陷。
    // 目录在系统临时目录下，残留无碍。
  }
}

/**
 * 结束应用进程并等待其真正退出。
 *
 * ── 为什么不能只 `child.kill()` ─────────────────────────────────
 * `child.kill()` 只对**直接子进程**发信号。Electron 会再派生 renderer /
 * GPU / utility 等子进程，父进程收到 SIGTERM 后需要时间收回它们。
 * 若紧接着就 `process.exit()`，父进程来不及收尾，子进程会变成孤儿 ——
 * **留在系统里，占着 dist/win-unpacked/ 的文件句柄**。
 *
 * 这不是理论问题：实测残留过 4 个孤儿进程，导致后续 electron-builder
 * 打包失败（删不掉旧目录 → `Device or resource busy`）。症状和代码完全无关，
 * 极难归因。
 *
 * 所以：**先 kill，再等它真的退出**，且必须放在 finally / catch 里 ——
 * 脚本中途抛异常（断言崩溃、CDP 连不上）时最容易漏掉这一步。
 *
 * @param {import('child_process').ChildProcess} child
 * @param {number} timeoutMs 最长等待时间
 */
async function killAndWait(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  /*
   * 等 `exit` 事件，而不是只发信号就返回。
   *
   * 两个实测细节：
   *   1. 被信号终止的进程，`exitCode` 保持 null，信号记在 `signalCode`。
   *      只判 `exitCode` 会误以为「没死」—— 断言必须两个都看。
   *   2. 发完信号立刻返回的话，事件还没被处理，调用方紧接着 `process.exit()`
   *      仍会留下孤儿。所以这里**必须真的等到 exit 事件**。
   */
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve('exited'); return; }
    child.once('exit', () => resolve('exited'));
    try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
  });

  // 超时兜底：SIGTERM 无效时上 SIGKILL。宁可强杀也不要留孤儿。
  const timer = new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs));
  const won = await Promise.race([exited, timer]);

  if (won === 'timeout') {
    const hardExit = new Promise((resolve) => {
      child.once('exit', () => resolve());
      try { child.kill('SIGKILL'); } catch { resolve(); }
    });
    await Promise.race([hardExit, new Promise((r) => setTimeout(r, 2000))]);
  }
}

module.exports = {
  makeIsolatedUserData,
  cleanupIsolatedUserData,
  killAndWait,
};
