'use strict';

/**
 * 打包产物内容确认：模型配置相关文件是否都在 asar 里。
 *
 * 为什么单独做：`build.files` 的 glob 很容易漏掉非 JS 资源 ——
 * `src/main/*.js` 不会包含 `src/main/test-model.py`。漏了之后开发态一切正常，
 * 只有打包态点「测试连接」才失败，且报错指向「找不到文件」而非「配置错误」，
 * 排查方向会被带偏。
 *
 * 这个检查不需要启动应用，秒级返回，适合在每次打包后顺手跑一遍。
 */

const path = require('path');
const fs = require('fs');
const asar = require('@electron/asar');

const ROOT = path.resolve(__dirname, '..');
const ARCHIVE = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar');

/** 文件 → 必须存在的特征串（特征串用于证明「是新版」而不只是「存在」）。 */
const EXPECT = [
  { file: path.join('src', 'renderer', 'renderer.js'), marks: ['PROVIDER_PRESETS', 'applyProviderPreset', 'VRH_PROVIDERS__VISION__NAME'] },
  { file: path.join('src', 'renderer', 'index.html'), marks: ['groupModel', 'providerPreset', 'fieldApiKey', 'btnTestModel'] },
  { file: path.join('src', 'renderer', 'styles.css'), marks: ['cfg-badge', 'test-result'] },
  { file: path.join('src', 'preload', 'preload.js'), marks: ['testModel', 'loadModelConfig'] },
  { file: path.join('src', 'main', 'model-config.js'), marks: ['toEnv', 'KEY_ENV_NAME', 'PROVIDER_RULES'] },
  { file: path.join('src', 'main', 'test-model.py'), marks: ['build_providers', 'annotate', 'ShotContext'] },
  { file: path.join('src', 'main', 'main.js'), marks: ['vrh:test-model', 'vrh:load-model-config'] },
];

let bad = 0;

if (!fs.existsSync(ARCHIVE)) {
  console.log(`FAIL  打包产物不存在：${ARCHIVE}`);
  process.exit(1);
}

for (const { file, marks } of EXPECT) {
  let text;
  try {
    text = asar.extractFile(ARCHIVE, file).toString('utf8');
  } catch (error) {
    console.log(`FAIL  ${file} 不在 asar 中 —— 检查 build.files 的 glob`);
    bad += 1;
    continue;
  }
  const missing = marks.filter((m) => !text.includes(m));
  if (missing.length) {
    console.log(`FAIL  ${file} 缺少特征串：${missing.join('、')}`);
    bad += 1;
  } else {
    console.log(`OK    ${file}  (${text.length} 字符)`);
  }
}

console.log('');
if (bad === 0) {
  console.log('打包产物内容正确 —— 模型配置链路的所有文件都已包含');
} else {
  console.log(`${bad} 个文件不符 —— 需要检查 build.files 并重新打包`);
  process.exit(1);
}
