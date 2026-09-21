"""Cross-stage contracts.

These Pydantic models *are* the interfaces between pipeline stages. Stages
never share Python objects in memory -- they write these models to disk and the
next stage reads them back. That is what makes single-stage reruns, resumable
jobs and per-stage testing possible without any orchestration framework.
"""

from vrh.contracts.annotation import (
    ActionAnnotation,
    AudioAnnotation,
    CameraAnnotation,
    ShotAnnotation,
)
from vrh.contracts.job import (
    STAGE_ORDER,
    Job,
    KeyframeOptions,
    RunOptions,
    RunState,
    SegmentOptions,
    StageName,
    StageRecord,
)
from vrh.contracts.media import MediaMeta
from vrh.contracts.prompt import PromptBundle, ShotPrompt
from vrh.contracts.score import ScoreReport, ShotScore
from vrh.contracts.segment import Keyframe, Shot, ShotContext, ShotSet

__all__ = [
    "STAGE_ORDER",
    "ActionAnnotation",
    "AudioAnnotation",
    "CameraAnnotation",
    "Job",
    "Keyframe",
    "KeyframeOptions",
    "MediaMeta",
    "PromptBundle",
    "RunOptions",
    "RunState",
    "ScoreReport",
    "SegmentOptions",
    "Shot",
    "ShotAnnotation",
    "ShotContext",
    "ShotPrompt",
    "ShotScore",
    "ShotSet",
    "StageName",
    "StageRecord",
]
