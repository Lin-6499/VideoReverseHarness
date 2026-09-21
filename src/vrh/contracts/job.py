"""Job specification and run state.

`Job` is L0 input. `RunState` is the resumability mechanism: after every stage
completes, its output is committed here and flushed to disk. A crashed run
resumes by reading this file back, not by replaying expensive stages.
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, computed_field

StageName = Literal["parse", "segment", "understand", "generate", "evaluate"]

# Fixed execution order. The pipeline is linear by design -- see docs/DESIGN.md
# for why we do not use a generic DAG engine here.
STAGE_ORDER: tuple[StageName, ...] = (
    "parse",
    "segment",
    "understand",
    "generate",
    "evaluate",
)


class KeyframeOptions(BaseModel):
    """Controls how many frames per shot get pulled.

    `max_per_shot` is the dominant cost driver: API calls scale roughly as
    shots x frames. Lowering it from 4 to 3 saves ~25% while costing little
    fidelity, so it is the first knob to turn when the budget bites.
    """

    strategy: Literal["fixed", "triple", "adaptive"] = "triple"
    max_per_shot: int = Field(default=4, ge=1, le=12)
    fixed_interval_s: float = Field(
        default=1.0, gt=0, description="Used only when strategy='fixed'."
    )
    adaptive_threshold: float = Field(
        default=0.15,
        ge=0.0,
        le=1.0,
        description="Normalised flow magnitude above which 'adaptive' adds a frame.",
    )


class SegmentOptions(BaseModel):
    """Controls L2 shot detection."""

    cut_threshold: float = Field(
        default=27.0,
        gt=0,
        description="PySceneDetect ContentDetector threshold. Lower finds more cuts.",
    )
    min_shot_duration_s: float = Field(
        default=0.4, gt=0, description="Shots shorter than this are merged away."
    )
    target_fps: float = Field(
        default=24.0, gt=0, description="Normalisation target; also caps VFR drift."
    )
    detect_motion: bool = Field(
        default=True,
        description="Run optical flow analysis to classify camera moves. Disabling "
        "this makes the camera slot in final prompts unreliable.",
    )


class RunOptions(BaseModel):
    """Everything optional about a run."""

    keyframes: KeyframeOptions = Field(default_factory=KeyframeOptions)
    segment: SegmentOptions = Field(default_factory=SegmentOptions)

    include_audio: bool = True
    verify: bool = Field(
        default=False,
        description="Run L5 and gate on its result. Off by default because it "
        "requires a reference or an embedding backend.",
    )
    max_rounds: int = Field(
        default=1,
        ge=1,
        le=5,
        description="Total attempts including the first. >1 enables the rollback "
        "loop that re-runs L2 with feedback.",
    )
    quality_threshold: float = Field(default=0.7, ge=0.0, le=1.0)

    max_shots: int = Field(
        default=120, ge=1, description="Hard cap; guards against runaway cost."
    )
    dry_run: bool = Field(
        default=False, description="Stop after L2 and report the shot plan."
    )


class Job(BaseModel):
    """L0 input: one video, one configuration."""

    video_path: str
    preset: str = Field(default="t2v_generic")
    options: RunOptions = Field(default_factory=RunOptions)

    output_root: str = Field(default="output")

    @computed_field  # type: ignore[prop-decorator]
    @property
    def video_id(self) -> str:
        """Stable short id derived from the resolved path.

        Path-derived rather than content-derived on purpose: hashing a multi-GB
        file just to name an output folder is wasteful. Frame-level dedup still
        happens via `Keyframe.sha256`.
        """
        resolved = str(Path(self.video_path).resolve()).lower()
        return hashlib.sha256(resolved.encode()).hexdigest()[:12]


class StageRecord(BaseModel):
    """Completion record for one stage."""

    stage: StageName
    completed_at: str = Field(default_factory=lambda: datetime.now(UTC).isoformat())
    artifact: str = Field(description="Filename of this stage's output, relative to run dir.")
    duration_s: float = Field(default=0.0, ge=0.0)
    extra: dict[str, Any] = Field(default_factory=dict)
    options_fingerprint: str = Field(
        default="",
        description="Hash of the options that could affect this stage's output. "
        "When it no longer matches the current job, the stage is stale and must "
        "be re-run. Without this, a run at one threshold would silently reuse a "
        "score computed at another.",
    )


def _fingerprint(payload: Any) -> str:
    """Stable hash of an arbitrary JSON-able value."""
    blob = json.dumps(payload, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def stage_fingerprints(options: RunOptions, preset: str) -> dict[StageName, str]:
    """Map each stage to a hash of everything that can change its output.

    The mapping is deliberately explicit rather than "hash the whole options
    object". Hashing everything would be simpler but wrong in the other
    direction: bumping `max_rounds` would needlessly invalidate L2, throwing
    away good work. Each stage is keyed on its true inputs.

    - **parse** depends on nothing optional; the video file is the input, and
      its identity is already encoded in `video_id`.
    - **segment** reads keyframe and segmentation options.
    - **understand** reads what L2 produced, so it inherits L2's inputs.
    - **generate** reads the preset and the frame budget.
    - **evaluate** reads the threshold -- this is the one that matters most in
      practice, because re-gating an existing run at a different threshold is a
      routine operation and must not return the previous verdict.
    """
    seg = _fingerprint(options.segment.model_dump(mode="json"))
    kf = _fingerprint(options.keyframes.model_dump(mode="json"))
    preset_fp = _fingerprint(preset)
    gate = _fingerprint({"threshold": options.quality_threshold})

    return {
        "parse": "static",
        "segment": _fingerprint({"segment": seg, "keyframes": kf}),
        "understand": _fingerprint({"segment": seg, "keyframes": kf}),
        "generate": _fingerprint({"keyframes": kf, "preset": preset_fp}),
        "evaluate": _fingerprint({"gate": gate}),
    }


class RunState(BaseModel):
    """Mutable per-run bookkeeping, persisted after every stage.

    This is the entire resumability story -- no external state store needed.
    """

    run_id: str
    job: Job
    started_at: str = Field(default_factory=lambda: datetime.now(UTC).isoformat())
    completed: dict[StageName, StageRecord] = Field(default_factory=dict)
    round_index: int = Field(default=0, ge=0)
    feedback: str = Field(
        default="",
        description="Diff summary from a failed round, injected into the retry.",
    )
    warnings: list[str] = Field(default_factory=list)

    def is_done(self, stage: StageName) -> bool:
        return stage in self.completed

    def is_stale(self, stage: StageName, fingerprints: dict[StageName, str]) -> bool:
        """True when this stage's recorded inputs no longer match the current job.

        A stage whose fingerprint differs must be re-run even though it is
        marked complete, because its artifact was produced under different
        options and no longer answers the question being asked.
        """
        record = self.completed.get(stage)
        if record is None:
            return False
        expected = fingerprints.get(stage, "")
        return record.options_fingerprint != expected

    def commit(self, record: StageRecord) -> None:
        self.completed[record.stage] = record

    def save(self, run_dir: Path) -> None:
        """Atomic write: temp file then rename, so a crash mid-write cannot
        leave a truncated state file that would block resumption."""
        run_dir.mkdir(parents=True, exist_ok=True)
        target = run_dir / "run_state.json"
        tmp = target.with_suffix(".json.tmp")
        tmp.write_text(self.model_dump_json(indent=2), encoding="utf-8")
        tmp.replace(target)

    @classmethod
    def load(cls, run_dir: Path) -> RunState:
        return cls.model_validate(
            json.loads((run_dir / "run_state.json").read_text(encoding="utf-8"))
        )
