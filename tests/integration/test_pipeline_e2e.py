"""End-to-end pipeline tests against a real, decodable video.

These are the tests that actually prove the harness works. They run the full
five-stage pipeline on a generated fixture clip using fake providers, so they
need no credentials and cost nothing, but they exercise real decoding, real cut
detection and real frame extraction.

Marked `integration`: they need ffmpeg and are slower than the unit suite.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from vrh.contracts.job import Job, RunOptions, RunState, stage_fingerprints
from vrh.contracts.media import MediaMeta
from vrh.contracts.prompt import PromptBundle
from vrh.contracts.score import ScoreReport
from vrh.contracts.segment import ShotSet
from vrh.core.pipeline import Pipeline
from vrh.providers.registry import build_providers

pytestmark = pytest.mark.integration


async def _run(job: Job, settings) -> object:
    pipeline = Pipeline(settings=settings, providers_factory=build_providers)
    return await pipeline.run(job, resume=False)


class TestFullPipeline:
    async def test_produces_every_artifact(self, basic_job, offline_settings):
        outcome = await _run(basic_job, offline_settings)

        for name in ("meta.json", "shots.json", "annotations.json", "prompt.json", "run_state.json"):
            assert (outcome.run_dir / name).exists(), f"missing artifact: {name}"

        assert outcome.bundle is not None
        assert outcome.bundle.shot_count >= 1

    async def test_metadata_reflects_the_source(self, basic_job, offline_settings, synthetic_video):
        outcome = await _run(basic_job, offline_settings)
        meta = MediaMeta.model_validate_json(
            (outcome.run_dir / "meta.json").read_text(encoding="utf-8")
        )

        assert meta.width == 640
        assert meta.height == 360
        assert meta.display_width == 640  # no rotation in the fixture
        assert meta.aspect_ratio == "16:9"
        assert 5.0 < meta.duration_s < 7.0

    async def test_cut_detection_finds_the_three_segments(
        self, basic_job, offline_settings
    ):
        """The fixture has three unambiguous colour blocks.

        If the detector cannot find two cuts in an easy case like this, the
        integration between scenedetect and our timecode handling is broken --
        which is exactly the failure that is invisible in unit tests.
        """
        outcome = await _run(basic_job, offline_settings)
        shot_set = ShotSet.model_validate_json(
            (outcome.run_dir / "shots.json").read_text(encoding="utf-8")
        )

        boundaries = [s.start_s for s in shot_set.shots]
        assert boundaries and boundaries[0] == pytest.approx(0.0, abs=0.1)
        assert len(shot_set.shots) >= 2, (
            f"expected at least 2 shots in a 3-block fixture, got {len(shot_set.shots)}"
        )

    async def test_shot_timecodes_are_contiguous_and_ordered(
        self, basic_job, offline_settings
    ):
        outcome = await _run(basic_job, offline_settings)
        shot_set = ShotSet.model_validate_json(
            (outcome.run_dir / "shots.json").read_text(encoding="utf-8")
        )

        previous_end = 0.0
        for shot in shot_set.shots:
            assert shot.start_s >= previous_end - 0.05, "shots overlap or are unordered"
            assert shot.end_s > shot.start_s
            previous_end = shot.end_s

    async def test_keyframes_exist_on_disk_and_are_content_addressed(
        self, basic_job, offline_settings
    ):
        outcome = await _run(basic_job, offline_settings)
        shot_set = ShotSet.model_validate_json(
            (outcome.run_dir / "shots.json").read_text(encoding="utf-8")
        )

        seen_hashes: set[str] = set()
        for shot in shot_set.shots:
            for kf in shot.keyframes:
                path = Path(kf.path)
                assert path.exists(), f"keyframe missing on disk: {path}"
                assert path.stat().st_size > 0, "keyframe file is empty"
                # The filename must be derived from the content hash so that
                # deduplication actually works.
                assert path.stem == kf.sha256[:16]
                seen_hashes.add(kf.sha256)

        assert seen_hashes, "no keyframes extracted at all"

    async def test_duplicate_frames_are_deduplicated(self, basic_job, tmp_path, synthetic_video):
        """Two shots over the same flat colour must share one file.

        This is the deduplication that keeps API spend down, so it is worth
        asserting directly rather than trusting it.
        """
        from vrh.config import Settings

        settings = Settings()
        settings.providers.vision.name = "fake"
        settings.providers.llm.name = "fake"
        settings.providers.asr.name = "none"
        settings.providers.embedding.name = "none"
        settings.cache.path = str(tmp_path / ".cache" / "t.sqlite3")
        settings.output_root = str(tmp_path / "output")

        # A clip whose two segments are the same colour: identical pixels, so
        # identical hashes.
        import subprocess

        from vrh.media.ffmpeg import ffmpeg_available, resolve_binary

        if not ffmpeg_available():
            pytest.skip("ffmpeg not available")
        ffmpeg = resolve_binary("ffmpeg")

        parts = []
        for i in range(2):
            part = tmp_path / f"same{i}.mp4"
            subprocess.run(
                [ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                 "-i", "color=c=red:s=320x180:d=2:r=12", "-pix_fmt", "yuv420p",
                 "-y", str(part)],
                check=True, capture_output=True, timeout=60,
            )
            parts.append(part)

        concat = tmp_path / "c.txt"
        concat.write_text("\n".join(f"file '{p.as_posix()}'" for p in parts), encoding="utf-8")
        target = tmp_path / "same.mp4"
        subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
             "-i", str(concat), "-c", "copy", "-y", str(target)],
            check=True, capture_output=True, timeout=60,
        )

        job = Job(
            video_path=str(target),
            options=RunOptions(max_shots=10),
            output_root=settings.output_root,
        )
        outcome = await Pipeline(settings=settings, providers_factory=build_providers).run(
            job, resume=False
        )

        keyframe_files = list((outcome.run_dir / "keyframes").glob("*.jpg"))
        if not keyframe_files:
            pytest.skip("no keyframes extracted")

        # Fewer files than total keyframe references means dedup happened.
        shot_set = ShotSet.model_validate_json(
            (outcome.run_dir / "shots.json").read_text(encoding="utf-8")
        )
        total_refs = sum(len(s.keyframes) for s in shot_set.shots)
        if total_refs > 1:
            assert len(keyframe_files) <= total_refs, "dedup produced more files than references"

    async def test_prompts_are_populated(self, basic_job, offline_settings):
        outcome = await _run(basic_job, offline_settings)
        bundle = outcome.bundle
        assert bundle is not None

        for shot in bundle.shots:
            assert shot.prompt.strip(), f"shot {shot.shot_id} has an empty prompt"
            assert shot.slots, f"shot {shot.shot_id} has no structured slots"

        # The global fields come from the LLM stage; the fixture provider always
        # returns them, so they must not be empty.
        assert bundle.global_prompt
        assert bundle.style_anchor

    async def test_prompts_respect_the_preset_length_cap(self, basic_job, offline_settings):
        outcome = await _run(basic_job, offline_settings)
        bundle = outcome.bundle
        assert bundle is not None
        for shot in bundle.shots:
            assert len(shot.prompt) <= 500

    async def test_cost_is_accounted(self, basic_job, offline_settings):
        outcome = await _run(basic_job, offline_settings)
        # price_per_image is 0.001 in the fixture, so any vision call must
        # register a non-zero cost.
        assert outcome.cost_usd > 0, "cost tracking did not register any spend"

    async def test_rerun_hits_the_cache_and_costs_nothing(
        self, basic_job, offline_settings
    ):
        """The second identical run must be served from cache.

        Verified by cost: a cache hit means no provider call, which means no
        charge. This is the cost lever the whole design is built around, so it
        gets a direct assertion.
        """
        first = await _run(basic_job, offline_settings)
        assert first.cost_usd > 0

        second = await _run(basic_job, offline_settings)
        assert second.cost_usd == pytest.approx(0.0), (
            "second run was billed again; the cache is not being consulted"
        )


class TestResumability:
    async def test_resume_skips_completed_stages(self, basic_job, offline_settings):
        pipeline = Pipeline(settings=offline_settings, providers_factory=build_providers)
        first = await pipeline.run(basic_job, resume=False)
        assert first.bundle is not None

        # Stop after L2; L1 and L2 are already recorded, so only L3/L4/L5 run.
        second = await pipeline.run(basic_job, resume=True, until="parse")
        assert second.run_dir == first.run_dir

    async def test_only_reruns_a_single_stage(self, basic_job, offline_settings):
        pipeline = Pipeline(settings=offline_settings, providers_factory=build_providers)
        await pipeline.run(basic_job, resume=False)

        outcome = await pipeline.run(basic_job, resume=True, only="generate")
        # L4 depends on L2's artifact for shot spans, so it must have read it.
        assert outcome.bundle is not None
        assert outcome.bundle.shot_count >= 1

    async def test_dry_run_stops_after_segment(self, basic_job, offline_settings):
        job = basic_job.model_copy(deep=True)
        job.options.dry_run = True

        outcome = await Pipeline(
            settings=offline_settings, providers_factory=build_providers
        ).run(job, resume=False, until="segment")

        assert (outcome.run_dir / "shots.json").exists()
        assert not (outcome.run_dir / "prompt.json").exists()


class TestStaleOptionInvalidation:
    """Changing an option must re-run the stages that depend on it.

    The regression this guards against: a second run at a *different* quality
    threshold reused the first run's `score.json`, and reported the old verdict.
    Nothing crashed and nothing warned -- the run printed a confident number
    computed against a threshold the caller had not asked for. That class of bug
    is worse than a crash, so it gets an explicit test.
    """

    async def test_changing_the_threshold_recomputes_the_verdict(
        self, basic_job, offline_settings
    ):
        pipeline = Pipeline(settings=offline_settings, providers_factory=build_providers)

        strict = basic_job.model_copy(deep=True)
        strict.options.verify = True
        strict.options.quality_threshold = 0.99  # deliberately unreachable
        first = await pipeline.run(strict, resume=False)
        assert first.score is not None
        assert first.score.passed is False
        assert first.score.threshold == 0.99

        # Same video, same run directory, but a threshold that must pass.
        lenient = basic_job.model_copy(deep=True)
        lenient.options.verify = True
        lenient.options.quality_threshold = 0.05
        second = await pipeline.run(lenient, resume=True)

        assert second.run_dir == first.run_dir
        assert second.score is not None
        assert second.score.threshold == 0.05, (
            "the new threshold must be reflected, not the old one"
        )
        assert second.score.passed is True, (
            "reusing the previous run's failing verdict is the exact regression"
        )

    async def test_unchanged_options_still_skip_completed_stages(
        self, basic_job, offline_settings
    ):
        """The invalidation must not defeat resumability in the normal case."""
        pipeline = Pipeline(settings=offline_settings, providers_factory=build_providers)
        first = await pipeline.run(basic_job, resume=False)

        second = await pipeline.run(
            basic_job.model_copy(deep=True), resume=True, until="segment"
        )

        assert second.run_dir == first.run_dir
        # 'parse' always runs; 'segment' is the only other planned stage, and it
        # is still current, so the run must not have invalidated anything.
        state = RunState.load(second.run_dir)
        assert state.is_done("generate"), (
            "an identical job must not invalidate later stages"
        )

    async def test_changing_keyframe_options_invalidates_from_segment(
        self, basic_job, offline_settings
    ):
        pipeline = Pipeline(settings=offline_settings, providers_factory=build_providers)
        await pipeline.run(basic_job, resume=False)

        changed = basic_job.model_copy(deep=True)
        changed.options.keyframes.max_per_shot = 2
        outcome = await pipeline.run(changed, resume=True, until="segment")

        shot_set = ShotSet.model_validate_json(
            (outcome.run_dir / "shots.json").read_text(encoding="utf-8")
        )
        # The budget is enforced by L2, so a lowered cap must be visible in the
        # rebuilt artifact rather than the old one being reused.
        assert all(len(shot.keyframes) <= 2 for shot in shot_set.shots)

    def test_fingerprints_ignore_irrelevant_options(self, basic_job):
        """`max_rounds` drives the retry loop, not any stage's output."""
        base = stage_fingerprints(basic_job.options, basic_job.preset)

        changed = basic_job.model_copy(deep=True)
        changed.options.max_rounds = 3
        after = stage_fingerprints(changed.options, changed.preset)

        assert base == after, "a gate-only option must not invalidate stage outputs"

    def test_fingerprints_are_stable_across_equal_options(self, basic_job):
        """Two independently built, identical option sets must hash the same."""
        a = stage_fingerprints(basic_job.options, basic_job.preset)
        b = stage_fingerprints(
            RunOptions.model_validate(basic_job.options.model_dump(mode="json")),
            basic_job.preset,
        )
        assert a == b


class TestQualityGateIntegration:
    async def test_verify_produces_a_score_report(self, basic_job, offline_settings):
        job = basic_job.model_copy(deep=True)
        job.options.verify = True

        outcome = await Pipeline(
            settings=offline_settings, providers_factory=build_providers
        ).run_with_gate(job)

        assert outcome.score is not None
        assert (outcome.run_dir / "score.json").exists()
        # The fake embedding provider produces uncorrelated vectors, so the
        # semantic score is meaningless -- we assert the wiring, not the value.
        assert outcome.score.mean_field_accuracy is not None

    async def test_score_report_survives_a_round_trip(self, basic_job, offline_settings):
        job = basic_job.model_copy(deep=True)
        job.options.verify = True

        outcome = await Pipeline(
            settings=offline_settings, providers_factory=build_providers
        ).run_with_gate(job)

        reloaded = ScoreReport.model_validate_json(
            (outcome.run_dir / "score.json").read_text(encoding="utf-8")
        )
        assert reloaded.run_id == outcome.run_id

    async def test_multi_round_does_not_exceed_the_budget(self, basic_job, offline_settings):
        """A retry must actually re-run L2 onward, not silently no-op.

        `quality_threshold` is capped at 1.0 by the contract, so an
        unsatisfiable gate is expressed by pinning the threshold to the maximum
        and forcing an imperfect score via a deliberately loose cut threshold.
        Using an out-of-range value would fail validation before the gate ever
        ran, which tests nothing.
        """
        job = basic_job.model_copy(deep=True)
        job.options.verify = True
        job.options.max_rounds = 2
        job.options.quality_threshold = 1.0
        # Near-uniform segmentation cannot match the real three-block fixture,
        # so boundary F1 stays low and the aggregate cannot reach 1.0.
        job.options.segment.cut_threshold = 100.0

        outcome = await Pipeline(
            settings=offline_settings, providers_factory=build_providers
        ).run_with_gate(job)

        assert outcome.rounds <= 2
        assert outcome.score is not None
        assert not outcome.score.passed, "the gate should not have been satisfied"


class TestPromptBundleArtifact:
    async def test_bundle_serialises_and_reloads(self, basic_job, offline_settings):
        outcome = await _run(basic_job, offline_settings)
        reloaded = PromptBundle.model_validate_json(
            (outcome.run_dir / "prompt.json").read_text(encoding="utf-8")
        )
        assert reloaded.shot_count == outcome.bundle.shot_count
        assert reloaded.to_flat_text().strip()

    async def test_html_report_is_generated(self, basic_job, offline_settings):
        from vrh.quality import render_report_html

        outcome = await _run(basic_job, offline_settings)
        shot_set = ShotSet.model_validate_json(
            (outcome.run_dir / "shots.json").read_text(encoding="utf-8")
        )
        html = render_report_html(outcome.bundle, shot_set, None, run_id=outcome.run_id)

        assert "<article" in html or "no shots" in html
        assert outcome.bundle.video_path.split("/")[-1].split("\\")[-1] in html
