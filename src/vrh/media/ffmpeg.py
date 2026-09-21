"""Media inspection and frame extraction.

This is the only module in the harness that shells out to ffmpeg, and the only
one that reads video files. Everything downstream operates on images and JSON.

ffmpeg availability is checked, not assumed. When it is missing, callers get a
clear actionable error rather than a confusing subprocess traceback.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path

from vrh.contracts.media import MediaMeta


class FFmpegNotFoundError(RuntimeError):
    """Raised when ffmpeg/ffprobe are not on PATH.

    The message includes install guidance because this is the single most likely
    first-run failure.
    """

    def __init__(self, missing: str) -> None:
        super().__init__(
            f"{missing} was not found on PATH (and no bundled copy in ./tools).\n"
            "Install ffmpeg, or run VRH inside the provided Docker image:\n"
            "  docker build -t vrh . && docker run --rm -v \"$PWD:/work\" vrh ...\n"
            "  winget install Gyan.FFmpeg        (Windows)\n"
            "  brew install ffmpeg               (macOS)\n"
            "  sudo apt install ffmpeg           (Debian/Ubuntu)\n"
            "\n"
            "Or drop the binaries into <repo>/tools/ -- they are picked up first:\n"
            "  tools/ffmpeg.exe  tools/ffprobe.exe      (Windows)\n"
            "  tools/ffmpeg      tools/ffprobe          (macOS / Linux)"
        )


def _bundled_dir() -> Path | None:
    """Locate a repo-local `tools/` directory holding ffmpeg binaries.

    Checked before PATH so a checkout can carry its own pinned ffmpeg without
    requiring the user to modify their system environment. `VRH_FFMPEG_DIR`
    overrides the location when the binaries live elsewhere.
    """
    candidates: list[Path] = []
    override = os.environ.get("VRH_FFMPEG_DIR")
    if override:
        candidates.append(Path(override))

    # src/vrh/media/ffmpeg.py -> repo root is three levels up from the package.
    candidates.append(Path(__file__).resolve().parents[3] / "tools")

    for candidate in candidates:
        if candidate.is_dir() and _binary_in(candidate, "ffmpeg") is not None:
            return candidate
    return None


def _binary_in(directory: Path, name: str) -> Path | None:
    """Return the concrete path to a binary in `directory`, if present.

    Windows binaries carry a `.exe` suffix; POSIX ones do not. Both are checked
    so the same code path works on every platform.
    """
    for filename in (f"{name}.exe", name):
        candidate = directory / filename
        if candidate.is_file():
            return candidate
    return None


@lru_cache(maxsize=1)
def resolve_binary(name: str) -> str | None:
    """Resolve `ffmpeg` / `ffprobe` to an absolute path, or None.

    Order: bundled `tools/` first, then PATH. Cached because this is consulted
    once per frame extraction and a filesystem walk per call would be wasteful.
    """
    bundled = _bundled_dir()
    if bundled is not None:
        found = _binary_in(bundled, name)
        if found is not None:
            return str(found)
    return shutil.which(name)


def ffmpeg_available() -> bool:
    return resolve_binary("ffmpeg") is not None and resolve_binary("ffprobe") is not None


def require_ffmpeg() -> None:
    """Fail early with a helpful message if the media stack is missing."""
    if resolve_binary("ffprobe") is None:
        raise FFmpegNotFoundError("ffprobe")
    if resolve_binary("ffmpeg") is None:
        raise FFmpegNotFoundError("ffmpeg")


def _require_binary(name: str) -> str:
    """Resolved path for a binary, or an actionable error."""
    resolved = resolve_binary(name)
    if resolved is None:
        raise FFmpegNotFoundError(name)
    return resolved


def _run(cmd: list[str], *, timeout_s: float = 300.0) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout_s,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        tail = (result.stderr or "").strip().splitlines()[-5:]
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(cmd)}\n" + "\n".join(tail))
    return result


def _parse_fraction(value: str) -> float:
    """Parse ffprobe's `num/den` rational notation."""
    if not value or value == "0/0":
        return 0.0
    if "/" in value:
        num, _, den = value.partition("/")
        try:
            d = float(den)
            return float(num) / d if d else 0.0
        except ValueError:
            return 0.0
    try:
        return float(value)
    except ValueError:
        return 0.0


def probe(video_path: str | Path) -> MediaMeta:
    """Read technical metadata from a video.

    Rotation handling deserves attention: a phone-shot portrait video reports
    1920x1080 with a 90-degree rotation tag. We read the tag from the stream
    side-data *and* the container-level tag, because different muxers write it in
    different places.
    """
    require_ffmpeg()
    path = Path(video_path)
    if not path.exists():
        raise FileNotFoundError(f"video not found: {path}")

    result = _run(
        [
            _require_binary("ffprobe"),
            "-v", "error",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            str(path),
        ],
        timeout_s=60.0,
    )
    data = json.loads(result.stdout)

    video_stream = next(
        (s for s in data.get("streams", []) if s.get("codec_type") == "video"), None
    )
    if video_stream is None:
        raise ValueError(f"no video stream found in {path}")

    audio_stream = next(
        (s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None
    )

    fmt = data.get("format", {}) or {}
    duration = _parse_fraction(str(fmt.get("duration", "0"))) or _parse_fraction(
        str(video_stream.get("duration", "0"))
    )
    fps = _parse_fraction(str(video_stream.get("avg_frame_rate", "0/0"))) or _parse_fraction(
        str(video_stream.get("r_frame_rate", "0/0"))
    )

    width = int(video_stream.get("width", 0))
    height = int(video_stream.get("height", 0))

    return MediaMeta(
        path=str(path.resolve()),
        duration_s=duration or 0.001,
        fps=fps or 25.0,
        width=width,
        height=height,
        codec=str(video_stream.get("codec_name", "unknown")),
        bitrate_bps=int(fmt["bit_rate"]) if str(fmt.get("bit_rate", "")).isdigit() else None,
        audio_codec=str(audio_stream.get("codec_name")) if audio_stream else None,
        audio_channels=int(audio_stream.get("channels", 0)) if audio_stream else None,
        rotation=_read_rotation(video_stream, fmt),
    )


def _read_rotation(video_stream: dict, fmt: dict) -> int:
    """Extract rotation, normalising to 0/90/180/270.

    Checks three locations in order of reliability:
      1. stream side_data (modern ffmpeg)
      2. stream tags.rotate (legacy)
      3. container-level tag
    """
    for entry in video_stream.get("side_data_list", []) or []:
        if "rotation" in entry:
            return int(entry["rotation"]) % 360

    for source in (video_stream.get("tags", {}) or {}, fmt.get("tags", {}) or {}):
        raw = source.get("rotate")
        if raw is not None:
            try:
                return int(float(raw)) % 360
            except (TypeError, ValueError):
                continue
    return 0


def extract_frame(video_path: str | Path, timestamp_s: float, out_path: Path) -> Path:
    """Extract a single frame at a timestamp.

    `-ss` before `-i` seeks by keyframe index instead of decoding every frame up
    to the target. On a 10-minute video that is the difference between ~50ms and
    several seconds per frame -- and we extract hundreds of frames.
    """
    require_ffmpeg()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    _run(
        [
            _require_binary("ffmpeg"),
            "-hide_banner",
            "-loglevel", "error",
            "-ss", f"{max(0.0, timestamp_s):.3f}",
            "-i", str(video_path),
            "-frames:v", "1",
            "-q:v", "2",  # near-lossless JPEG; quality matters for vision models
            "-y",
            str(out_path),
        ],
        timeout_s=120.0,
    )
    if not out_path.exists():
        raise RuntimeError(f"ffmpeg reported success but {out_path} is missing")
    return out_path


def extract_audio(video_path: str | Path, out_path: Path, sample_rate: int = 16000) -> Path:
    """Extract a mono 16 kHz WAV, the format ASR models expect."""
    require_ffmpeg()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    _run(
        [
            _require_binary("ffmpeg"),
            "-hide_banner",
            "-loglevel", "error",
            "-i", str(video_path),
            "-vn",
            "-ac", "1",
            "-ar", str(sample_rate),
            "-acodec", "pcm_s16le",
            "-y",
            str(out_path),
        ],
        timeout_s=300.0,
    )
    return out_path
