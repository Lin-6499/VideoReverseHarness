"""Stage base types.

A stage receives a `StageContext` (job, paths, providers, config) and returns a
`StageResult` (artifact path plus optional extras for run state). Nothing else is
shared, so a stage can be unit-tested by constructing a context by hand.
"""

from __future__ import annotations

import json
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Generic, TypeVar

from pydantic import BaseModel, Field

from vrh.config import Settings
from vrh.contracts.job import Job, RunState, StageRecord
from vrh.middleware import CostTracker
from vrh.presets import Preset
from vrh.providers.registry import Providers

T = TypeVar("T", bound=BaseModel)


@dataclass
class StageContext:
    """Everything a stage needs, and nothing more."""

    job: Job
    run_dir: Path
    settings: Settings
    providers: Providers
    preset: Preset
    state: RunState
    cost: CostTracker
    logger: Any = None
    # Plain dataclass field: `description` is not a dataclass kwarg, so the
    # rationale lives here rather than in the field() call.
    # Set by the orchestrator from RunState.feedback on a retry round; only L2
    # reads it, to adjust its cut threshold.
    feedback: str = ""

    @property
    def keyframe_dir(self) -> Path:
        return self.run_dir / "keyframes"

    @property
    def frame_dir(self) -> Path:
        return self.run_dir / "frames"


class StageResult(BaseModel):
    """Outcome of one stage execution."""

    artifact: str
    duration_s: float = 0.0
    extra: dict[str, Any] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)

    model_config = {"arbitrary_types_allowed": True}


class Stage(ABC, Generic[T]):
    """One step of the pipeline."""

    name: str
    artifact_name: str
    output_model: type[T]

    @abstractmethod
    async def execute(self, ctx: StageContext) -> tuple[T, StageResult]:
        """Produce this stage's output. Must not write artifacts itself --
        `run` handles persistence uniformly so every stage behaves identically."""

    async def run(self, ctx: StageContext) -> StageResult:
        """Execute and persist, recording timing and artifact location."""
        started = time.perf_counter()
        output, result = await self.execute(ctx)

        result.artifact = self.artifact_name
        result.duration_s = round(time.perf_counter() - started, 3)

        self.write_artifact(ctx, output)

        ctx.state.commit(
            StageRecord(
                stage=self.name,  # type: ignore[arg-type]
                artifact=self.artifact_name,
                duration_s=result.duration_s,
                extra=dict(result.extra),
            )
        )
        ctx.state.warnings.extend(result.warnings)
        ctx.state.save(ctx.run_dir)

        if ctx.logger:
            ctx.logger.info(
                "stage '%s' complete in %.2fs -> %s",
                self.name,
                result.duration_s,
                self.artifact_name,
            )
        return result

    def write_artifact(self, ctx: StageContext, output: T) -> Path:
        """Write JSON atomically so a crash cannot leave a half-written file
        that would be mistaken for a complete artifact on resume."""
        target = ctx.run_dir / self.artifact_name
        tmp = target.with_suffix(target.suffix + ".tmp")
        tmp.write_text(output.model_dump_json(indent=2), encoding="utf-8")
        tmp.replace(target)
        return target

    @staticmethod
    def read_artifact(ctx: StageContext, model: type[T], filename: str) -> T:
        """Read a previously written artifact back into its model."""
        path = ctx.run_dir / filename
        if not path.exists():
            raise FileNotFoundError(
                f"artifact '{filename}' missing in {ctx.run_dir}. "
                "Re-run the stage that produces it, or delete run_state.json to "
                "start fresh."
            )
        return model.model_validate(json.loads(path.read_text(encoding="utf-8")))
