"""Command-line interface.

Subcommands are verbs over artifacts, not stages: `run` executes, `inspect`
reads back what a stage produced, `report` renders the human view, `doctor`
checks the environment. The distinction matters because the most common
debugging action is inspecting an artifact, not re-running the pipeline.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path

from vrh import __version__
from vrh.config import load_settings
from vrh.contracts.job import STAGE_ORDER, Job, RunOptions, RunState
from vrh.core.pipeline import Pipeline
from vrh.presets import available_presets
from vrh.quality import render_report, render_report_html


def _setup_logging(level: str, as_json: bool) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s | %(message)s"
        if not as_json
        else '{"ts":"%(asctime)s","level":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}',
        datefmt="%H:%M:%S",
        stream=sys.stderr,
    )


def _run_dir_for(video_path: str, output_root: str) -> Path:
    return Path(output_root) / Job(video_path=video_path, output_root=output_root).video_id


def cmd_run(args: argparse.Namespace) -> int:
    """Execute the pipeline for one video."""
    settings = load_settings(preset=args.preset)
    if args.output:
        settings.output_root = args.output

    _setup_logging(
        args.log_level or settings.logging.level,
        args.json_logs or settings.logging.json_logs,
    )

    options = RunOptions()
    options.include_audio = not args.no_audio
    options.max_shots = args.max_shots
    options.verify = args.verify
    options.max_rounds = args.rounds
    options.quality_threshold = args.threshold
    options.keyframes.strategy = args.keyframe_strategy
    options.keyframes.max_per_shot = args.frames_per_shot
    options.segment.cut_threshold = args.cut_threshold
    options.segment.detect_motion = not args.no_motion
    options.dry_run = args.dry_run

    job = Job(
        video_path=args.video,
        preset=args.preset,
        options=options,
        output_root=settings.output_root,
    )

    pipeline = Pipeline(settings=settings)
    outcome = asyncio.run(
        pipeline.run_with_gate(job) if args.verify else pipeline.run(job, resume=not args.fresh)
    )

    if outcome.bundle is not None:
        shot_set = _load_optional(outcome.run_dir / "shots.json")
        text = render_report(
            outcome.bundle,
            shot_set=shot_set,
            score=outcome.score,
            run_id=outcome.run_id,
        )
        print(text)

        # Always write the HTML review page: it is the artifact that makes
        # human correction practical, and it costs nothing to produce.
        html_out = render_report_html(
            outcome.bundle,
            shot_set=shot_set,
            score=outcome.score,
            run_id=outcome.run_id,
        )
        report_path = outcome.run_dir / "report.html"
        report_path.write_text(_wrap_html(html_out), encoding="utf-8")
        print(f"\nartifacts : {outcome.run_dir}")
        print(f"review    : {report_path}")
    else:
        print(f"run finished without a prompt bundle (stopped early). artifacts: {outcome.run_dir}")

    if args.fail_on_gate and not outcome.passed:
        print("\nquality gate not satisfied", file=sys.stderr)
        return 2
    return 0


def cmd_inspect(args: argparse.Namespace) -> int:
    """Print an artifact produced by a previous run."""
    run_dir = _run_dir_for(args.video, args.output)
    if not run_dir.exists():
        print(f"no run found at {run_dir}", file=sys.stderr)
        return 1

    if args.stage == "state":
        path = run_dir / "run_state.json"
    else:
        from vrh.core.registry import ARTIFACTS

        path = run_dir / ARTIFACTS[args.stage]

    if not path.exists():
        print(f"artifact not found: {path}", file=sys.stderr)
        print(f"available: {[p.name for p in sorted(run_dir.iterdir())]}", file=sys.stderr)
        return 1

    data = json.loads(path.read_text(encoding="utf-8"))
    if args.field:
        for part in args.field.split("."):
            data = data[int(part)] if part.isdigit() and isinstance(data, list) else data[part]

    print(json.dumps(data, indent=2, ensure_ascii=False))
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    """Re-render the human-readable report from existing artifacts."""
    run_dir = _run_dir_for(args.video, args.output)
    bundle = _load_optional(run_dir / "prompt.json")
    if bundle is None:
        print(f"no prompt.json in {run_dir}; run the pipeline first", file=sys.stderr)
        return 1

    shot_set = _load_optional(run_dir / "shots.json")
    score = _load_optional(run_dir / "score.json")
    state = None
    if (run_dir / "run_state.json").exists():
        state = RunState.load(run_dir)

    if args.format == "html":
        content = _wrap_html(
            render_report_html(bundle, shot_set, score, run_id=state.run_id if state else "")
        )
        out = run_dir / "report.html"
        out.write_text(content, encoding="utf-8")
        print(f"wrote {out}")
    elif args.format == "text":
        print(render_report(bundle, shot_set, score, run_id=state.run_id if state else ""))
    else:
        print(bundle.to_flat_text())
    return 0


def cmd_doctor(args: argparse.Namespace) -> int:
    """Check that the environment can actually run the pipeline."""
    print(f"vrh {__version__}\n")
    ok = True

    print("environment")
    print("-" * 60)
    print(f"  python           {sys.version.split()[0]}")

    # ffmpeg is the one hard dependency; everything else degrades gracefully.
    # Use the same resolver the pipeline uses, so `doctor` reports on the binary
    # that will actually be invoked (bundled tools/ included, not just PATH).
    from vrh.media.ffmpeg import resolve_binary

    for binary in ("ffmpeg", "ffprobe"):
        found = resolve_binary(binary)
        mark = "OK" if found else "MISSING"
        print(f"  {binary:<16} {mark}{'  ' + found if found else ''}")
        if not found:
            ok = False

    print("\noptional packages")
    print("-" * 60)
    for module, purpose in (
        ("scenedetect", "shot boundary detection"),
        ("cv2", "optical-flow motion analysis"),
        ("numpy", "numeric support"),
    ):
        try:
            __import__(module)
            print(f"  {module:<16} OK        ({purpose})")
        except ImportError:
            print(f"  {module:<16} MISSING   ({purpose})")

    print("\nconfiguration")
    print("-" * 60)
    settings = load_settings()
    print(f"  preset           {settings.preset}")
    print(f"  presets found    {', '.join(available_presets()) or 'none'}")
    for slot in ("vision", "llm", "asr", "embedding"):
        cfg = getattr(settings.providers, slot)
        print(f"  provider.{slot:<9} {cfg.name}")
    print(f"  cache enabled    {settings.cache.enabled}")
    print(f"  compliance       {'enabled' if settings.compliance.enabled else 'disabled'}")

    print("\nverdict")
    print("-" * 60)
    if ok:
        print("  environment looks runnable.")
        print("  try: vrh run --video <path> --keyframe-strategy triple")
    else:
        print("  ffmpeg is required for any stage that touches video files.")
        print("  install it, or use the Docker image (see README).")
    return 0 if ok else 1


def cmd_stages(args: argparse.Namespace) -> int:
    """Explain the pipeline, useful as inline documentation."""
    from vrh.core.registry import ARTIFACTS

    print("VRH pipeline stages\n")
    descriptions = {
        "parse": "read container/stream metadata, extract audio",
        "segment": "detect cuts, extract keyframes, classify camera motion",
        "understand": "annotate each shot with a vision model",
        "generate": "fill preset slots, synthesise the global prompt",
        "evaluate": "score the result, flag shots for review",
    }
    for i, name in enumerate(STAGE_ORDER, start=1):
        print(f"  L{i} {name:<11} -> {ARTIFACTS[name]:<18} {descriptions[name]}")

    print("\nrerun a single stage while reusing prior artifacts:")
    print("  vrh run --video X --only segment")
    print("\ninspect what a stage produced:")
    print("  vrh inspect --video X --stage segment")
    return 0


def _load_optional(path: Path):
    """Load a model from JSON if the file exists, else None."""
    if not path.exists():
        return None
    from vrh.contracts.prompt import PromptBundle
    from vrh.contracts.score import ScoreReport
    from vrh.contracts.segment import ShotSet

    model = {
        "shots.json": ShotSet,
        "prompt.json": PromptBundle,
        "score.json": ScoreReport,
    }.get(path.name)
    if model is None:
        return None
    try:
        return model.model_validate_json(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None


def _wrap_html(body: str) -> str:
    """Wrap a report fragment into a standalone, styled page."""
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VRH review</title>
<style>
  :root {{
    --bg: #14161a; --surface: #1c1f26; --line: #2c313b;
    --fg: #e6e8ec; --muted: #9aa1ad; --accent: #6aa9ff;
    --ok: #4ec9a0; --bad: #ef6b6b; --warn: #e0b341;
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; padding: 32px; background: var(--bg); color: var(--fg);
    font: 14px/1.6 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  }}
  h1 {{ font-size: 20px; font-weight: 600; margin: 0 0 4px; }}
  h2 {{ font-size: 15px; font-weight: 600; margin: 0 0 12px; }}
  h3 {{ font-size: 13px; font-weight: 600; margin: 16px 0 6px; color: var(--muted); }}
  .meta {{ color: var(--muted); margin: 0 0 24px; font-size: 13px; }}
  section {{
    background: var(--surface); border: 1px solid var(--line);
    border-radius: 10px; padding: 20px; margin-bottom: 16px;
  }}
  .anchor {{ color: var(--accent); font-family: ui-monospace, Menlo, Consolas, monospace; }}
  .quality dl {{ display: grid; grid-template-columns: 180px 1fr; gap: 4px 16px; margin: 0; }}
  .quality dt {{ color: var(--muted); }}
  .quality dd {{ margin: 0; }}
  .quality.pass h2 {{ color: var(--ok); }}
  .quality.fail h2 {{ color: var(--bad); }}
  .diff {{ color: var(--warn); margin: 12px 0 0; }}
  .warn ul {{ margin: 0; padding-left: 20px; color: var(--warn); }}
  .shot {{
    background: var(--bg); border: 1px solid var(--line); border-left: 3px solid var(--line);
    border-radius: 8px; padding: 16px; margin-bottom: 12px;
  }}
  .shot.flagged {{ border-left-color: var(--bad); }}
  .shot header {{ display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }}
  .sid {{ font-weight: 600; font-family: ui-monospace, Menlo, Consolas, monospace; }}
  .tc {{ color: var(--muted); font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }}
  .badge {{
    background: var(--line); color: var(--muted); border-radius: 4px;
    padding: 2px 7px; font-size: 11px; font-family: ui-monospace, Menlo, Consolas, monospace;
  }}
  .thumbs {{ display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }}
  .kf {{ height: 84px; border-radius: 5px; border: 1px solid var(--line); }}
  pre {{
    background: #101216; border: 1px solid var(--line); border-radius: 6px;
    padding: 10px 12px; margin: 0; overflow-x: auto; white-space: pre-wrap;
    font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px;
  }}
  .prompt {{ border-left: 2px solid var(--accent); }}
  details {{ margin-top: 10px; }}
  summary {{ cursor: pointer; color: var(--muted); font-size: 12px; }}
  .issues {{ color: var(--bad); margin: 10px 0 0; padding-left: 20px; font-size: 13px; }}
  .issues li {{ margin-bottom: 3px; }}
</style>
</head>
<body>
{body}
</body>
</html>"""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="vrh",
        description="Video Reverse Harness — turn a video into structured prompts.",
    )
    parser.add_argument("--version", action="version", version=f"vrh {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="run the pipeline on a video")
    run.add_argument("--video", required=True, help="path to the source video")
    run.add_argument("--preset", default="t2v_generic", help="prompt preset name")
    run.add_argument("--output", default=None, help="output root directory")
    run.add_argument("--keyframe-strategy", default="triple", choices=["fixed", "triple", "adaptive"])
    run.add_argument("--frames-per-shot", type=int, default=4, help="frame budget per shot")
    run.add_argument("--cut-threshold", type=float, default=27.0, help="scene-cut sensitivity")
    run.add_argument("--max-shots", type=int, default=120, help="hard cap on shot count")
    run.add_argument("--verify", action="store_true", help="run the quality gate")
    run.add_argument("--rounds", type=int, default=1, help="max gate rounds (>=1)")
    run.add_argument("--threshold", type=float, default=0.7, help="gate threshold")
    run.add_argument("--no-audio", action="store_true", help="skip audio extraction")
    run.add_argument("--no-motion", action="store_true", help="skip optical-flow analysis")
    run.add_argument("--dry-run", action="store_true", help="stop after segmentation")
    run.add_argument("--fresh", action="store_true", help="ignore existing run state")
    run.add_argument("--only", default=None, choices=list(STAGE_ORDER), help="run one stage only")
    run.add_argument("--until", default=None, choices=list(STAGE_ORDER), help="stop after a stage")
    run.add_argument("--fail-on-gate", action="store_true", help="exit 2 when the gate fails")
    run.add_argument("--log-level", default=None, help="DEBUG | INFO | WARNING | ERROR")
    run.add_argument("--json-logs", action="store_true", help="emit JSON log lines")
    run.set_defaults(func=cmd_run)

    inspect = sub.add_parser("inspect", help="print an artifact from a previous run")
    inspect.add_argument("--video", required=True)
    inspect.add_argument("--output", default="output")
    inspect.add_argument("--stage", default="state", choices=[*STAGE_ORDER, "state"])
    inspect.add_argument("--field", default=None, help="drill into e.g. 'shots.0.motion'")
    inspect.set_defaults(func=cmd_inspect)

    report = sub.add_parser("report", help="render a report from existing artifacts")
    report.add_argument("--video", required=True)
    report.add_argument("--output", default="output")
    report.add_argument("--format", default="text", choices=["text", "html", "flat"])
    report.set_defaults(func=cmd_report)

    doctor = sub.add_parser("doctor", help="check the environment")
    doctor.set_defaults(func=cmd_doctor)

    stages = sub.add_parser("stages", help="describe the pipeline stages")
    stages.set_defaults(func=cmd_stages)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        # `--only` / `--until` are only meaningful for `run`; handle them here so
        # the other subcommands stay unaffected.
        if getattr(args, "command", None) == "run" and (args.only or args.until):
            return _run_partial(args)

        return int(args.func(args) or 0)
    except FileNotFoundError as exc:
        # The overwhelmingly common cause is a bad --video path, which deserves a
        # one-line message, not a stack trace.
        if _wants_traceback(args):
            raise
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\ninterrupted; completed stages are checkpointed and will resume",
              file=sys.stderr)
        return 130
    except Exception as exc:  # noqa: BLE001 - the CLI is the process boundary
        # A traceback is only useful to a developer, and --log-level DEBUG is how
        # they ask for one. Everyone else gets a single actionable line.
        if _wants_traceback(args):
            raise
        print(f"error: {type(exc).__name__}: {exc}", file=sys.stderr)
        print("re-run with --log-level DEBUG for a traceback", file=sys.stderr)
        return 1


def _wants_traceback(args: argparse.Namespace) -> bool:
    """True when the caller explicitly asked for developer-grade diagnostics."""
    return (getattr(args, "log_level", None) or "").upper() == "DEBUG"


def _run_partial(args: argparse.Namespace) -> int:
    """Re-run a subset of stages, reusing prior artifacts.

    This is the debugging path that matters most in practice: tuning the cut
    threshold should not re-invoke the vision model for every shot.
    """
    settings = load_settings(preset=args.preset)
    if args.output:
        settings.output_root = args.output
    _setup_logging(
        args.log_level or settings.logging.level,
        args.json_logs or settings.logging.json_logs,
    )

    options = RunOptions()
    options.max_shots = args.max_shots
    options.keyframes.strategy = args.keyframe_strategy
    options.keyframes.max_per_shot = args.frames_per_shot
    options.segment.cut_threshold = args.cut_threshold
    options.segment.detect_motion = not args.no_motion
    # Carry the gate options through as well: a partial rerun is often exactly
    # how you act on a failed gate, and silently dropping the threshold would
    # make `--until evaluate --verify --threshold` report the wrong verdict.
    options.verify = args.verify
    options.max_rounds = args.rounds
    options.quality_threshold = args.threshold

    job = Job(
        video_path=args.video,
        preset=args.preset,
        options=options,
        output_root=settings.output_root,
    )

    outcome = asyncio.run(
        Pipeline(settings=settings).run(job, resume=True, only=args.only, until=args.until)
    )
    print(f"re-ran [{args.only or f'until {args.until}'}] -> {outcome.run_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
