"""Human-readable run reports.

Two renderers: plain text for terminals and CI logs, HTML for the review loop.
The HTML view is deliberately built around *correcting* results rather than
admiring them -- each shot shows its keyframes, its prompt, and any issues, so a
reviewer can spot and fix a bad annotation without opening the JSON.
"""

from __future__ import annotations

import html
import json
from pathlib import Path

from vrh.contracts.prompt import PromptBundle
from vrh.contracts.score import ScoreReport
from vrh.contracts.segment import ShotSet


def render_report(
    bundle: PromptBundle,
    shot_set: ShotSet | None = None,
    score: ScoreReport | None = None,
    *,
    run_id: str = "",
) -> str:
    """Render a plain-text summary."""
    lines: list[str] = []
    add = lines.append

    add("=" * 72)
    add(f"VRH run {run_id}" if run_id else "VRH run")
    add("=" * 72)
    add(f"video        : {bundle.video_path}")
    add(f"preset       : {bundle.target_model}")
    add(f"aspect ratio : {bundle.aspect_ratio or 'unknown'}")
    add(f"duration     : {bundle.total_duration_s:.2f}s")
    add(f"shots        : {bundle.shot_count}")
    if bundle.genre or bundle.pacing:
        add(f"genre/pacing : {bundle.genre} / {bundle.pacing}")
    add("")

    if bundle.global_prompt:
        add("GLOBAL PROMPT")
        add("-" * 72)
        add(bundle.global_prompt)
        add("")

    if bundle.style_anchor:
        add("STYLE ANCHOR")
        add("-" * 72)
        add(bundle.style_anchor)
        add("")

    add("SHOT PROMPTS")
    add("-" * 72)
    for shot in bundle.shots:
        flag = ""
        if score is not None:
            detail = next((s for s in score.shot_scores if s.shot_id == shot.shot_id), None)
            if detail and detail.needs_review:
                flag = "  [!]"
        add(f"[{shot.shot_id:03d}] {shot.timecode}{flag}  conf={shot.confidence:.2f}")
        add(f"      {shot.prompt}")
        if shot.negative_prompt:
            add(f"      negative: {shot.negative_prompt}")
        add("")

    if score is not None:
        add("QUALITY")
        add("-" * 72)
        add(f"aggregate        : {score.aggregate:.3f}  (threshold {score.threshold:.2f})")
        add(f"passed           : {score.passed}")
        if score.boundary_f1 is not None:
            add(f"boundary F1      : {score.boundary_f1:.3f}")
        if score.mean_clip_similarity is not None:
            add(f"CLIP similarity  : {score.mean_clip_similarity:.3f}")
        if score.mean_field_accuracy is not None:
            add(f"field accuracy   : {score.mean_field_accuracy:.3f}")
        add(f"shots for review : {score.review_count}")
        add(f"cost             : ${score.cost_usd:.4f}")
        add(f"cache hit rate   : {score.cache_hit_rate:.1%}")
        if not score.passed:
            add(f"diff summary     : {score.diff_summary}")

    if bundle.warnings:
        add("")
        add("WARNINGS")
        add("-" * 72)
        for w in bundle.warnings:
            add(f"  - {w}")

    return "\n".join(lines)


def render_report_html(
    bundle: PromptBundle,
    shot_set: ShotSet | None = None,
    score: ScoreReport | None = None,
    *,
    run_id: str = "",
) -> str:
    """Render an HTML review page.

    Self-contained: no external CSS or JS, and keyframes are inlined as relative
    paths so the file works when opened directly from the run directory.
    """
    issue_map: dict[int, list[str]] = {}
    review_ids: set[int] = set()
    if score is not None:
        for s in score.shot_scores:
            if s.issues:
                issue_map[s.shot_id] = s.issues
            if s.needs_review:
                review_ids.add(s.shot_id)

    shots_by_id = {s.shot_id: s for s in shot_set.shots} if shot_set else {}

    cards: list[str] = []
    for shot in bundle.shots:
        source = shots_by_id.get(shot.shot_id)
        thumbs = ""
        if source and source.keyframes:
            # Paths are absolute; make them relative to the HTML file's directory
            # (the run dir) so the page is portable.
            imgs = []
            for kf in source.keyframes[:4]:
                try:
                    rel = Path(kf.path).name
                    imgs.append(f'<img class="kf" src="keyframes/{html.escape(rel)}" alt="">')
                except Exception:  # noqa: BLE001
                    continue
            thumbs = f'<div class="thumbs">{"".join(imgs)}</div>'

        issues = issue_map.get(shot.shot_id, [])
        issue_html = (
            '<ul class="issues">' + "".join(f"<li>{html.escape(i)}</li>" for i in issues) + "</ul>"
            if issues
            else ""
        )
        flagged = " flagged" if shot.shot_id in review_ids else ""
        motion = source.motion.dominant if source else "?"

        score_badge = ""
        if score is not None:
            detail = next((s for s in score.shot_scores if s.shot_id == shot.shot_id), None)
            if detail and detail.clip_similarity is not None:
                score_badge = f'<span class="badge">clip {detail.clip_similarity:.2f}</span>'
            if detail and detail.field_accuracy is not None:
                score_badge += f'<span class="badge">fields {detail.field_accuracy:.0%}</span>'

        cards.append(
            f"""
        <article class="shot{flagged}">
          <header>
            <span class="sid">#{shot.shot_id:03d}</span>
            <span class="tc">{html.escape(shot.timecode)}</span>
            <span class="badge">conf {shot.confidence:.2f}</span>
            <span class="badge">flow {html.escape(str(motion))}</span>
            {score_badge}
          </header>
          {thumbs}
          <pre class="prompt">{html.escape(shot.prompt)}</pre>
          <details>
            <summary>slots</summary>
            <pre>{html.escape(json.dumps(shot.slots, indent=2, ensure_ascii=False))}</pre>
          </details>
          {issue_html}
        </article>"""
        )

    quality = ""
    if score is not None:
        cls = "pass" if score.passed else "fail"
        quality = f"""
      <section class="quality {cls}">
        <h2>Quality — {"PASSED" if score.passed else "FAILED"}</h2>
        <dl>
          <dt>aggregate</dt><dd>{score.aggregate:.3f} / {score.threshold:.2f}</dd>
          <dt>shots for review</dt><dd>{score.review_count}</dd>
          <dt>cost</dt><dd>${score.cost_usd:.4f}</dd>
          <dt>cache hit rate</dt><dd>{score.cache_hit_rate:.1%}</dd>
        </dl>
        {f'<p class="diff">{html.escape(score.diff_summary)}</p>' if not score.passed else ""}
      </section>"""

    warnings = ""
    if bundle.warnings:
        items = "".join(f"<li>{html.escape(w)}</li>" for w in bundle.warnings)
        warnings = f'<section class="warn"><h2>Warnings</h2><ul>{items}</ul></section>'

    return f"""<h1>VRH review — {html.escape(Path(bundle.video_path).name)}</h1>
<p class="meta">
  run {html.escape(run_id)} · preset {html.escape(bundle.target_model)} ·
  {bundle.shot_count} shots · {bundle.total_duration_s:.2f}s ·
  {html.escape(bundle.aspect_ratio or "?")}
</p>

<section class="global">
  <h2>Global prompt</h2>
  <p>{html.escape(bundle.global_prompt) or "<em>none</em>"}</p>
  <h3>Style anchor</h3>
  <p class="anchor">{html.escape(bundle.style_anchor) or "<em>none</em>"}</p>
</section>
{quality}
{warnings}
<section class="shots">
  <h2>Shots</h2>
  {"".join(cards) or "<p>no shots</p>"}
</section>"""
