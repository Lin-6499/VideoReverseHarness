"""Contract-level tests.

These run with no ffmpeg, no network and no model access. They cover the logic
most likely to break silently: aspect-ratio derivation, timecode validation,
prompt rendering and the aggregate score.
"""

from __future__ import annotations

import pytest

from vrh.contracts.job import Job, RunOptions, RunState, StageRecord
from vrh.contracts.media import MediaMeta
from vrh.contracts.prompt import PromptBundle, ShotPrompt
from vrh.contracts.score import ScoreReport, ShotScore
from vrh.contracts.segment import Keyframe, MotionDescriptor, Shot, ShotSet
from vrh.presets import load_preset


def make_meta(**overrides) -> MediaMeta:
    base = {
        "path": "x.mp4",
        "duration_s": 10.0,
        "fps": 30.0,
        "width": 1920,
        "height": 1080,
        "codec": "h264",
        "audio_codec": "aac",
    }
    base.update(overrides)
    return MediaMeta(**base)


class TestAspectRatio:
    """Rotation is the classic silent-corruption source, so it gets real tests."""

    def test_landscape_is_reported_directly(self):
        assert make_meta().aspect_ratio == "16:9"

    def test_rotation_swaps_display_dimensions(self):
        meta = make_meta(width=1920, height=1080, rotation=90)
        assert meta.display_width == 1080
        assert meta.display_height == 1920
        assert meta.orientation == "portrait"
        assert meta.aspect_ratio == "9:16"

    def test_rotation_180_preserves_orientation(self):
        meta = make_meta(rotation=180)
        assert meta.orientation == "landscape"
        assert meta.aspect_ratio == "16:9"

    def test_encoders_rounding_is_snapped(self):
        # 1080x1918 is what some encoders emit for 9:16; it must not be reported
        # as a bizarre ratio.
        meta = make_meta(width=1080, height=1918)
        assert meta.aspect_ratio == "9:16"

    def test_square(self):
        assert make_meta(width=1000, height=1000).aspect_ratio == "1:1"

    def test_non_standard_ratio_is_reduced(self):
        assert make_meta(width=1000, height=700).aspect_ratio == "10:7"


class TestMediaFlags:
    def test_has_audio_false_when_no_track(self):
        assert make_meta(audio_codec=None).has_audio is False

    def test_vfr_risk_for_fractional_fps(self):
        assert make_meta(fps=29.97).is_vfr_risk is True

    def test_no_vfr_risk_for_integer_fps(self):
        assert make_meta(fps=30.0).is_vfr_risk is False


class TestShotValidation:
    def test_end_before_start_is_rejected(self):
        with pytest.raises(ValueError, match="must exceed"):
            Shot(shot_id=1, start_s=5.0, end_s=2.0)

    def test_duration_and_keyframe_paths(self):
        shot = Shot(
            shot_id=1,
            start_s=0.0,
            end_s=2.0,
            keyframes=[
                Keyframe(
                    frame_index=0, timestamp_s=0.1, path="/a.jpg",
                    sha256="a" * 16, width=100, height=100,
                )
            ],
        )
        assert shot.duration_s == 2.0
        assert shot.keyframe_paths == ["/a.jpg"]


class TestShotContext:
    def test_neighbours_are_resolved(self):
        shots = [Shot(shot_id=i, start_s=float(i), end_s=float(i + 1)) for i in (1, 2, 3)]
        shot_set = ShotSet(video_path="x.mp4", shots=shots)

        first = shot_set.context_for(shots[0])
        assert first.prev_shot_id is None and first.next_shot_id == 2

        middle = shot_set.context_for(shots[1])
        assert middle.prev_shot_id == 1 and middle.next_shot_id == 3

        last = shot_set.context_for(shots[2])
        assert last.prev_shot_id == 2 and last.next_shot_id is None

    def test_motion_hint_is_carried_through(self):
        shot = Shot(
            shot_id=1, start_s=0, end_s=1,
            motion=MotionDescriptor(dominant="dolly_in", confidence=0.9),
        )
        ctx = ShotSet(video_path="x.mp4", shots=[shot]).context_for(shot)
        assert ctx.motion_hint == "dolly_in"


class TestPresetRendering:
    def test_slots_render_in_declared_order(self):
        preset = load_preset("t2v_generic")
        text = preset.render_slots(
            {
                "subject": "a woman in a red coat",
                "action": "walking forward",
                "scene": "a rainy street",
                "camera": "medium shot, push in",
                "lighting": "low key warm",
                "style": "film grain",
            }
        )
        assert text.index("a woman") < text.index("walking")
        assert "camera: medium shot, push in" in text
        assert "lighting: low key warm" in text

    def test_empty_slots_are_dropped(self):
        preset = load_preset("t2v_generic")
        text = preset.render_slots({"subject": "a dog", "action": "", "scene": ""})
        assert text == "a dog"

    def test_unknown_slots_are_ignored(self):
        # A stage adding a new field must not silently bloat prompts for presets
        # that predate it.
        preset = load_preset("t2v_generic")
        text = preset.render_slots({"subject": "a dog", "brand_new_field": "leak"})
        assert "leak" not in text

    def test_length_cap_truncates_on_boundary(self):
        preset = load_preset("t2v_generic")
        preset.constraints.max_prompt_chars = 30
        text = preset.render_slots({"subject": "x" * 100, "action": "y" * 100})
        assert len(text) <= 30

    def test_motion_mapping(self):
        assert load_preset("t2v_generic").map_motion("dolly_in") == "push in"

    def test_i2v_leads_with_motion(self):
        preset = load_preset("i2v_generic")
        assert preset.slot_order[0] == "action"


class TestPromptBundle:
    def _bundle(self) -> PromptBundle:
        return PromptBundle(
            video_path="x.mp4",
            global_prompt="g",
            style_anchor="s",
            shots=[
                ShotPrompt(shot_id=1, start_s=0, end_s=2, prompt="p1", duration_s=2),
                ShotPrompt(shot_id=2, start_s=2, end_s=4, prompt="p2", duration_s=2),
            ],
        )

    def test_flat_text_includes_every_shot(self):
        text = self._bundle().to_flat_text()
        assert "p1" in text and "p2" in text

    def test_timecode_formatting(self):
        assert self._bundle().shots[0].timecode == "0.00-2.00s"


class TestScoreReport:
    def test_aggregate_uses_available_signals_only(self):
        report = ScoreReport(
            run_id="r", video_path="x.mp4",
            mean_clip_similarity=0.8, boundary_f1=0.9, mean_field_accuracy=0.85,
        )
        # Weights: clip .5, boundary .2, fields .3 -> ((0.8+1)/2*.5 + .9*.2 + .85*.3)/1.0
        expected = ((0.8 + 1) / 2 * 0.5 + 0.9 * 0.2 + 0.85 * 0.3) / 1.0
        assert report.aggregate == pytest.approx(expected)

    def test_missing_signals_are_excluded_not_zeroed(self):
        # A missing signal must not drag the score down. Two reports identical
        # except for one absent signal should differ.
        with_clip = ScoreReport(run_id="r", video_path="x", mean_clip_similarity=1.0)
        without = ScoreReport(run_id="r", video_path="x", boundary_f1=0.5)
        assert with_clip.aggregate == pytest.approx(1.0)
        assert without.aggregate == pytest.approx(0.5)

    def test_no_signals_scores_zero(self):
        assert ScoreReport(run_id="r", video_path="x").aggregate == 0.0

    def test_pass_requires_schema_and_threshold(self):
        passing = ScoreReport(
            run_id="r", video_path="x", mean_clip_similarity=0.9, threshold=0.7
        )
        assert passing.passed is True

        failing = ScoreReport(
            run_id="r", video_path="x", mean_clip_similarity=0.9,
            threshold=0.7, schema_valid=False,
        )
        assert failing.passed is False

    def test_review_count(self):
        report = ScoreReport(
            run_id="r", video_path="x",
            shot_scores=[
                ShotScore(shot_id=1, needs_review=True),
                ShotScore(shot_id=2, needs_review=False),
                ShotScore(shot_id=3, needs_review=True),
            ],
        )
        assert report.review_count == 2

    def test_diff_summary_is_empty_when_passing(self):
        report = ScoreReport(
            run_id="r", video_path="x", mean_clip_similarity=0.95, threshold=0.7
        )
        assert report.diff_summary == ""

    def test_diff_summary_names_the_failing_layer(self):
        report = ScoreReport(
            run_id="r", video_path="x", boundary_f1=0.4,
            mean_clip_similarity=0.9, threshold=0.99,
        )
        summary = report.diff_summary
        assert "boundaries" in summary


class TestRunState:
    def test_round_trip_persistence(self, tmp_path):
        job = Job(video_path="x.mp4", output_root=str(tmp_path))
        state = RunState(run_id="abc123", job=job)
        state.commit(StageRecord(stage="parse", artifact="meta.json"))
        state.save(tmp_path)

        reloaded = RunState.load(tmp_path)
        assert reloaded.run_id == "abc123"
        assert reloaded.is_done("parse")
        assert not reloaded.is_done("segment")

    def test_save_is_atomic_leaving_no_temp_file(self, tmp_path):
        state = RunState(run_id="a", job=Job(video_path="x.mp4"))
        state.save(tmp_path)
        assert not (tmp_path / "run_state.json.tmp").exists()
        assert (tmp_path / "run_state.json").exists()


class TestJobIdentity:
    def test_same_path_same_id(self):
        a = Job(video_path="videos/a.mp4")
        b = Job(video_path="videos/a.mp4")
        assert a.video_id == b.video_id

    def test_different_path_different_id(self):
        assert Job(video_path="a.mp4").video_id != Job(video_path="b.mp4").video_id

    def test_id_is_stable_across_path_spellings(self, tmp_path):
        target = tmp_path / "clip.mp4"
        assert Job(video_path=str(target)).video_id == Job(
            video_path=str(target) + ""
        ).video_id


class TestRunOptions:
    def test_defaults_are_conservative(self):
        opts = RunOptions()
        assert opts.verify is False  # gating is opt-in
        assert opts.max_rounds == 1  # no silent retry spend
        assert opts.keyframes.max_per_shot <= 4
