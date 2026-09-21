'use strict';

/**
 * 产物读取。
 *
 * harness 的层间契约就是磁盘上的 JSON，界面直接读这些文件即可 —— 不需要让
 * harness 为 GUI 做任何适配。这里只负责把它们映射成界面要用的形状。
 *
 * video_id 的算法必须与 harness 保持一致：sha256(小写化绝对路径)[:12]。
 * 不一致就找不到输出目录。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function videoId(videoPath) {
  const resolved = path.resolve(videoPath).toLowerCase();
  return crypto.createHash('sha256').update(resolved, 'utf8').digest('hex').slice(0, 12);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 汇总一次运行的产物。
 *
 * 任何一份缺失都不算错误 —— 用户可能只跑到 L2，那时 prompt.json 本来就不存在。
 * 返回 null 字段让界面自行决定如何呈现，而不是抛异常。
 */
function collectArtifacts(outputRoot, videoPath) {
  const id = videoId(videoPath);
  const runDir = path.join(outputRoot, id);

  if (!fs.existsSync(runDir)) {
    return { videoId: id, runDir, exists: false };
  }

  const meta = readJson(path.join(runDir, 'meta.json'));
  const shots = readJson(path.join(runDir, 'shots.json'));
  const annotations = readJson(path.join(runDir, 'annotations.json'));
  const prompt = readJson(path.join(runDir, 'prompt.json'));
  const score = readJson(path.join(runDir, 'score.json'));

  // 镜头卡片以 prompt.json 为主 —— 它是最终交付物。评分按 shot_id 挂上去。
  const scoreByShot = new Map();
  for (const shotScore of score?.shot_scores ?? []) {
    scoreByShot.set(shotScore.shot_id, shotScore);
  }

  const shotCards = (prompt?.shots ?? []).map((shot) => {
    const s = scoreByShot.get(shot.shot_id);
    return {
      shotId: shot.shot_id,
      startS: shot.start_s,
      endS: shot.end_s,
      prompt: shot.prompt,
      negativePrompt: shot.negative_prompt,
      slots: shot.slots ?? {},
      confidence: shot.confidence,
      needsReview: s?.needs_review ?? false,
      issues: s?.issues ?? [],
      clipSimilarity: s?.clip_similarity ?? null,
    };
  });

  return {
    videoId: id,
    runDir,
    exists: true,
    meta,
    shotCount: shots?.shots?.length ?? prompt?.shots?.length ?? 0,
    totalDurationS: prompt?.total_duration_s ?? meta?.duration_s ?? null,
    aspectRatio: prompt?.aspect_ratio ?? null,
    prompt,
    score,
    shotCards,
    hasPrompt: prompt != null,
    hasScore: score != null,
    reviewCount: score?.review_count ?? shotCards.filter((c) => c.needsReview).length,
  };
}

/**
 * 把编辑过的提示词写回 prompt.json。
 *
 * 三条设计约束：
 *
 * 1. **先备份**。prompt.json 是整条流水线最终的交付物，用户改错了想回退时
 *    没有副本会很被动。首次修改前写一份 prompt.json.bak（仅首次，不覆盖旧备份，
 *    否则连改几次就把「原始版本」冲掉了）。
 *
 * 2. **只改 prompt / negative_prompt**。其余字段（shot_id、时间戳、slots、
 *    confidence）由 harness 生成，界面没有编辑入口 —— 擅自改动会破坏
 *    score.json 与 prompt.json 的对应关系。
 *
 * 3. **写前校验结构**。用户可能在编辑期间重跑了流水线，导致 prompt.json
 *    已被 harness 重写。比对 total_duration_s 与镜头数量，不一致就拒绝写入，
 *    让界面提示「产物已更新，请刷新后重试」—— 静默覆盖会丢数据。
 *
 * @returns {{ok: boolean, backedUp?: boolean, message?: string}}
 */
function savePromptEdits(runDir, edits) {
  if (!runDir) return { ok: false, message: '未指定产物目录' };

  const promptPath = path.join(runDir, 'prompt.json');
  const current = readJson(promptPath);
  if (!current) return { ok: false, message: 'prompt.json 不存在或无法解析' };

  const shots = current.shots;
  if (!Array.isArray(shots)) return { ok: false, message: 'prompt.json 结构异常：缺少 shots' };

  // 结构一致性校验（防「编辑期间重跑」导致的覆盖丢失）
  if (edits.expectedShotCount != null && edits.expectedShotCount !== shots.length) {
    return {
      ok: false,
      message: `产物已更新（镜头数由 ${edits.expectedShotCount} 变为 ${shots.length}），`
        + '请刷新结果后重新编辑。',
    };
  }

  const byId = new Map(shots.map((s) => [s.shot_id, s]));
  const applied = [];
  const unmatched = [];
  for (const edit of edits.shots || []) {
    /*
     * shotId 必须做类型宽松匹配。
     *
     * shot_id 在 prompt.json 里是数字（1, 2, 3…），但从界面传回来时会经过
     * HTML dataset —— 那里所有值都是字符串。用 Map 精确匹配会让 "1" ≠ 1，
     * 结果是「保存成功但一条都没改」，而且不报错，极难排查。
     * 这里按字符串归一化后比对。
     */
    const key = String(edit.shotId);
    const target = byId.get(edit.shotId)
      ?? byId.get(Number(edit.shotId))
      ?? shots.find((s) => String(s.shot_id) === key);
    if (!target) {
      // 记下来并回传给界面。静默忽略会让「用户改了但没生效」变成无解之谜。
      unmatched.push(edit.shotId);
      continue;
    }
    const before = target.prompt;
    const after = typeof edit.prompt === 'string' ? edit.prompt : before;
    const negAfter = typeof edit.negativePrompt === 'string' ? edit.negativePrompt : target.negative_prompt;

    if (before !== after || target.negative_prompt !== negAfter) {
      target.prompt = after;
      target.negative_prompt = negAfter;
      applied.push(edit.shotId);
    }
  }

  if (!applied.length) {
    // 有 edit 却一条都没匹配上：这不是「无事发生」，而是参数对不上，必须报出来。
    if (unmatched.length) {
      return {
        ok: false,
        message: `有 ${unmatched.length} 条修改未能匹配到任何镜头（ID：${unmatched.join(', ')}）。`
          + '产物可能已被重新生成，请刷新结果后重试。',
      };
    }
    return { ok: true, backedUp: false, changed: 0 };
  }

  // 备份只在首次做，且用 copyFile（不删原件，避免半途失败丢数据）。
  const backupPath = `${promptPath}.bak`;
  let backedUp = false;
  if (!fs.existsSync(backupPath)) {
    try {
      fs.copyFileSync(promptPath, backupPath);
      backedUp = true;
    } catch {
      // 备份失败不阻断保存，但要让调用方知道
      backedUp = false;
    }
  }

  // 先写临时文件再改名 —— 避免写入中途失败留下半个 JSON。
  const tmpPath = `${promptPath}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(current, null, 2), 'utf8');
    fs.renameSync(tmpPath, promptPath);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch { /* 忽略 */ }
    return { ok: false, message: `写入失败：${error.message}` };
  }

  return {
    ok: true,
    backedUp,
    changed: applied.length,
    unmatched: unmatched.length ? unmatched : undefined,
    backupPath: backedUp ? backupPath : null,
  };
}

/** 把编辑结果导出为独立文件（不动产物本身）。 */
function exportPrompt(runDir, targetPath) {
  const promptPath = path.join(runDir, 'prompt.json');
  const data = readJson(promptPath);
  if (!data) return { ok: false, message: 'prompt.json 不存在或无法解析' };
  try {
    fs.writeFileSync(targetPath, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true, path: targetPath };
  } catch (error) {
    return { ok: false, message: `导出失败：${error.message}` };
  }
}

module.exports = { collectArtifacts, videoId, readJson, savePromptEdits, exportPrompt };