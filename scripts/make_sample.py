#!/usr/bin/env python3
"""Generate a sample clip for trying the harness.

Produces ``samples/clip.mp4``: a 6-second, 640x360 clip built from three
solid-colour segments. Solid colours give cut detection unambiguous boundaries,
so a run against this clip exercises the whole pipeline without depending on any
external asset.

Usage::

    python scripts/make_sample.py
    python scripts/make_sample.py --out /tmp/try.mp4
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from vrh.media.ffmpeg import ffmpeg_available, resolve_binary  # noqa: E402

SEGMENTS = [("red", 2), ("green", 2), ("blue", 2)]


def _run(args: list[str]) -> None:
    result = subprocess.run(args, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr[-800:]}")


def build(out_path: Path, width: int, height: int, fps: int) -> Path:
    if not ffmpeg_available():
        raise SystemExit(
            "ffmpeg not found. Run `python scripts/get_ffmpeg.py` first."
        )
    ffmpeg = resolve_binary("ffmpeg")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        parts: list[Path] = []

        for index, (colour, seconds) in enumerate(SEGMENTS):
            part = tmp_dir / f"part{index}.mp4"
            _run([
                ffmpeg, "-hide_banner", "-loglevel", "error",
                "-f", "lavfi",
                "-i", f"color=c={colour}:s={width}x{height}:d={seconds}:r={fps}",
                "-pix_fmt", "yuv420p",
                "-y", str(part),
            ])
            parts.append(part)

        # The concat demuxer resolves paths relative to the list file, so
        # absolute POSIX-style paths are required for cross-platform safety.
        concat = tmp_dir / "concat.txt"
        concat.write_text(
            "\n".join(f"file '{p.as_posix()}'" for p in parts),
            encoding="utf-8",
        )

        _run([
            ffmpeg, "-hide_banner", "-loglevel", "error",
            "-f", "concat", "-safe", "0",
            "-i", str(concat),
            "-c", "copy",
            "-y", str(out_path),
        ])

    return out_path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=str(ROOT / "samples" / "clip.mp4"))
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=360)
    parser.add_argument("--fps", type=int, default=12)
    args = parser.parse_args()

    target = build(Path(args.out), args.width, args.height, args.fps)
    size_kb = target.stat().st_size / 1024
    print(f"wrote {target} ({size_kb:.1f} KiB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
