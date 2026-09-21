'use strict';

/**
 * 运行器核心逻辑的自检脚本。
 *
 * 这些是纯函数 —— 参数组装、日志解析、结果判定 —— 不涉及 Electron 或子进程，
 * 因此可以直接用 node 跑。运行器的价值在于它把 harness 的输出契约翻译成界面
 * 语义，翻译错了界面就会显示错误信息，所以这部分值得单独验证。
 *
 * 用法：node scripts/selftest.js
 */

const assert = require('assert');
const r = require('../src/main/runner.js');
const a = require('../src/main/artifacts.js');

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${label}`);
    console.log(`       ${error.message}`);
  }
}

console.log('\nbuildArgs — 参数组装');

check('完整运行的参数顺序与缺省省略', () => {
  const args = r.buildArgs({
    videoPath: 'samples/clip.mp4',
    preset: 't2v_generic',
    keyframeStrategy: 'triple',
    framesPerShot: 4,
    cutThreshold: 27,
  });
  assert.deepStrictEqual(args, [
    '-m', 'vrh.cli', 'run',
    '--video', 'samples/clip.mp4',
    '--json-logs',
    '--preset', 't2v_generic',
    '--keyframe-strategy', 'triple',
    '--frames-per-shot', '4',
    '--cut-threshold', '27',
  ]);
});

check('未设置的项不出现在参数里（交给 harness 默认值）', () => {
  const args = r.buildArgs({ videoPath: 'a.mp4' });
  assert.deepStrictEqual(args, ['-m', 'vrh.cli', 'run', '--video', 'a.mp4', '--json-logs']);
  assert.ok(!args.includes('--preset'), '未指定 preset 时不应传递该参数');
  assert.ok(!args.includes('--frames-per-shot'), '未指定帧数时不应传递该参数');
});

check('质量门只在其开关打开时展开相关参数', () => {
  const off = r.buildArgs({ videoPath: 'a.mp4', threshold: 0.9, rounds: 3 });
  assert.ok(!off.includes('--threshold'), '未启用 verify 时阈值不应生效');
  assert.ok(!off.includes('--rounds'));

  const on = r.buildArgs({ videoPath: 'a.mp4', verify: true, threshold: 0.9, rounds: 3 });
  assert.ok(on.includes('--verify'));
  assert.ok(on.includes('--threshold') && on.includes('0.9'));
  assert.ok(on.includes('--rounds') && on.includes('3'));
});

check('--only 与 --until 互斥，且都需要层名', () => {
  const only = r.buildArgs({ videoPath: 'a.mp4', scope: 'only', scopeStage: 'generate' });
  assert.ok(only.includes('--only') && only.includes('generate'));
  assert.ok(!only.includes('--until'));

  const until = r.buildArgs({ videoPath: 'a.mp4', scope: 'until', scopeStage: 'segment' });
  assert.ok(until.includes('--until') && until.includes('segment'));
  assert.ok(!until.includes('--only'));

  const noStage = r.buildArgs({ videoPath: 'a.mp4', scope: 'only' });
  assert.ok(!noStage.includes('--only'), '缺少层名时不应传递半截参数');
});

check('json-logs 始终开启（界面依赖它做流式解析）', () => {
  for (const cfg of [{ videoPath: 'a.mp4' }, { videoPath: 'a.mp4', scope: 'only', scopeStage: 'parse' }]) {
    assert.ok(r.buildArgs(cfg).includes('--json-logs'));
  }
});

console.log('\nparseLogLine — 日志解析');

check('合法 NDJSON 解析出全部字段', () => {
  const log = r.parseLogLine('{"ts":"14:47:58","level":"info","logger":"vrh.core","msg":"hello"}');
  assert.strictEqual(log.ts, '14:47:58');
  assert.strictEqual(log.level, 'INFO', '级别应统一为大写');
  assert.strictEqual(log.logger, 'vrh.core');
  assert.strictEqual(log.msg, 'hello');
});

check('非 JSON 行按原文保留（如 PySceneDetect 的输出）', () => {
  const log = r.parseLogLine('Detecting scenes...');
  assert.strictEqual(log.level, 'RAW');
  assert.strictEqual(log.msg, 'Detecting scenes...');
});

check('损坏的 JSON 不丢行，降级为原文', () => {
  const log = r.parseLogLine('{"broken": ');
  assert.ok(log !== null, '解析失败也必须返回内容，不能返回 null 让整行消失');
  assert.strictEqual(log.msg, '{"broken": ');
});

check('空行返回 null（调用方据此跳过）', () => {
  assert.strictEqual(r.parseLogLine(''), null);
  assert.strictEqual(r.parseLogLine('   '), null);
});

check('缺少 msg 字段的 JSON 也降级为原文', () => {
  const log = r.parseLogLine('{"ts":"00:00","level":"INFO"}');
  assert.strictEqual(log.level, 'RAW');
});

console.log('\nextractStageEvent — 阶段进度提取');

check('识别阶段完成并带出耗时', () => {
  const e = r.extractStageEvent({ msg: "stage 'segment' complete in 4.21s -> shots.json" });
  assert.deepStrictEqual(e, { type: 'completed', stage: 'segment', durationS: 4.21 });
});

check('识别跳过与重跑，区别对待', () => {
  assert.strictEqual(
    r.extractStageEvent({ msg: "skipping 'generate' (already complete)" }).type, 'skipped');
  assert.strictEqual(
    r.extractStageEvent({ msg: "re-running 'evaluate' (options changed since last run)" }).type,
    'running');
});

check('阶段内部进展转为中文说明', () => {
  const e = r.extractStageEvent({ msg: 'L2: 3 shots, 9 keyframes (strategy=triple)' });
  assert.strictEqual(e.type, 'detail');
  assert.ok(e.text.includes('3'), '应带出镜头数');
});

check('评测结果区分通过与否', () => {
  const fail = r.extractStageEvent({ msg: 'L5: aggregate=0.691 threshold=0.70 passed=False review=1' });
  assert.ok(fail.text.includes('未通过'));
  const pass = r.extractStageEvent({ msg: 'L5: aggregate=0.9 threshold=0.7 passed=True review=0' });
  assert.ok(pass.text.includes('通过'));
});

check('无关日志返回 null 而不是误报事件', () => {
  assert.strictEqual(r.extractStageEvent({ msg: 'cost: $0.0 | vision 0 calls' }), null);
  assert.strictEqual(r.extractStageEvent({ msg: 'Detecting scenes...' }), null);
});

console.log('\nextractCost — 成本解析');

check('解析成本与调用数', () => {
  const c = r.extractCost({ msg: 'cost: $0.0090 | vision 3 calls / 9 frames | llm 1 calls' });
  assert.strictEqual(c.usd, 0.009);
  assert.strictEqual(c.visionCalls, 3);
  assert.strictEqual(c.frames, 9);
  assert.strictEqual(c.llmCalls, 1);
});

check('非成本行返回 null', () => {
  assert.strictEqual(r.extractCost({ msg: 'stage parse complete' }), null);
});

console.log('\nclassifyOutcome — 结果判定（错误反馈的核心）');

check('退出码 0 → 成功', () => {
  const o = r.classifyOutcome(0, null, false);
  assert.strictEqual(o.kind, 'success');
  assert.strictEqual(o.isFailure, false);
});

check('退出码 1 → 错误', () => {
  const o = r.classifyOutcome(1, null, false);
  assert.strictEqual(o.kind, 'error');
  assert.strictEqual(o.isFailure, true);
});

check('退出码 2 → gate_failed，且明确不算失败', () => {
  const o = r.classifyOutcome(2, null, false);
  assert.strictEqual(o.kind, 'gate_failed');
  assert.strictEqual(o.isFailure, false, '质量门未过意味着流水线正常，绝不能标记为失败');
  assert.ok(o.message.includes('不属于故障'), '必须向用户说清这不是故障');
});

check('退出码 130 → 已中断，且提示可续跑', () => {
  const o = r.classifyOutcome(130, null, false);
  assert.strictEqual(o.kind, 'interrupted');
  assert.strictEqual(o.isFailure, false);
  assert.ok(o.message.includes('断点'));
});

check('被手动停止时优先判定为中断（即使退出码是 2）', () => {
  const o = r.classifyOutcome(2, null, true);
  assert.strictEqual(o.kind, 'interrupted');
  assert.strictEqual(o.isFailure, false);
});

check('被信号杀死 → 错误', () => {
  const o = r.classifyOutcome(null, 'SIGSEGV', false);
  assert.strictEqual(o.kind, 'error');
  assert.strictEqual(o.isFailure, true);
  assert.ok(o.message.includes('SIGSEGV'));
});

check('未知退出码 → 错误但不崩溃', () => {
  const o = r.classifyOutcome(99, null, false);
  assert.strictEqual(o.kind, 'error');
  assert.ok(o.message.includes('99'));
});

console.log('\nvideoId — 必须与 harness 的算法一致');

check('与 harness 的 video_id 结果相同', () => {
  // 实测值：D:\HarnessTest\samples\clip.mp4 → dab1820a51e5
  const id = a.videoId('D:\\HarnessTest\\samples\\clip.mp4');
  assert.strictEqual(id, 'dab1820a51e5', `实际得到 ${id}，与 harness 输出目录名不一致`);
});

check('大小写不敏感（Windows 路径）', () => {
  assert.strictEqual(
    a.videoId('D:\\HarnessTest\\samples\\clip.mp4'),
    a.videoId('d:\\harnessTest\\SAMPLES\\clip.mp4')
  );
});

check('不同路径产出不同 id', () => {
  assert.notStrictEqual(a.videoId('a/one.mp4'), a.videoId('a/two.mp4'));
});

console.log(`\n${'='.repeat(60)}`);
console.log(`通过 ${passed} / 失败 ${failed}`);
console.log('='.repeat(60));

process.exit(failed > 0 ? 1 : 0);
