"""Media primitives: probing, frame extraction, motion analysis."""

from vrh.media.ffmpeg import (
    FFmpegNotFoundError,
    extract_audio,
    extract_frame,
    ffmpeg_available,
    probe,
    require_ffmpeg,
)
from vrh.media.motion import MotionAnalyzer, analyse_motion

__all__ = [
    "FFmpegNotFoundError",
    "MotionAnalyzer",
    "analyse_motion",
    "extract_audio",
    "extract_frame",
    "ffmpeg_available",
    "probe",
    "require_ffmpeg",
]
