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

module.exports = { makeIsolatedUserData, cleanupIsolatedUserData };
