"""Shared test fixtures.

The key idea: tests that need a video generate one with ffmpeg at session scope.
A real decodable MP4 with real cut points exercises far more of the pipeline than
a mocked probe result would -- and it is what catches rotation handling, codec
quirks and timecode drift.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from vrh.config import Settings  # noqa: E402
from vrh.contracts.job import Job, RunOptions  # noqa: E402
from vrh.media.ffmpeg import ffmpeg_available, resolve_binary  # noqa: E402


def _run_ffmpeg(args: list[str]) -> None:
    result = subprocess.run(args, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr[-800:]}")


@pytest.fixture(scope="session")
def synthetic_video(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """A 6-second, 640x360 clip with three visually distinct segments.

    Built from three solid-colour sources concatenated, so cut detection has
    unambiguous boundaries to find. A smooth source would make boundary F1 depend
    on detector tuning rather than on the pipeline being correct.
    """
    if not ffmpeg_available():
        pytest.skip("ffmpeg not available")

    ffmpeg = resolve_binary("ffmpeg")
    out_dir = tmp_path_factory.mktemp("media")
    target = out_dir / "synthetic.mp4"

    segments = [
        ("red", 0, 2),
        ("green", 2, 4),
        ("blue", 4, 6),
    ]

    # Generate each segment then concatenate. Using lavfi colour sources avoids
    # depending on any external asset.
    parts: list[Path] = []
    for index, (colour, _, _) in enumerate(segments):
        part = out_dir / f"part{index}.mp4"
        _run_ffmpeg(
            [
                ffmpeg, "-hide_banner", "-loglevel", "error",
                "-f", "lavfi",
                "-i", f"color=c={colour}:s=640x360:d=2:r=12",
                "-pix_fmt", "yuv420p",
                "-y", str(part),
            ]
        )
        parts.append(part)

    concat_file = out_dir / "concat.txt"
    concat_file.write_text(
        "\n".join(f"file '{p.as_posix()}'" for p in parts), encoding="utf-8"
    )

    _run_ffmpeg(
        [
            ffmpeg, "-hide_banner", "-loglevel", "error",
            "-f", "concat", "-safe", "0",
            "-i", str(concat_file),
            "-c", "copy",
            "-y", str(target),
        ]
    )
    return target


@pytest.fixture
def offline_settings(tmp_path: Path) -> Settings:
    """Settings wired to fake providers and an isolated cache.

    Every knob that could reach the network or share state between tests is
    pinned here.
    """
    settings = Settings()
    settings.providers.vision.name = "fake"
    settings.providers.llm.name = "fake"
    settings.providers.asr.name = "fake"
    settings.providers.embedding.name = "fake"
    settings.cache.enabled = True
    settings.cache.path = str(tmp_path / ".cache" / "test.sqlite3")
    settings.cost.track = True
    settings.cost.price_per_image = 0.001
    settings.logging.show_cost = False
    settings.output_root = str(tmp_path / "output")
    return settings


@pytest.fixture
def basic_job(tmp_path: Path, synthetic_video: Path) -> Job:
    """A minimal job against the synthetic fixture."""
    options = RunOptions()
    options.keyframes.strategy = "triple"
    options.keyframes.max_per_shot = 3
    options.segment.cut_threshold = 27.0
    options.max_shots = 20
    options.include_audio = False  # the synthetic clip has no audio track
    return Job(
        video_path=str(synthetic_video),
        preset="t2v_generic",
        options=options,
        output_root=str(tmp_path / "output"),
    )
