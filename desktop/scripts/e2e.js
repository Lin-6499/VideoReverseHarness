'use strict';

/**
 * 端到端联调脚本：真实 spawn harness，验证流式解析与结果判定。
 *
 * 这个脚本的作用是「在没有界面的情况下先证明链路通」—— 如果它能拿到完整的
 * 日志流、阶段事件和正确的退出码语义，那么界面上看到的就一定是真实数据。
 *
 * 用法：node scripts/e2e.js [场景]
 *   场景：success(默认) | gate | missing | stop
 */

const path = require('path');
const environment = require('../src/main/environment');
const runner = require('../src/main/runner');
const artifacts = require('../src/main/artifacts');

const scenario = process.argv[2] || 'success';
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** 各场景的配置。 */
const SCENARIOS = {
  success: {
    label: '正常完整运行',
    config: {
      videoPath: path.join(REPO_ROOT, 'samples', 'clip.mp4'),
      keyframeStrategy: 'triple',
      preset: 't2v_generic',
    },
  },
  gate: {
    label: '质量门未过（--fail-on-gate 应返回 2）',
    config: {
      videoPath: path.join(REPO_ROOT, 'samples', 'clip.mp4'),
      keyframeStrategy: 'triple',
      verify: true,
      threshold: 0.99,
      failOnGate: true,
    },
  },
  missing: {
    label: '视频不存在（应返回 1）',
    config: { videoPath: path.join(REPO_ROOT, 'samples', 'does-not-exist.mp4') },
  },
  stop: {
    label: '运行中手动停止（应判定为中断）',
    config: {
      videoPath: path.join(REPO_ROOT, 'samples', 'clip.mp4'),
      keyframeStrategy: 'adaptive',
    },
  },
};

async function main() {
  const chosen = SCENARIOS[scenario];
  if (!chosen) {
    console.error(`未知场景：${scenario}。可选：${Object.keys(SCENARIOS).join(' | ')}`);
    process.exit(1);
  }

  console.log(`\n场景：${chosen.label}`);
  console.log('='.repeat(70));

  const env = await environment.doctor();
  if (!env.canRun) {
    console.error('环境未就绪：', JSON.stringify(env.problems, null, 2));
    process.exit(1);
  }

  const logs = [];
  const stageEvents = [];
  const costs = [];
  let stopTimer = null;

  await new Promise((resolve) => {
    const controller = runner.startRun(
      chosen.config,
      { pythonPath: env.python.path, repoRoot: env.repoRoot },
      {
        onCommand: (cmd) => console.log(`[命令] ${cmd}\n`),
        onLog: (log) => {
          logs.push(log);
          const levelTag = log.level === 'RAW' ? '     ' : log.level.padEnd(5);
          console.log(`  ${log.ts || '--:--:--'} ${levelTag} ${log.msg}`);
        },
        onStage: (event) => {
          stageEvents.push(event);
          const detail = event.text ? ` — ${event.text}` : '';
          const dur = event.durationS ? ` ${event.durationS}s` : '';
          console.log(`         ↳ [阶段事件] ${event.type} ${event.stage || ''}${dur}${detail}`);
        },
        onCost: (cost) => costs.push(cost),
        onDone: (result) => {
          if (stopTimer) clearTimeout(stopTimer);
          console.log('\n' + '='.repeat(70));
          console.log('结果：');
          console.log(`  kind       = ${result.outcome.kind}`);
          console.log(`  label      = ${result.outcome.label}`);
          console.log(`  isFailure  = ${result.outcome.isFailure}`);
          console.log(`  exitCode   = ${result.exitCode}`);
          console.log(`  message    = ${result.outcome.message}`);

          console.log('\n统计：');
          console.log(`  日志行数     = ${logs.length}`);
          console.log(`  阶段事件数   = ${stageEvents.length}`);
          console.log(`  阶段事件     = ${stageEvents.map((e) => (e.stage ? `${e.type}:${e.stage}` : e.type)).join(', ')}`);
          console.log(`  成本事件数   = ${costs.length}`);
          if (costs.length) console.log(`  最终成本     = $${costs[costs.length - 1].usd}`);

          if (result.artifacts) {
            const art = result.artifacts;
            console.log('\n产物：');
            console.log(`  videoId      = ${art.videoId}`);
            console.log(`  runDir       = ${art.runDir}`);
            console.log(`  exists       = ${art.exists}`);
            if (art.exists) {
              console.log(`  镜头数       = ${art.shotCount}`);
              console.log(`  总时长       = ${art.totalDurationS}s`);
              console.log(`  画幅         = ${art.aspectRatio}`);
              console.log(`  有 prompt    = ${art.hasPrompt}`);
              console.log(`  有 score     = ${art.hasScore}`);
              console.log(`  需复核       = ${art.reviewCount}`);
              console.log(`  镜头卡片数   = ${art.shotCards.length}`);
              if (art.shotCards.length) {
                const first = art.shotCards[0];
                console.log(`  首卡 prompt  = ${String(first.prompt).slice(0, 70)}...`);
                console.log(`  首卡 conf    = ${first.confidence}`);
              }
              if (art.score) {
                console.log(`  综合分       = ${art.score.aggregate} / 阈值 ${art.score.threshold}`);
                console.log(`  passed       = ${art.score.passed}`);
              }
            }
          }

          const report = result.report || '';
          console.log(`\nstdout 报告长度 = ${report.length} 字符`);
          if (report) {
            console.log('报告首行       = ' + report.split('\n').find((l) => l.trim()).slice(0, 70));
          }

          console.log('='.repeat(70));
          resolve();
        },
      }
    );

    // stop 场景：1.5 秒后发停止信号。
    if (scenario === 'stop') {
      stopTimer = setTimeout(() => {
        console.log('\n>>> 发送停止信号 <<<\n');
        controller.stop();
      }, 1500);
    }
  });
}

main().catch((error) => {
  console.error('联调失败：', error);
  process.exit(1);
});
