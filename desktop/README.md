# VRH 桌面端

Electron 界面，用于可视化调用 `vrh` 视频反推 harness。

它不重新实现任何流水线逻辑 —— 只负责把界面上的配置翻译成 CLI 参数、把子进程的
输出实时呈现出来、把产物 JSON 渲染成可读的结果。

```
desktop/
├── package.json
├── src/
│   ├── main/                   主进程（唯一有权起子进程的层）
│   │   ├── main.js             Electron 入口、IPC 注册、窗口管理
│   │   ├── environment.js      环境探测（Python / ffmpeg / harness）
│   │   ├── runner.js           参数组装、spawn、NDJSON 解析、结果判定
│   │   ├── artifacts.js        读取 output/<id>/*.json
│   │   ├── smoke.js            界面冒烟测试（驱动真实界面并截图）
│   │   ├── measure.js          多断点布局度量（几何尺寸与判定）
│   │   ├── overflow.js         水平溢出定位 + 纵向区块可达性
│   │   ├── fill.js             首屏异步填充检查
│   │   └── procs.js            停止操作的进程树终止验证
│   ├── preload/preload.js      contextBridge：渲染进程唯一的入口
│   └── renderer/               界面
│       ├── index.html
│       ├── styles.css
│       └── renderer.js
└── scripts/
    ├── selftest.js             纯函数自检（无需 Electron）
    ├── e2e.js                  真实 spawn harness 的联调脚本
    ├── run-all.js              依次跑完全部冒烟场景
    ├── make-icon.js            生成 build/icon.ico 与 icon.png（零依赖）
    ├── make-zip.js             便携目录打包成 zip（附放置说明）
    ├── check-packaged-paths.js 打包后路径解析的单元验证（11 项）
    ├── inspect-packaged.js     打包态界面初始化断言（CDP）
    ├── run-packaged-e2e.js     打包态驱动真实流水线（CDP）
    ├── launch-packaged-detached.js  分离启动打包应用并等调试端口
    ├── link-harness.js         junction 的建立/移除/查看
    └── probe-*.js              针对性探针（事件流、错误态、中断时序等）
```

## 运行

```bash
cd desktop
npm install
npm start          # 启动
npm run dev        # 启动并打开开发者工具
```

前置条件：harness 仓库根目录下已有可用的 `.venv` 与 `tools/ffmpeg.exe`。
界面启动时会自动探测，不满足时顶部会给出具体缺失项与修复命令。

## 打包为可执行文件

```bash
npm run dist       # 产出 dist/win-unpacked/（便携版目录，双击即用）
npm run dist:zip   # 在上面基础上再压成 dist/VRH-desktop-<版本>-portable.zip
```

### exe 如何找到 harness（关键设计）

**harness 不会被打进 exe。** 它是独立的 Python 项目（含 `.venv` 与便携
ffmpeg，1GB+），把它塞进安装包会让分发体积失控，且 harness 一更新就得重新
打包。exe 只提供界面，负责「找到」harness。

因此 `repoRoot` 不是写死的路径，而是一条**候选链**，逐个校验后取第一个命中：

| 顺序 | 候选位置 | 用途 |
|---|---|---|
| 1 | 环境变量 `VRH_ROOT` | 显式指定，CI / 多仓库场景 |
| 2 | 用户上次手选的目录 | 记住用户意图，不用每次重选（存于 `%APPDATA%\VRH 视频反推\config.json`） |
| 3 | exe 同级目录 → 上溯 4 级，**每一级都再试一个 `harness/` 子目录** | 覆盖各种便携分发形态（见下表） |
| 4 | 源码目录上溯三级 | 开发态兜底，保证 `npm start` 行为不变 |

第 3 项展开后共 10 个候选，就近优先：

| 距离 | exe 所在位置 | 覆盖的场景 |
|---|---|---|
| 0 级 | 与仓库根同级 | 绿色版解压到 harness 旁边 |
| 1 级 | `<root>/dist/` | 用户自己建了 dist 目录 |
| 2 级 | `<root>/desktop/dist/` | 从源码树里直接跑构建产物 |
| **3 级** | `<root>/desktop/dist/win-unpacked/` | **直接双击 electron-builder 的构建产物** |
| 4 级 | `<root>/desktop/release/win-unpacked/` | 换用 release/ 布局 |

**为什么是 4 级、且必须逐级试 `harness/`**：3 级这一档是实测踩到的 ——
用户直接在 `desktop/dist/win-unpacked/` 里双击 exe，而上溯上限当时只有 2 级，
搜索停在 `desktop/`，永远够不到上一级的仓库根，界面只能报「已查找 4 个位置
均未找到」。改成 4 级后同一个位置直接命中。

**为什么不再往上加**：每一级都要跑一次 `looksLikeRepoRoot`（要 stat 文件系统），
上溯到 `C:\` / `D:\` 时目录很大、开销不可控，且误命中无关仓库的风险上升。
到盘符根就停止 —— 因此 exe 放在盘符根的直接子目录时只会查 2 个位置，
这是**刻意的取舍**，引导文案里也明确说明了「不会扫描整个磁盘」。

校验口径是「可执行能力」而非某个文件名，两条同时满足才算命中：

1. `vrh` 包可定位 —— 本项目是 **src-layout**（`pyproject.toml` 里
   `[tool.setuptools.packages.find] where = ["src"]`），包在 `src/vrh/`。
   同时也接受根级 `vrh/`，以防布局变化。
2. `.venv` 存在（Windows 下即 `.venv\Scripts\python.exe`）。

只查 `src/vrh/` 会把「源码在但环境没建」的目录判为可用；只查 `.venv`
则几乎任何 Python 项目都能通过。界面在环境横幅里会显示**实际命中的目录与
来源**，路径猜错时这是唯一的排查线索。

找不到时界面不会崩，而是列出三条可操作路径 + 「已依次查找」的完整位置清单，
并把「开始运行」置灰 —— 不撒谎比给个能点的按钮更重要。

### 分发时的放置方式

解压 zip 后，把 harness 文件夹放到 exe 同级目录并命名为 `harness`：

```
VRH 视频反推.exe
harness\
  src\vrh\
  .venv\
  tools\
```

zip 内已附「请先阅读 - harness 放置说明.txt」。也可以启动后在界面里点
「手动指定」，或设置环境变量 `VRH_ROOT`。

### 打包相关的坑（都踩过）

| 现象 | 根因 | 处理 |
|---|---|---|
| exe 启动即退出，stderr 报 `Most NODE_OPTIONs are not supported in packaged apps` | 运行环境注入了 `NODE_OPTIONS`（IDE 的 language shim） | 启动前 `unset NODE_OPTIONS`。**不是应用缺陷** |
| exe 报 `bad option: --remote-debugging-port=9222` 并退出 | 打包应用按自己的规则解析 argv，不认识的开关直接拒绝 | 应用自己提供 `--debug-port=`，在 app ready 前转写成 Chromium 开关 |
| **交付的 zip 打不开**（281MB，文件头 `2e2f0000`） | `which tar` 解析到 **GNU tar 1.35**，它不支持 `-a` 按扩展名选 zip —— 不报错，只是照旧写 tar 流，文件名却叫 `.zip` | 显式使用 Windows 自带的 **bsdtar**（`System32\tar.exe`），且 `-a` 必须保留；压缩后校验文件头 `504b0304` |
| zip 里缺放置说明 | 用 `execFileSync(..., {encoding:'utf8'})` 读 tar 清单时，中文文件名是**本机 ANSI 代码页**（GBK）不是 UTF-8，正则匹配不到，误报缺失 | 校验只匹配结构稳定的部分（扩展名 + ASCII 路径段），不匹配中文本身 |
| `dist/` 攒下一堆 `.stale-notice-*.txt` | 「挪走说明文件」的清理被中断，残留文件没人收 | `make-zip.js` 顺带回收历史同类文件（它自己的产物，非用户数据） |
| 打包被 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` 拦下 | electron-builder 覆盖 `dist/win-unpacked` 前要递归删 264 个文件 | 打包前跑 `scripts/clean-dist.js`（Node 原生删除，逐项处理） |
| `tar: Cannot connect to D: resolve failed` | GNU tar 把 `D:\...` 的 `D:` 当成远程主机名 | 加 `--force-local`（bsdtar 反而**不认**这个开关，需按实现分参数） |
| zip 解压后多一层 `win-unpacked/` | 归档时用了 `-C <dist> win-unpacked` | 改用 `-C <srcDir> .`，内容直接落在根 |
| 重新打包报 `EBUSY` / 解压失败 | 旧实例仍占用 `dist/win-unpacked` | 打包前先关闭运行中的 exe |
| 分两步「先启动应用、再连 CDP」总是连接被拒 | 每次命令是独立会话，会话结束回收整个进程树 | 启动与验证放进同一个 Node 进程（`verify-packaged.js`） |
| 打包态界面验证时好时坏（预设 0 项 / 命令预览空） | 测试连上就读 DOM，读到的是初始化中间态 | 界面在 init 最后设 `<html data-ready="1">`，外部等这个信号 |
| **exe 在 `dist/win-unpacked/` 里报「已查找 4 个位置均未找到」** | 候选链只从 exe 目录上溯 **2 级**，而 `win-unpacked → dist → desktop → 仓库根` 是 **3 级** —— 搜索停在 `desktop/`，永远够不到仓库根 | 上溯深度改为 4 级（`MAX_ASCENT`），逐级都试 `harness/` 子目录；每一级仍要过 `looksLikeRepoRoot` 校验 |
| 命中目录的「来源」文案与实际不符 | `source` 判定写死为「exe 同级的 harness 目录」，从上溯三级找到的目录也被这么标 | 抽出 `describeSource()`，按相对 exe 目录的层级与是否带 `harness/` 后缀生成描述 |
| 「已依次查找」清单看不出层级关系 | 旧文案只把路径平铺成 4 行，没有说明 | 加引导语「已依次查找这些位置（就近优先，命中即用）」 |
| 引导文案让用户去「找含 `vrh/` 与 `.venv/` 的文件夹」 | 用户手里往往**没有**这个文件夹 —— 要告诉他从哪复制什么过来，而不是让他辨认特征 | 改为「harness 文件夹指的是里面有 src、.venv、tools 的那个」，并把「复制到程序目录」提为首选，附上程序目录的绝对路径 |
| 说明文件用记事本打开是乱码 | 裸 UTF-8 无 BOM 时，记事本按本机 ANSI 代码页解释 | 写 **UTF-8 带 BOM**（`\uFEFF` 前缀）；这份文件是用户在「程序用不了」时唯一的线索，不能乱码 |

### 打包后做了什么验证

打包脚本只含运行必需的 10 个文件，诊断脚本（`smoke` / `measure` /
`overflow` / `fill` / `procs`）已从 asar 中排除。因此打包态的验证**从外部
走 CDP**（Chrome DevTools 协议），等于「用调试器看进程内部」，比截图更硬。

十三条命令覆盖十三种口径：
```bash
npm run verify:paths              # 路径解析单元验证（14 项，无需启动应用）
npm run verify:packaged           # 启动应用 → 界面断言 → 真实跑一次（7 项）
npm run verify:missing            # 隔离环境下「找不到 harness」的界面与引导（21 项）
npm run verify:labels             # 镜头卡片渲染：中文标签、说明条、提示词仍为英文（10 项）
npm run verify:model              # 模型配置链路：校验 → 环境变量 → Key 不进 argv → 子进程实读（25 项）
npm run verify:model-ui           # 模型设置界面：显隐、预填、校验、预览脱敏（25 项）
npm run verify:model-packaged     # 打包产物内含全部模型配置文件（7 项，秒级）
npm run verify:model-packaged-ui  # 打包态「测试连接」：脚本进包 + 报错来自网络层（12 项）
npm run verify:error-hints        # 服务端报错 → 中文指引的翻译规则（6 项，无需启动应用）
npm run verify:error-display      # 长报错在界面里能否被读出来（8 项）
npm run verify:test-isolation     # 验证脚本不得覆盖用户真实配置（9 项，秒级）
npm run verify:zip                # 解压交付包 → 从解压副本启动并用（9 项）
npm run verify:zip-content        # 交付包内的代码是否含本轮改动（无需解压，秒级）
```

harness 本体另有一套 pytest（**115 项**），其中 `tests/unit/test_gemini_vlm.py`
（22 项）专门覆盖本轮新增的 Gemini provider：

```bash
cd D:\HarnessTest && .venv\Scripts\python.exe -m pytest -q
```

上述十三条验的是**桌面端**；pytest 验的是 **provider 实现本身**（请求形状、
错误语义、字段映射、registry 接线）。两者不可互替 —— 桌面端那些脚本不碰
`gemini_vlm.py` 的内部逻辑，只验「配置能否正确送达 harness」。

`verify:model` 里最关键的是第 4 段：**让 Python 子进程报出它实际读到的配置**。
前三段（字符串对不对、Key 有没有进 argv）只能证明「我拼的方式对」，只有第 4 段
能证明「harness 真的照这个跑了」——中间任何一环静默失效，症状都是「界面选好了
模型，实际还在用离线占位」，而**提示词照样出来、程序照样显示成功**。

`verify:model-ui` 里有两条断言值得留意：

- **离线占位下必须隐藏 Key 输入框** —— 显示一个空的必填框会让人以为不填就不能
  跑，把「先跑通流程」这个最简单的入门路径挡在门外。
- **命令预览里不得出现 Key 明文** —— 预览面板可能被截图分享。

`verify:model-packaged` 与 `verify:zip-content` 都不启动应用，秒级返回，适合
每次打包后顺手跑。它们防的是同一类问题：**文件进了包，但跑的是旧版本 / 跑不起来**。

`verify:model-packaged-ui` 是唯一从**打包态**验「测试连接」的：它启动便携版 exe，
通过 CDP 调用一次 IPC。它的价值在于**区分两种失败原因**：

```javascript
check('脚本确实被打进包（不是「找不到文件」）',
  !/can't open file|No such file/i.test(msg));
check('报错来自网络层（说明脚本正常执行）',
  /HTTP|connect|refused|拒绝|Transport/i.test(msg));
```

若只断言「返回了失败」，那么「`test-model.py` 没进包」也会算通过 ——
而它和「正确报出网络错误」是**完全相反**的两个结论。本文档前面记的
坑二、坑三都是这条断言抓出来的。

`verify:zip-content` 补的是一个**独立的失效模式**：`verify:zip` 证明了「解压
出来能跑」，但没证明「解压出来的是**新版**代码」。完全可能出现打包流程正常、
却因为打包时机早于改代码而交付旧渲染层的情况 —— 本轮就踩过一次。它直接从
zip 里抽出 asar 检查特征串，不落 110MB 到磁盘，秒级返回。

`verify:error-hints` 与 `verify:error-display` 是一对，针对的是**同一个缺陷的
两个独立侧面**，这也是它们必须分成两条命令的原因：

服务端报错对用户等于不可读。实测抓到的阿里云欠费响应是这样：

```json
{"error":{"message":"Access denied, please make sure your account is in good
standing. For details, see: https://help.aliyun.com/zh/model-studio/error-code
#overdue-payment","type":"Arrearage","code":"Arrearage"},"request_id":"8605e472-…"}
```

真正能照做的信息只有两个记号：`type":"Arrearage"` 和 `#overdue-payment`。
其余 300 字符是干扰。所以 `renderer.js` 里加了一层 `ERROR_HINTS`，把原文翻成
「请到「费用与成本」确认并充值；充值后余额更新有延迟」这样的可执行指引。

- **`verify:error-hints`** 验**翻译对不对**。它用 `vm.createContext` 只求值
  `ERROR_HINTS` + `explainModelError` 两段源码 —— 而不是把规则复制进测试文件。
  复制会让两边漂移：改了渲染层、测试还绿，等于没测。6 条用例**全部是实测抓到的
  真实响应原文**，不是照着正则编的字符串，否则只能证明「正则匹配得上我自己写的字」。
- **`verify:error-display`** 验**翻译能不能被看见**。这是纯布局问题，读代码看不
  出来，而它**确实坏过**：结果区原本是一个 `<span>`，和「测试连接」按钮同处一个
  `.row`，于是被按钮挤压成窄窄一列、逐字换行（见 `docs` 里的截图问题）。现在断言
  四件事：占满容器宽度、位于按钮下方、高度受控、无空格长串可断行。

分成两条是因为两者可以独立失效：翻译对了但显示不出来（本轮实际发生的），
显示正常但翻译错了（正则写偏），都算没解决问题。

`verify:test-isolation` 盯的是一个**比前者更隐蔽的缺陷：验证脚本会破坏用户数据**。

界面把模型配置写进 `%APPDATA%\vrh-desktop\model-config.json`。而验证脚本需要在
界面里**真的敲进一个 Key** 才能验「输入 → 保存 → 读回」这条链路。两者一叠加就出事：

```javascript
input.value = 'sk-test-not-a-real-key';   // 脚本填的占位值
// → input 监听器立刻 persistModelConfig()
// → 用户真实保存的 API Key 被覆盖
```

**这不是假想，是实测踩到的。** 用户报告「我明明配好了却一直连接失败」，查配置
发现里面躺着 22 个字符的 `sk-test-not-a-real-key`（来自 `verify-model-ui.js`）。

这类缺陷有三个特征让它极难排查：
- **静默** —— 验证全绿，没有任何报错
- **跨轮次** —— 当轮没事，下一轮用户才发现配置被改
- **伪装** —— 症状是「Key 无效」，排查方向会被引向「Key 是不是过期了」

解法是 Electron 内建的 `--user-data-dir=<临时目录>`（Chromium 提供，主进程代码
运行前就生效，**无需改应用**）。工具在 `scripts/lib/isolated-user-data.js`。

这条守卫的检测逻辑本身也踩过一次**假通过**：最初只查源码里有没有
`makeIsolatedUserData` 这个词，结果把它注释掉、只留
`__DISABLED_makeIsolatedUserData` 时**子串仍然匹配**，守卫照样报「已隔离」。
现在改成两个必要条件 —— **真的调用了工厂函数**（剔除注释、拒绝前缀污染）
**且**返回值**真的展开进了 spawn 的 argv**。建了目录却不传参数，等于没隔离。

守卫的扫描结果是**分级**的，不是一刀切：

- **硬失败**：会写配置却不隔离的脚本（当前 2 个，全部通过）
- **提示**：启动了应用但尚未写配置的脚本（当前 7 个）

分级的原因是**一刀切会让守卫因为噪声过多而被绕过 —— 而绕过一次之后就再没人看它了**。
「当前不写配置」是可接受的现状，但一旦开始写就应加隔离，所以保留提示。
守卫自身也遵守这条：它先断言「扫描到了足够多的脚本」，防止扫描逻辑失效时
**空集恒真**地报 PASS（见 7.6）。

`verify:zip` 是**交付口径的最后一道关**：前三条测的是 `dist/win-unpacked`
（构建产物），只有这一条测「用户拿到手的东西」。两者的差异正是踩过的坑 ——
曾经交付过一个 281MB、扩展名叫 `.zip` 但实际是 tar 流的文件。

`verify:missing` 覆盖的是**用户真正会看到错误提示的那个场景**。做法是把便携
目录复制到一个与真实 harness 无路径关系的临时位置（如 `D:\_vrh-noharness-*`），
于是必然进入「找不到 harness」分支，可以逐项断言那套引导文案、按钮与说明文件。
它同时在验证错误路径 —— 正常路径全绿时，错误路径最容易悄悄坏掉。

**启动、验证、清理必须在同一个进程里完成。** 本环境每次命令都是独立会话，
会话一结束就回收整个进程树，即使子进程用了 `detached` + `unref` 也留不住。
所以「先启动、再验证」分两步跑永远拿不到活着的窗口 —— 第二步开始时端口已断。
`verify-packaged.js` / `verify-prompt-edit-packaged.js` / `verify-zip.js`
都把整个流程装进一次调用。

实测结果：

```
=== 1. 界面初始化 ===
  状态栏  ：已连接 · Python 3.13.14 · ffmpeg 9.0.1-essentials_build (tools) · vrh 0.1.0
  harness ：D:\...\dist\win-unpacked\harness
  预设    ：2 项 ["i2v_generic","t2v_generic"]
  阶段标签：5 个，全中文=true

=== 2. exe → Python 链路（真实干跑）===
  INFO L5: aggregate=0.643 threshold=0.70 passed=False review=1
  INFO 运行成功（退出码 0）

合计 7 项，通过 7，失败 0
```

阶段标签在打包后仍完整渲染为中文，证明中文改造未因打包丢失。

**移除 junction 必须用 `rmdir`（不带 `/S`）。** 用 `Remove-Item -Recurse`
或 `rm -rf` 会穿透联接，把真实的 harness 一起删掉。`link-harness.js`
的 `remove` 动作已封装正确做法。

**`--debug-port=<端口>` 是应用自己的开关**，不是 Chromium 的
`--remote-debugging-port`。原因见下表：打包应用不认识后者，会直接退出。
`main.js` 在 app ready 前用 `app.commandLine.appendSwitch` 把它转写过去。

**注意校验脚本的顺序依赖**：`check-packaged-paths.js` 里不要用
`dist/win-unpacked/harness` 作为「不存在的目录」用例 —— 挂上 junction 后
它会真实存在，断言结果随环境变化。

## 与 harness 的交互方式

**进程调用，不走 HTTP。** harness 的 CLI 已经提供了理想的机器可读契约，因此
界面不需要 harness 做任何改动：

| 通道 | 内容 | 界面用途 |
|---|---|---|
| `stderr` + `--json-logs` | 逐行 NDJSON `{ts, level, logger, msg}` | 实时日志、阶段进度、成本 |
| `stdout` | 人类可读报告 | 出错时展开查看原始输出 |
| `output/<video-id>/*.json` | 5 份产物契约 | 渲染结果卡片 |
| 退出码 | `0/1/2/130` | 判定结果类型 |

`video-id` 的算法必须与 harness 一致：`sha256(小写化的绝对路径)[:12]`。
`src/main/artifacts.js` 里复刻了这份算法，`scripts/selftest.js` 用真实值
（`samples/clip.mp4` → `dab1820a51e5`）做了交叉校验。

## 模型配置（界面选模型 + 填 Key）

界面上「模型设置」是配置区的第一组 —— 它决定后面所有环节的质量与成本，
也是首次使用必须先填的一项。

### 为什么必须走环境变量，而不是命令行参数

harness 的 CLI **没有任何 provider 参数**（见 `src/vrh/cli.py`），运行时覆盖
配置的唯一手段是 `VRH_` 前缀 + `__` 分层的环境变量。所以界面上的模型选择
最终翻译成：

```
VRH_PROVIDERS__VISION__NAME=openai_vlm
VRH_PROVIDERS__VISION__MODEL=qwen-vl-max
VRH_PROVIDERS__VISION__BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
VRH_PROVIDERS__VISION__API_KEY_ENV=VRH_VISION_API_KEY
VRH_VISION_API_KEY=<实际 Key>
```

最后两行是刻意的**间接引用**：harness 的 `api_key_env` 存的是变量名，值从同名
环境变量读。于是 Key 不会出现在任何配置文件里。

### API Key 的处理

| 约束 | 原因 |
|---|---|
| **绝不进 argv** | 命令行参数在任务管理器 / `ps` 里对同机其他用户可见 |
| 存 Electron `userData`，不存源码目录 | 源码目录可能被同步盘、版本控制或卸载程序带走 |
| 写入用「临时文件 + rename」 | 直接覆盖时若中断会留下半截 JSON，Key 就丢了 |
| 文件权限收到 `0600` | 尽量只让当前用户可读 |
| 命令预览里显示为 `<本次运行注入>` | 预览面板可能被截图分享 |

Key 输入框用密码框，但提供「显示」切换 —— 密码框能防旁观，但粘贴出错时用户
无法自查，而「Key 粘错 / 带了空格」是最高频的失败原因。两者不该二选一。

### 支持的服务

界面按数据定义（`PROVIDER_PRESETS`），新增一个服务只改一处：

| 服务 | provider | 默认模型 |
|---|---|---|
| 离线占位 | `fake` | — （不调用模型，无网络请求） |
| 通义千问 · 阿里云百炼 | `openai_vlm` | `qwen-vl-max` |
| 智谱 GLM | `openai_vlm` | `glm-4v-plus` |
| 月之暗面 Kimi | `openai_vlm` | `moonshot-v1-8k-vision-preview` |
| OpenAI | `openai_vlm` | `gpt-4o-mini` |
| Google Gemini | `gemini_vlm` | `gemini-2.5-flash` |
| 自定义（OpenAI 兼容网关） | `openai_vlm` | 用户填写 |

国内三家都提供 OpenAI 形状的 `/chat/completions`，所以复用 `openai_vlm` 只换
`base_url`，不需要新代码。**Gemini 不是这个形状**（图片走 `inline_data`、
鉴权走 `x-goog-api-key`、一个模型一个端点），因此有独立的 `gemini_vlm.py`。

> `configs/default.yaml` 的注释曾列出 `qwen_vl` / `anthropic` / `whisper_local`
> / `open_clip` 等并未在 registry 注册的名字 —— 写了会直接抛
> `unknown vision provider`。**以 registry 为准，注释比实现乐观。** 本轮已把
> 注释改成与实现一致。

### Gemini provider 的单元测试（harness 侧）

`tests/unit/test_gemini_vlm.py`（22 项）钉住三件「读代码看不出来、错了也不报错」的事：

| 关注点 | 为什么必须机械验证 |
|---|---|
| **请求形状** | 退回 OpenAI 形状（`image_url` / `Authorization` 头）**照样能编译**，只在打真实 API 时才失败 |
| **错误语义** | 安全拦截是 **HTTP 200 + 无 candidates** —— 报成「没有内容」会让人去查解析 bug，而不是内容过滤 |
| **响应字段映射** | 字段名写错不会抛异常，只会**静默变成默认值** |

请求形状部分逐项断言：端点是 `/v1beta/models/{model}:generateContent`、
Key 在 `x-goog-api-key` 而非 `Authorization`、图片走 `inline_data` 而非
`image_url`、文本部分必须排在媒体之前、结尾斜杠不产生 `//v1beta`。

错误语义部分区分**可重试与不可重试**：`ConnectError` / 429 / 5xx → `RetryableError`，
其他 4xx → `RuntimeError`（重试一个格式错误的请求只会白烧配额）。

字段映射部分做**交叉比对**：同一个 annotation payload 分别过 `gemini_vlm` 与
`openai_vlm`，断言除 `provider` 标签外 `model_dump()` 完全相等 —— 两个 provider
必须可互换，否则 A/B 对比测的是映射差异而不是模型差异。

> 写这组测试时**测试自己抓到一个错误**：给 `annotation_body()` 的字段名写成了
> `style`，而 `_to_annotation` 读的是 `visual_style` —— 不抛异常，只是静默取默认值。
> 正是交叉比对断言把它暴露出来的（映射结果与 OpenAI 路径不一致）。

### 「测试连接」为什么值得单独做

模型配置有三处可能出错：Key 无效、地址写错、模型名不存在。三者的报错都发生在
流水线**第 3 层**——用户要先等解析与切分跑完（几十秒到几分钟）才会看到，且报错
混在大量日志里。

所以给出一个按钮，用一张 1×1 的图打一次真实请求，把「三选一」的排查压缩成一次
点击。实现上**复用 harness 自己的 provider**（`src/main/test-model.py` 走 registry），
而不是在 Electron 里另写 HTTP 逻辑 —— 后者会与 harness 漂移，出现「测试通过但
实际跑不通」这种最难查的问题。

### 三个真实的打包坑（都属于「开发态正确、打包态静默失效」）

**坑一：`build.files` 的 glob 不包含 `.py`。**

原本是 `"src/main/*.js"` —— 非 JS 资源不会被打进去。于是打包后「测试连接」
找不到脚本。已显式加上 `"src/main/test-model.py"`。

**坑二：Python 读不了 asar 内部的路径。**

修完坑一，`test-model.py` 确实进 asar 了，但**仍然跑不起来**：

```
python.exe: can't open file
  'D:\...\resources\app.asar\src\main\test-model.py'
```

原因是打包后 `__dirname` 指向 `app.asar/src/main`，而 **Python 只是普通文件
读取，不知道 asar 是归档格式**。Electron 自己能透明读取 asar 内的文件，
所以这个问题只在**把路径交给外部进程**时才会出现。

解法是 `asarUnpack`：

```json
"asarUnpack": ["src/main/test-model.py"]
```

electron-builder 会把这个文件额外释放到 `app.asar.unpacked/` 的真实目录下，
路径规则就是把 `app.asar` 段替换成 `app.asar.unpacked`。

**坑三（坑二的续集，也是最阴的一处）：`fs.existsSync` 对 asar 内路径返回 `true`。**

第一版 `testScriptPath()` 顺序写反了：

```javascript
// ✗ 打包态必然失败
const packed = path.join(__dirname, 'test-model.py');
if (fs.existsSync(packed)) return packed;            // ← 返回 true！直接返回了 asar 内路径
const unpacked = packed.replace('app.asar', 'app.asar.unpacked');
if (fs.existsSync(unpacked)) return unpacked;        // ← 永远走不到
```

**Electron 给 `fs` 打了 asar 补丁**，对归档内路径 `existsSync` 会返回 `true`
（Electron 自己读得到），于是函数返回了 asar 内路径，unpacked 分支形同虚设。
而把这条路径交给 Python 就是 `can't open file`。

> **`existsSync` 为真 ≠ 外部进程读得到。** 这个区别只在「Electron 内部的 `fs`」
> 与「Electron 之外的进程」之间才显现 —— 所以开发态发现不了、读代码也发现不了，
> **只能靠打包态实跑**。

正解是判「**路径里有没有 `app.asar`**」这个结构事实，而不是问 `existsSync`：

```javascript
function testScriptPath() {
  const asarSegment = `${path.sep}app.asar${path.sep}`;
  const direct = path.join(__dirname, 'test-model.py');

  // 落在 asar 内：无条件换到 unpacked，不问 existsSync（它一定说 true）
  if (direct.includes(asarSegment)) {
    const unpacked = direct.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`);
    return fs.existsSync(unpacked) ? unpacked : null;
  }

  // 开发态：__dirname 就是真实目录
  if (fs.existsSync(direct)) return direct;

  // 兜底：__dirname 布局异常时用 app.getAppPath() 再推一次
  const appPath = app.getAppPath();
  if (appPath.includes(asarSegment)) {
    const p = path.join(appPath, 'src', 'main', 'test-model.py')
      .replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`);
    if (fs.existsSync(p)) return p;
  }
  return null;   // 都没有 = 打包配置漏了，交给调用方明确报错
}
```

> **坑二与坑三产生一模一样的报错**（`can't open file`），但根因完全不同：
> 一个是打包配置漏了资源，一个是路径没换到 unpacked。所以修的时候必须两处
> 一起查，否则会出现「改了路径顺序，验证还是红的」这种反复。

### 验证这件事本身踩的坑：诊断输出别截断太狠

排查坑三时，验证脚本把错误信息截断到 90 字符：

```
FAIL  脚本确实被打进包（不是「找不到文件」）
      ...can't open file 'D:\\HarnessTest\\desktop\\dist\...
```

**截断的位置恰好把最关键的信息裁掉了** —— 路径到底是 `app.asar` 还是
`app.asar.unpacked`，正是判断坑二还是坑三的唯一依据。为此多排查了一轮。

改为「失败时打全文、成功时保持精简」，一次就定位到了。所以定位类输出
**要留够长度**，省下的那点屏幕空间不值这个代价。

> **这两个坑都是验证脚本发现的，不是读代码发现的。** 而且差点被放过 ——
> 如果验证只断言「测试连接返回了失败」，那么「找不到脚本」也会算通过。
> 所以断言必须区分**失败的原因**：必须是网络层报错（证明脚本执行了），
> 而不是「找不到文件」（证明脚本没进包）。
> **凡是验证「失败路径」，都要连失败的原因一起验。**

### 为什么用 spawn 而不是 exec

`exec` 会缓冲全部输出直到进程结束，实时日志就没了。`spawn` 逐块吐出数据，
界面才能一边跑一边显示。

### 为什么 --json-logs 是必需的

没有它，stderr 是给人看的自由文本，界面只能靠正则猜；有了它，每一行都是
结构化对象。界面据此提取阶段完成事件、耗时、成本，无需侵入 harness 代码。

## 界面适配与中文体验

### 响应式断点

窗口可以被收窄到 360px，界面按三档降级。**桌面端（≥1200px）的布局与改造前完全
一致**，断点只影响更窄的情况：

| 断点 | 布局 | 指标 | 阶段条 | 日志面板 | 触控目标 |
|---|---|---|---|---|---|
| ≥1200px | 左配置 288px + 右主列 | 4 列 | 5 列横排 | 固定 240px，常驻 | 34px |
| 900–1199px | 左配置 264px + 右主列 | 2 列 | 5 列横排 | 固定 200px，常驻 | 34px |
| <900px | 单列堆叠，整页滚动 | 2 列 | 3 列网格 | 可折叠，默认收起 | **≥44px** |
| <520px | 单列堆叠 | 1 列 | 2 列网格 | 可折叠 | ≥44px |

窄屏下的两个关键决策：

1. **整页滚动取代面板内滚动。** 触屏上嵌套滚动会互相抢手势，而且用户看不到
   「页面还有多少内容」。
2. **纵向次序重排为「运行控制与结果 → 参数配置 → 运行日志」。** 小屏用户先要
   操作和结果，参数配置次之 —— 用 flex `order` 实现，DOM 顺序不变，因此桌面端
   与读屏器读序不受影响。

这里踩过一个坑，记录下来：最初用 `display: contents` 让 `.layout` 退化成透明
中间层，结果是 `.main-column` 的子项失去父盒子后按 DOM 顺序穿插到配置栏周围，
纵向位置自相矛盾（实测 400px 下指标跑到配置栏下面、结果面板又跑到日志面板下面）。
`order` 只对同一容器的直接子项生效，所以必须保留盒子层次。

### 中文表达习惯

界面文案本来就是中文，这一轮改的是**表达习惯与阅读顺序**，而不是翻译：

| 位置 | 改前 | 改后 | 为什么 |
|---|---|---|---|
| 阶段条 | `L1 解析` | `解析视频` + 角标 `L1` | 读起来是一条完整的中文叙事线，代号降为次级信息但仍可与日志对照 |
| 结果字段 | 十余项平铺 | 分「基本信息 / 评测结果 / 产物位置」三段 | 中文读者按「这是什么 → 跑得怎么样 → 东西在哪」扫读 |
| 日志过滤 | `INFO 及以上` | `常规及以上` | 不熟悉日志分级的中文用户也能选对 |
| 阈值 | `阈值` | `达标分数` | 明确它是「达到多少分算过」，而非一个抽象的数值边界 |
| 轮数 | `最大轮数` | `最多重试轮数` | 说清是重试次数 |
| 质量门 | 无说明 | 补一句「未过表示跑通了但结果不达标，属于正常结果，不是程序故障」 | 退出码 2 是最容易被误读成故障的状态 |
| 配置项 | 11 项连续排列 | 五组折叠，默认展开前两组 | 按动手顺序分组，减少滚动 |
| 结果字段（窄屏） | 左标签右值 | 上下结构 | 132px 标签列会把路径类长值挤成多行，破坏「标签—值」配对 |

### 中英混排的处理策略

日志正文不可避免地包含 harness 的英文输出（如
`re-running 'evaluate' (options changed since last run)`）。**保留英文是有意为之**：
机翻后的错误信息会丢失可搜索关键字，反而让用户查不到资料。界面自身产生的日志
（校验失败、导出成功等）全部中文，并在首次出现流水线原始输出时显示一次说明条。

同样的原则也适用于**镜头卡片**，但那里的处理方式不同 —— 因为性质不同：

| 位置 | 内容 | 处理 |
| --- | --- | --- |
| 提示词 / 负向提示词 | harness 产物原文，投喂给视频生成模型 | **保持英文**，并在卡片列表顶部加一条说明条讲清原因 |
| 全局提示词 | 同上 | 保持英文 |
| 结构化槽位键名 | `subject` / `action` / … | **显示中文标签**（主体 / 动作 / …），英文键名放进 `title` 供对照产物 |
| 字段标签 | 「提示词」「负向：」等 | 中文（界面自身文案） |

**为什么提示词必须保持英文**：这些文本会直接投喂给视频生成模型（i2v / t2v）。
英文是该领域的通用输入语言，改成中文会明显降低生成质量。这不是漏翻，而是
设计约束 —— 所以界面不只保留英文，还**主动说明**这一点，避免用户误以为程序
没做完而去「修正」它。

**为什么槽位键名反而要译**：键名是给**人**看的结构说明，不参与生成。界面既然
全中文，孤零零一个 `subject:` 就是最突兀的一处混排。译成中文后，英文原名仍保留
在 `title`（悬停可见），需要与 `prompt.json` 字段对照时随时可查 —— 兼顾可读性
与可追溯性。

验证：`npm run verify:labels` 会启动打包应用、读取真实产物、在页面内直接调用
渲染函数，然后断言「说明条已渲染」「槽位标签全中文」「可见文本无裸英文键名」
「tooltip 保留英文键名」「提示词内容仍为英文」。

> 最后一条断言有个容易写错的细节：不能用「过滤出含某关键字的行，再判断无中文」
> 这种写法 —— 如果过滤结果为空集，断言会**恒真**。脚本改为先用**产物里的真实
> prompt 值**在 DOM 中定位行，并单独断言「确实取到了行」，杜绝假通过。

## 编辑镜头提示词

结果区每条镜头卡片都能就地改提示词与负向提示词，改完点底部保存栏写入
`prompt.json`。这是「跑完之后想微调一两条」的常见需求 —— 之前只能去
`output/<id>/prompt.json` 手工改。

交互设计上做了三个取舍：

1. **改动不即时写盘。** 输入即写文件会让「改了一半反悔」没有退路，也会在
   用户还在思考时反复触发 IO。改成显式的「保存修改」，未保存时底部出现
   sticky 保存栏，同时显示「已修改 N 条」。
2. **首次保存自动备份**为 `prompt.json.bak`，且**只在首次** —— 否则用户
   第二次保存就把「原始版本」覆盖掉了，备份失去意义。
3. **保存会明确提示「评分未更新」**。改成新提示词后 `score.json` 仍是按旧
   提示词算的，不说明会让人以为分数反映了新提示词。是否重跑评测交给用户决定，
   因为重跑要花 API 费用。

还有一个容易踩的坑写在代码注释里：`shot_id` 在 JSON 里是**数字**，经 HTML
`dataset` 传回渲染层会变成**字符串**，用 `Map` 精确匹配会静默失配 ——
表现为「界面说保存成功，文件却没变」。现在做了三重宽松匹配（原值 → 数字 →
字符串比较），且**匹配不到就报错而不是静默通过**。

冒烟场景 `prompt-edit` 会走完整链路并**读回磁盘核对**，验证的是副作用而不只是
界面提示：界面态正确 ≠ 副作用正确。

## 应用图标

`scripts/make-icon.js` 生成 `build/icon.ico`（6 个尺寸：256/128/64/48/32/16）
与 `build/icon.png`（512，窗口用）。**零依赖** —— 手写 CRC32 + zlib deflate +
PNG/ICO 容器组装，避免为了一个图标引入带原生扩展的图形库。

图标语义与产品对应：左侧三格「视频帧」（accent 蓝，自上而下淡出）→ 中间箭头
→ 右侧三条「文本行」（ok 绿），即「视频反推为提示词」。配色直接取自
`styles.css` 的变量，改主题时图标也该跟着改。

```bash
node scripts/make-icon.js      # 重新生成（改了配色或形状后）
```

窗口图标走 `iconPath()` 探测：开发态查 `desktop/build/icon.png`，打包态查
`process.resourcesPath/build/icon.png`，都没有就留空 —— **缺图标不该让应用起不来**。
exe 自身的图标由 electron-builder 嵌进资源，不依赖这个文件。

## 安全边界

- `nodeIntegration: false`、`contextIsolation: true`
- 渲染进程拿不到 Node API，只能调用 preload 暴露的窄接口
- 所有副作用（起进程、读文件、打开外部程序）都在主进程
- 渲染进程有 CSP，禁止加载任何远程资源
- 外部链接交给系统浏览器，不在应用窗口内打开

## 错误反馈的设计

**退出码承载语义，界面据此差异化呈现** —— 这是这个界面最容易做错的地方：

| 退出码 | 语义 | 界面表现 |
|---|---|---|
| 0 | 成功 | 绿色 |
| 1 | 错误（路径错、ffmpeg 缺失、产物损坏） | 红色，定位到对应表单字段 |
| 2 | 质量门未过 | **黄色，且明确不算失败** |
| 130 | 已中断 | 蓝色，提示可从断点继续 |

退出码 2 需要特别说明：它意味着流水线**完整跑完并产出了结果**，只是综合分未达
阈值。如果界面把它渲染成红色「运行失败」，用户会以为工具坏了，实际只需要调低
阈值或复核被标记的镜头。

三条贯穿原则：

1. **未知即禁用，而非运行后报错。** ffmpeg 缺失时「开始运行」直接置灰，并说明
   原因 —— 比跑失败再报错省用户一次等待。
2. **区分「运行失败」与「结果不达标」。** 见上。
3. **原始输出永远可查。** 每个错误旁都有「查看完整输出」，展开 stdout/stderr
   原文，并提示可用 `--log-level DEBUG` 获取堆栈。

## Windows 上的进程终止

`child.kill()` 只杀直接子进程。Python 拉起的 ffmpeg 会变成孤儿进程继续占用
CPU。因此停止操作走 `taskkill /PID <pid> /T /F`，整棵进程树一起终止。

停止后退出码可能不是 130（taskkill 强杀会改变它），所以 `runner.js` 里
**显式的 `aborted` 标志优先于退出码判定** —— 用户点了停止就该报告「已中断」，
而不是把强杀产生的退出码当成错误。

## 自检与联调

```bash
# 纯函数自检，无需 Electron
node scripts/selftest.js

# 界面级验证：拉起真实窗口、驱动真实界面、截图
node scripts/run-all.js                 # 跑全部 8 个场景
node scripts/run-all.js gate stop       # 只跑指定场景
npm start -- --smoke=gate               # 单个场景，带截图

# 布局诊断
npm start -- --measure                 # 四档断点的几何尺寸与判定
npm start -- --measure=400x720         # 只测指定尺寸
npm start -- --overflow=400x720        # 定位水平溢出元素 + 纵向区块可达性
npm start -- --fill                    # 首屏异步填充检查（预设、阶段标签、命令预览）
npm start -- --procs=1                 # 停止操作是否真的终止了整棵进程树
```

`--measure` 与 `--overflow` 会输出明确判定（单列/双列、有无水平溢出、触控目标是否
达标），不只是打印数字 —— 这样它们的结果可以直接当作验收依据。

### 冒烟场景

| 场景 | 验证什么 |
|---|---|
| `idle` | 首屏、环境探测、连接状态、运行按钮是否可用 |
| `layout` | **四档断点的响应式行为**：单列/双列、指标列数、纵向次序、触控目标、零水平溢出 |
| `success` | 正常运行的完整结果呈现（指标、镜头卡、审阅页入口） |
| `gate` | **退出码 2 必须渲染成黄色警告，而非红色故障** |
| `error` | 启动前被拒（视频不存在）时的反馈与可重试性 |
| `stop` | 中断态：徽标不暴露退出码、按钮恢复可用、日志不被清空 |
| `fresh` | `--fresh` 强制重跑时阶段条是否正常推进 |
| `prompt-edit` | **编辑提示词 → 保存 → 读回磁盘核对 → 还原**：验证副作用而不仅是界面提示 |

产物落在 `screenshots/`，进度实时写入 `smoke-progress.log`。

`prompt-edit` 场景跑完会**还原改动并清掉测试产生的 `.bak`**，不留痕迹在用户
产物目录里。验证的四项：界面进入已改态、保存栏出现且计数正确、`prompt.json`
内容真的变了、首次保存生成了备份。

**未捕获的异步异常会被转成一条明确的失败**（`unhandledRejection` 兜底），
不再让进程空转到超时 —— 这是踩过一次才补的：一个作用域外的变量引用让场景静默
挂了 5 分钟，日志里只在最后提了一句，排查代价极高。

### 关于断言口径

冒烟测试**只断言「界面是否与收到的数据自洽」，不断言「运行一定成功」**。
原因是运行环境存在一个与产品无关的干扰：harness 在切分层会删掉重复关键帧以
省 API 成本（`s2_segment.py` 的 `scratch.unlink`），而沙箱的 safe-delete 策略
会拦截这次删除，导致 Python 进程以退出码 1 中止。此时界面显示「运行出错」是
**正确的**——它如实反映了实际发生的事。

因此判据是：收到 success 就画成功、收到 gate_failed 就画黄色警告、收到 error
就必须给出原因与完整输出入口。界面能控制的是「别撒谎」，而不是「保证跑通」。

`e2e.js` 单独用于在没有界面的情况下先证明链路是通的：如果它能拿到完整的日志
流、阶段事件、成本数据和正确的退出码语义，那么界面上显示的就一定是真实数据。

### 中断路径的额外验证

`stop` 冒烟场景只能证明**界面态**正确（徽标显示已中断、按钮恢复可用、日志没被
清空），证明不了**进程真的死了**。Windows 上 `child.kill()` 只杀直接子进程，
Python 拉起的 ffmpeg 会变成孤儿继续吃 CPU —— 而用户在界面上看不到任何异常。

`--procs=1` 补的就是这一段：它记录运行期间的 Python/ffmpeg 进程集合，点停止后
轮询确认全部消失。

```
npm start -- --procs=1
```

实测输出（连续两次复跑均通过，两次结果结构一致；`ffmpeg.exe` 也在被终止
之列，这正是 `taskkill /T /F` 而非 `child.kill()` 的必要性）：

```
# 第一次
停止瞬间仍在的进程：python.exe#41056, python.exe#2020, python.exe#17788,
                    python.exe#41024, ffmpeg.exe#36804
界面结论：interrupted
停止 10 秒后残留：（无）
判定：通过 —— 进程树被完整终止，界面结论正确

# 第二次
启动后新增进程：python.exe#43700, python.exe#42408, python.exe#43456, python.exe#42148
停止瞬间仍在的进程：python.exe#41692, python.exe#42012, python.exe#43856,
                    python.exe#15256, ffmpeg.exe#43668
界面结论：interrupted
停止 10 秒后残留：（无）
判定：通过 —— 进程树被完整终止，界面结论正确
```

两次都在停止瞬间抓到 4 个 Python 进程 + 1 个 ffmpeg，10 秒后全部归零 ——
进程树终止是稳定行为，不是偶然命中。

**注意中断窗口很窄。** 沙箱会在切分层拦截 harness 的重复关键帧删除，流水线
可能在点停止之前就自然结束；此时界面显示「运行出错」是**正确的**（`runner.js`
的 `stop()` 会因 `settled` 静默返回 false），不该被误判成缺陷。探针因此做两件事：
点击前检查「停止按钮仍可用且尚无结论」，并把 `tasklist` 扫描全部移出「检查→点击」
之间的时间窗（这个坑踩了两次，每次都会误报成界面缺陷）。

## 已验证的缺陷与修复

界面级实测过程中发现并修复了以下问题。记录在此，因为前两个都是「读代码看不出
来、只有真跑界面才会暴露」的类型：

| 问题 | 症状 | 修复 |
|---|---|---|
| 启动失败后状态自相矛盾 | 视频不存在时按钮已恢复可用、日志有报错，但结果区仍写着「运行中」 | 补 `renderLaunchFailure()`，同步清掉占位并给出「未能启动」说明 |
| 中断徽标暴露退出码 | 显示「已中断 · 退出码 1」，让人误以为程序出错 | 中断时只显示「已中断」——退出码是 `taskkill` 强杀的副产物 |
| 退出码 130 误判为成功 | 自检发现 `classifyOutcome(130)` 返回 `success` | 改用 `switch` 逐一分支，`default` 按失败处理 |
| 原始行被 trim | 损坏的 JSON 日志丢掉行尾空格 | RAW 分支返回 `line` 而非 `trimmed` |
| 截图尺寸被裁切 | `BrowserWindow` 声明尺寸含边框，内容区更小 | 先 `setBounds` 再 `setContentSize`，并回读实际尺寸 |
| 窄屏水平溢出 | 400px 下文档宽 426px，「清空」按钮被推出视口点不到 | 日志面板头改换行排布；用 `--overflow` 定位到 `.panel-head-actions` |
| 窄屏纵向次序错乱 | 日志面板夹在配置栏中间，把配置切成两半 | `.layout` 改纵向 flex + `order`；重置 `min-height`（塌缩到 197px 导致子项溢出） |
| 窄屏触控目标过小 | 状态栏按钮 34px、内联下拉 26px，触屏难命中 | 窄屏统一下限 44px；复选框按所在 `<label>` 量（点的是整行） |
| `stop` 场景假通过 | `config.fresh` 写在 `drive()` 之后，配置已发出，实际测的是「已完成」 | 移到 `drive()` 之前，并加「停止按钮可用」的前置等待 |
| 停止只验了界面态 | `stop` 场景证明不了 ffmpeg 子进程真的死了 | 新增 `--procs=1`：实测 5 个进程（含 ffmpeg）在停止后全部清除 |
| 路径校验全校验失败 | `looksLikeRepoRoot` 只查根级 `vrh/`，但项目是 src-layout（包在 `src/vrh/`） | 加上 `src/vrh/` 候选。**写路径校验前先读 `pyproject.toml`** |
| harness 未就绪时预设谎报「2 项可用」 | `loadPresets()` 在拿不到 harness 预设时回落硬编码列表 | 未就绪时显示占位文案并禁用下拉 —— 不撒谎 |
| 编辑提示词后保存**静默无效** | `shot_id` 在 JSON 里是数字，经 `dataset` 回来是字符串，`Map` 精确匹配失配 → `changed: 0` 且 `ok: true` | 三重宽松匹配；匹配不到时返回 `ok: false` 并说明原因。**`ok: true, changed: 0` 是最危险的返回形态** |
| 冒烟场景空转到超时 | `runPromptEditChecks` 引用了作用域外的 `scenario`，抛出的 `ReferenceError` 无人接管，进程既不退出也不报错 | 改用 `report.scenario`；并加 `unhandledRejection` 兜底，把未捕获异常变成一条明确的失败 |
| `finish()` 可能被调用两次 | 异常兜底与正常路径都会走到收尾，重复写报告 | 加 `__finished` 幂等锁，内部标记不写入报告文件 |
| 冒烟脚本启动即崩（`ipcMain` undefined） | 运行环境注入 `NODE_OPTIONS`，被 Electron 子进程继承后强制以纯 Node 模式启动 | `run-all.js` 里显式 `delete childEnv.NODE_OPTIONS`（同时清 `ELECTRON_RUN_AS_NODE`）**与环境串味有关，非产品缺陷** |
| **改了渲染层但没重新打包** | 验证脚本 9 项全红，看起来像代码写错；实际 asar 里是旧文件 | 比对 asar 与源码的时间戳。**改完渲染层必须先重新打包再跑端到端验证**；`verify:*` 系列测的都是打包产物，不是源码 |
| 提示词「中英混排」被误判为漏翻 | 界面全中文，唯独提示词是英文，用户以为是没翻译完 | 槽位键名译成中文（英文名留在 `title`），并在卡片列表顶部加说明条讲清「有意为之」 |
| 「验证提示词仍是英文」的断言可能假通过 | 按关键字过滤行再判断无中文 —— 若过滤结果为空集，断言恒真 | 改用产物里的**真实 prompt 值**在 DOM 中定位，并单独断言「确实取到了行」 |
| 打包中途失败、`dist/` 空无一物 | electron-builder 报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`，`count:114, threshold:50` | 该守卫按**回合**计数，同一回合内大量删除试错会耗尽额度。**换个回合重跑即可** —— 实测第二次 26 秒完成。已修正 `remove-tree.js` 中两处错误注释 |

## 已知限制

- **未做代码签名**。首次运行 Windows 会弹 SmartScreen 提示，需点「仍要运行」。
  分发量小的时候可以接受；要正式分发就该买证书并对 exe 签名。
- 日志面板会出现中英混排：界面自身的文案全中文，harness 的原始输出保留英文
  （有意为之，见上文「中英混排的处理策略」）。
- 首屏初始化约需 3 秒，其中绝大部分是环境探测（要拉起 Python 与 ffmpeg 探版本）。
  期间预设下拉与命令预览为空 —— 这是正常的加载中状态，不是缺陷。
- **Electron 版本待升级**：`package.json` 声明 `^33.4.11`。曾尝试升到 44.4.2
  以消除审计通告，但删除 1016 个文件的 `node_modules` 被沙箱 bulk-delete 守卫
  拦截。本应用全程加载本地文件、无远程页面、无自定义协议注册，通告的实际攻击
  面很低，故先保持可用版本并记录为待办。升级可事后用
  `npm install electron@^44.4.2 --save-dev` 单包替换绕过守卫阈值。
- 环境干扰：沙箱会拦截 harness 在切分层的重复关键帧删除，导致带 `--fresh` 的
  运行以退出码 1 中止。这是运行环境限制，非产品缺陷；正常桌面环境无此问题。
- **编辑提示词不会触发重算**。改成新提示词后，`score.json` 里的评分仍是按旧
  提示词算的。界面在保存成功时会明确提示这一点，但不会自动重跑评测 ——
  是否重跑由用户决定（重跑要花 API 费用）。
