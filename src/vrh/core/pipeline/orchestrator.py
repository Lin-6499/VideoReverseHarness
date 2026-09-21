"""The orchestrator.

A linear state machine over five stages, not a generic DAG engine. The reasoning
is in docs/DESIGN.md; the short version is that the complexity in this system
lives inside the stages, not in the wiring between them, so a heavyweight
orchestrator would add cost without addressing any real risk.

Three behaviours matter most here:

1. **Resumability** -- state is flushed after every stage, so a crash or a Ctrl-C
   costs at most one stage.
2. **Selective rerun** -- `only` and `until` let you rerun a single stage while
   reusing the artifacts of its predecessors.
3. **The quality-gate loop** -- bounded rounds, with the previous round's failure
   summary passed forward so a retry is informed rather than a blind repeat.
"""

from __future__ import annotations

import logging
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from vrh.config import Settings
from vrh.contracts.job import STAGE_ORDER, Job, RunState, StageName, stage_fingerprints
from vrh.contracts.prompt import PromptBundle
from vrh.contracts.score import ScoreReport
from vrh.middleware import (
    CacheMiddleware,
    ComplianceMiddleware,
    CostTracker,
    CostTrackingLLM,
    CostTrackingVision,
    LLMCacheMiddleware,
)
from vrh.middleware.cache import ResponseCache
from vrh.middleware.compliance import ComplianceGuard
from vrh.middleware.retry import RetryMiddleware
from vrh.presets import load_preset
from vrh.providers.registry import Providers, build_providers
from vrh.stages.base import Stage, StageContext, StageResult
from vrh.stages.s1_parse import ParseStage
from vrh.stages.s2_segment import SegmentStage
from vrh.stages.s3_understand import UnderstandStage
from vrh.stages.s4_generate import GenerateStage
from vrh.stages.s5_evaluate import EvaluateStage

log = logging.getLogger(__name__)


@dataclass
class RunOutcome:
    """What a completed run hands back to the caller."""

    run_id: str
    run_dir: Path
    bundle: PromptBundle | None = None
    score: ScoreReport | None = None
    warnings: list[str] = field(default_factory=list)
    rounds: int = 1
    cost_usd: float = 0.0
    latency_s: float = 0.0

    @property
    def passed(self) -> bool:
        """A run passes when there was no gate, or the gate was satisfied."""
        return self.score is None or self.score.passed


def default_stages() -> list[Stage]:
    """Instantiate the stage sequence in execution order."""
    return [
        ParseStage(),
        SegmentStage(),
        UnderstandStage(),
        GenerateStage(),
        EvaluateStage(),
    ]


class Pipeline:
    """Runs the five stages for one job."""

    def __init__(
        self,
        settings: Settings | None = None,
        stages: list[Stage] | None = None,
        providers_factory: Callable[[Settings], Providers] = build_providers,
    ) -> None:
        self.settings = settings or Settings()
        self.stages = stages or default_stages()
        self._providers_factory = providers_factory

        # Validated up front: a typo in the stage list should fail immediately,
        # not halfway through an expensive run.
        names = [s.name for s in self.stages]
        if names != list(STAGE_ORDER):
            raise ValueError(
                f"stage sequence must be exactly {list(STAGE_ORDER)}, got {names}"
            )

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #

    async def run(
        self,
        job: Job,
        *,
        resume: bool = True,
        only: StageName | None = None,
        until: StageName | None = None,
    ) -> RunOutcome:
        """Execute a job.

        Args:
            resume: reuse an existing `run_state.json` when present.
            only: run exactly this one stage, reusing all prior artifacts.
            until: stop after this stage (useful for `--until segment` dry runs).
        """
        settings = self.settings
        preset = load_preset(job.preset)
        run_dir = Path(job.output_root) / job.video_id
        run_dir.mkdir(parents=True, exist_ok=True)

        state = self._init_state(job, run_dir, resume)

        cache = ResponseCache(
            settings.cache.path if settings.cache.enabled else ":memory:",
            ttl_days=settings.cache.ttl_days,
        )
        cost = CostTracker(settings.cost)
        providers = self._wrap_providers(
            self._providers_factory(settings), cache, cost, settings
        )

        ctx = StageContext(
            job=job,
            run_dir=run_dir,
            settings=settings,
            providers=providers,
            preset=preset,
            state=state,
            cost=cost,
            logger=log,
        )

        plan = self._plan(only=only, until=until)
        started = time.perf_counter()

        log.info(
            "run %s | video=%s | stages=%s | providers=%s",
            state.run_id,
            Path(job.video_path).name,
            ",".join(plan),
            providers.describe(),
        )

        try:
            await self._execute_stages(plan, ctx, state, run_dir)
            return self._collect_outcome(ctx, state, run_dir, cost, started)
        finally:
            cache.close()

    async def run_with_gate(
        self,
        job: Job,
        *,
        resume: bool = True,
    ) -> RunOutcome:
        """Run, then apply the quality gate and retry when configured.

        The retry re-runs *only* from L2 onward. L1's output is pure metadata that
        cannot be wrong, so re-parsing it would waste time and could not change
        the outcome.
        """
        outcome = await self.run(job, resume=resume)

        if not job.options.verify or outcome.score is None:
            return outcome
        if outcome.score.passed:
            return outcome

        for round_index in range(1, job.options.max_rounds):
            log.warning(
                "round %d failed the quality gate (aggregate=%.3f < %.2f): %s",
                round_index,
                outcome.score.aggregate,
                job.options.quality_threshold,
                outcome.score.diff_summary,
            )

            run_dir = outcome.run_dir
            state = RunState.load(run_dir)
            state.round_index = round_index
            state.feedback = outcome.score.diff_summary

            # Invalidate L2 onward so they are re-executed with the feedback.
            # Explicit rather than fingerprint-driven: the options have not
            # changed, so nothing would otherwise flag these stages as stale, and
            # the point of a retry round is precisely to redo them.
            for stage_name in ("segment", "understand", "generate", "evaluate"):
                state.completed.pop(stage_name, None)  # type: ignore[arg-type]
            state.save(run_dir)

            outcome = await self.run(job, resume=True)
            outcome.rounds = round_index + 1
            if outcome.score is None or outcome.score.passed:
                return outcome

        log.warning(
            "quality gate still failing after %d rounds; returning best effort",
            job.options.max_rounds,
        )
        return outcome

    # ------------------------------------------------------------------ #
    # Internals
    # ------------------------------------------------------------------ #

    def _init_state(self, job: Job, run_dir: Path, resume: bool) -> RunState:
        state_file = run_dir / "run_state.json"
        if resume and state_file.exists():
            try:
                state = RunState.load(run_dir)
                state.job = job  # adopt the current job spec (options may differ)
                log.info(
                    "resuming run %s (%d stages already complete)",
                    state.run_id,
                    len(state.completed),
                )
                return state
            except Exception as exc:  # noqa: BLE001 - corrupt state should not block
                log.warning("could not load existing run state (%s); starting fresh", exc)

        return RunState(run_id=uuid.uuid4().hex[:12], job=job)

    def _plan(
        self,
        *,
        only: StageName | None,
        until: StageName | None,
    ) -> list[StageName]:
        order = list(STAGE_ORDER)
        if only is not None:
            if only not in order:
                raise ValueError(f"unknown stage '{only}'; valid: {order}")
            return [only]
        if until is not None:
            if until not in order:
                raise ValueError(f"unknown stage '{until}'; valid: {order}")
            return order[: order.index(until) + 1]
        return order

    async def _execute_stages(
        self,
        plan: list[StageName],
        ctx: StageContext,
        state: RunState,
        run_dir: Path,
    ) -> None:
        # Recomputed here rather than stored, so it always reflects the job as
        # currently specified -- which is the whole point of the check.
        fingerprints = stage_fingerprints(state.job.options, state.job.preset)

        for stage in self.stages:
            if stage.name not in plan:
                continue

            if state.is_done(stage.name) and stage.name not in plan[:1]:
                if state.is_stale(stage.name, fingerprints):
                    # Marked complete, but produced under different options. Its
                    # artifact answers a question we are no longer asking, so it
                    # must be rebuilt. Silently reusing it is the failure mode
                    # that makes a harness report a verdict the user did not ask
                    # for.
                    log.info(
                        "re-running '%s' (options changed since last run)",
                        stage.name,
                    )
                else:
                    # A stage is skipped only when it is genuinely already
                    # complete. The first planned stage always runs, so `only=`
                    # forces a rerun.
                    log.info("skipping '%s' (already complete)", stage.name)
                    continue

            # L4 needs shot timecodes, which live in L2's artifact.
            if stage.name == "generate":
                stage.load_spans(ctx)  # type: ignore[attr-defined]

            result: StageResult = await stage.run(ctx)

            # Stamp the fingerprint so a later run can detect this exact kind of
            # staleness. Done here rather than in each stage because the stage
            # does not know which options it actually depends on.
            record = state.completed.get(stage.name)
            if record is not None:
                record.options_fingerprint = fingerprints.get(stage.name, "")

            # Evaluate records the outcome but never blocks; the gate decision
            # belongs to the caller, so a run always completes and a caller can
            # inspect partial results.
            if stage.name == "evaluate":
                log.info("evaluation complete: %s", result.extra)
        ctx.state.save(run_dir)

    def _collect_outcome(
        self,
        ctx: StageContext,
        state: RunState,
        run_dir: Path,
        cost: CostTracker,
        started: float,
    ) -> RunOutcome:
        bundle = self._try_load(run_dir / "prompt.json", PromptBundle)
        score = self._try_load(run_dir / "score.json", ScoreReport)

        if ctx.settings.logging.show_cost:
            cost.log_summary()

        return RunOutcome(
            run_id=state.run_id,
            run_dir=run_dir,
            bundle=bundle,
            score=score,
            warnings=list(state.warnings),
            cost_usd=cost.total_usd,
            latency_s=round(time.perf_counter() - started, 3),
        )

    @staticmethod
    def _try_load(path: Path, model):
        if not path.exists():
            return None
        try:
            return model.model_validate_json(path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            log.warning("could not parse %s: %s", path.name, exc)
            return None

    def _wrap_providers(
        self,
        providers: Providers,
        cache: ResponseCache,
        cost: CostTracker,
        settings: Settings,
    ) -> Providers:
        """Compose the middleware chain around each provider.

        Order, outermost first:

            Cache(Retry(Compliance(Cost(RawProvider))))

        Read innermost-first, that is `Cost -> Compliance -> Retry -> Cache`.
        Every link in that order is load-bearing:

        - **Cost innermost.** It must observe only *real* provider calls. If it
          sat outside the cache it would charge for cache hits, and the whole
          point of the cache is that a hit costs nothing. This ordering is what
          makes a warm rerun report `$0.000` instead of repeating the cost.
        - **Compliance above Cost.** The scrubbed value is what gets cached, so
          a cached value can never reintroduce unscrubbed data. Costs are still
          measured on the real call that produced the value.
        - **Retry above Compliance.** A retry re-enters compliance and cost, so
          a transient failure neither skips scrubbing nor goes unbilled.
        - **Cache outermost.** A hit short-circuits retry, compliance and cost
          entirely, which is what makes a rerun cheap.
        """
        vision = providers.vision

        # Innermost: observe only genuine provider calls.
        if settings.cost.track:
            vision = CostTrackingVision(vision, cost)

        if settings.compliance.enabled:
            vision = ComplianceMiddleware(vision, ComplianceGuard(settings.compliance))

        vision = RetryMiddleware(
            vision,
            max_retries=settings.providers.vision.max_retries,
        )

        if settings.cache.enabled:
            vision = CacheMiddleware(
                vision,
                cache,
                model_id=settings.providers.vision.name,
                temperature=settings.providers.vision.temperature,
            )

        llm = providers.llm
        if settings.cost.track:
            llm = CostTrackingLLM(llm, cost)
        if settings.cache.enabled:
            llm = LLMCacheMiddleware(
                llm,
                cache,
                model_id=settings.providers.llm.name,
            )

        return Providers(
            vision=vision,
            llm=llm,
            asr=providers.asr,
            embedding=providers.embedding,
        )
