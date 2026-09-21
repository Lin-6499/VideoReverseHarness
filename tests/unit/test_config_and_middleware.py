"""Tests for configuration merging, caching, compliance and the quality gate.

These are the mechanisms that are hard to reason about by reading and easy to
verify mechanically.
"""

from __future__ import annotations

import pytest

from vrh.config import Settings, _apply_env_overrides, _deep_merge, load_settings
from vrh.contracts.annotation import ShotAnnotation
from vrh.contracts.score import ScoreReport, ShotScore
from vrh.middleware.cache import ResponseCache
from vrh.middleware.compliance import ComplianceGuard
from vrh.quality.gate import QualityGate


class TestDeepMerge:
    def test_nested_dicts_merge_rather_than_replace(self):
        base = {"a": {"x": 1, "y": 2}}
        override = {"a": {"y": 3}}
        assert _deep_merge(base, override) == {"a": {"x": 1, "y": 3}}

    def test_original_is_not_mutated(self):
        base = {"a": {"x": 1}}
        _deep_merge(base, {"a": {"x": 2}})
        assert base == {"a": {"x": 1}}

    def test_scalars_replace(self):
        assert _deep_merge({"a": 1}, {"a": 2}) == {"a": 2}


class TestEnvOverrides:
    def test_double_underscore_nests(self):
        result = _apply_env_overrides({}, {"VRH_PROVIDERS__VISION__NAME": "openai_vlm"})
        assert result["providers"]["vision"]["name"] == "openai_vlm"

    def test_values_are_type_coerced(self):
        result = _apply_env_overrides(
            {},
            {"VRH_CACHE__ENABLED": "false", "VRH_PROVIDERS__VISION__MAX_RETRIES": "7"},
        )
        assert result["cache"]["enabled"] is False
        assert result["providers"]["vision"]["max_retries"] == 7

    def test_non_prefixed_vars_are_ignored(self):
        assert _apply_env_overrides({}, {"PATH": "/usr/bin"}) == {}

    def test_creates_missing_intermediate_dicts(self):
        result = _apply_env_overrides({}, {"VRH_A__B__C": "1"})
        assert result["a"]["b"]["c"] == 1


class TestLoadSettings:
    def test_layered_merge(self, tmp_path):
        (tmp_path / "presets").mkdir()
        (tmp_path / "default.yaml").write_text(
            "providers:\n  vision:\n    name: fake\n  llm:\n    name: fake\n"
            "cache:\n  enabled: true\ncache2: 1\n",
            encoding="utf-8",
        )
        (tmp_path / "presets" / "custom.yaml").write_text(
            "providers:\n  vision:\n    name: openai_vlm\n", encoding="utf-8"
        )

        settings = load_settings(config_dir=tmp_path, preset="custom", env={})
        assert settings.providers.vision.name == "openai_vlm"
        assert settings.providers.llm.name == "fake"  # untouched sibling survives
        assert settings.preset == "custom"

    def test_missing_files_fall_back_to_defaults(self, tmp_path):
        # A bare checkout with no configs must still produce a usable Settings.
        settings = load_settings(config_dir=tmp_path, env={})
        assert isinstance(settings, Settings)
        assert settings.providers.vision.name == "fake"

    def test_env_beats_files(self, tmp_path):
        (tmp_path / "default.yaml").write_text(
            "providers:\n  vision:\n    name: fake\n", encoding="utf-8"
        )
        settings = load_settings(
            config_dir=tmp_path,
            env={"VRH_PROVIDERS__VISION__NAME": "openai_vlm"},
        )
        assert settings.providers.vision.name == "openai_vlm"


class TestResponseCache:
    def test_round_trip(self, tmp_path):
        cache = ResponseCache(tmp_path / "c.sqlite3")
        cache.put("k", {"v": 1})
        assert cache.get("k") == {"v": 1}
        cache.close()

    def test_miss_returns_none(self, tmp_path):
        cache = ResponseCache(tmp_path / "c.sqlite3")
        assert cache.get("absent") is None
        cache.close()

    def test_key_is_order_independent_for_dicts(self, tmp_path):
        # Dict key order must not change the cache key, or we would silently miss.
        k1 = ResponseCache.make_key("vision", {"a": 1, "b": 2})
        k2 = ResponseCache.make_key("vision", {"b": 2, "a": 1})
        assert k1 == k2

    def test_key_separates_different_part_boundaries(self):
        # ('ab','c') must differ from ('a','bc').
        assert ResponseCache.make_key("ab", "c") != ResponseCache.make_key("a", "bc")

    def test_key_includes_all_parts(self):
        assert ResponseCache.make_key("a", "b") != ResponseCache.make_key("a", "c")

    def test_hit_rate_tracking(self, tmp_path):
        cache = ResponseCache(tmp_path / "c.sqlite3")
        cache.put("k", 1)
        cache.get("k")  # hit
        cache.get("nope")  # miss
        assert cache.hit_rate == pytest.approx(0.5)
        cache.close()

    def test_persistence_across_instances(self, tmp_path):
        path = tmp_path / "c.sqlite3"
        first = ResponseCache(path)
        first.put("k", {"v": 42})
        first.close()

        second = ResponseCache(path)
        assert second.get("k") == {"v": 42}
        second.close()


class TestComplianceGuard:
    def _guard(self) -> ComplianceGuard:
        from vrh.config import ComplianceConfig

        return ComplianceGuard(ComplianceConfig())

    def test_identity_claim_is_genericised(self):
        guard = self._guard()
        ann = ShotAnnotation(shot_id=1, subject="this is John Smith")
        assert "John Smith" not in guard.scrub(ann).subject

    def test_generic_descriptors_survive(self):
        # The guard must not censor legitimate appearance descriptions, or the
        # tool becomes useless for real footage.
        guard = self._guard()
        ann = ShotAnnotation(shot_id=1, subject="a woman in a red coat")
        assert guard.scrub(ann).subject == "a woman in a red coat"

    def test_document_text_is_stripped(self):
        guard = self._guard()
        ann = ShotAnnotation(shot_id=1, on_screen_text=["passport number 123"])
        assert guard.scrub(ann).on_screen_text == []

    def test_input_is_not_mutated(self):
        guard = self._guard()
        ann = ShotAnnotation(shot_id=1, subject="this is John Smith")
        guard.scrub(ann)
        assert ann.subject == "this is John Smith"

    def test_disabled_guard_is_a_passthrough(self):
        from vrh.config import ComplianceConfig

        guard = ComplianceGuard(ComplianceConfig(enabled=False))
        ann = ShotAnnotation(shot_id=1, subject="this is John Smith")
        assert guard.scrub(ann).subject == "this is John Smith"

    def test_custom_blocklist(self):
        from vrh.config import ComplianceConfig

        guard = ComplianceGuard(ComplianceConfig(custom_blocklist=["AcmeCorp"]))
        ann = ShotAnnotation(shot_id=1, subject="a sign for AcmeCorp")
        assert "AcmeCorp" not in guard.scrub(ann).subject


class TestQualityGate:
    def _report(self, **overrides) -> ScoreReport:
        base = {
            "run_id": "r",
            "video_path": "x.mp4",
            "mean_clip_similarity": 0.9,
            "boundary_f1": 0.95,
            "mean_field_accuracy": 0.9,
        }
        base.update(overrides)
        return ScoreReport(**base)

    def test_clean_report_passes(self):
        decision = QualityGate().decide(self._report())
        assert decision.passed is True
        assert decision.feedback == ""

    def test_low_boundary_f1_fails_and_suggests_a_fix(self):
        decision = QualityGate().decide(self._report(boundary_f1=0.5))
        assert decision.passed is False
        assert any("cut threshold" in r for r in decision.reasons)

    def test_schema_failure_is_not_retryable(self):
        # Retrying a broken stage unchanged reproduces the same failure, so
        # spending another round would be pure waste.
        decision = QualityGate().decide(self._report(schema_valid=False))
        assert decision.passed is False
        assert decision.retryable is False

    def test_low_similarity_fails(self):
        decision = QualityGate().decide(self._report(mean_clip_similarity=0.2))
        assert decision.passed is False

    def test_review_ids_are_collected(self):
        report = self._report()
        report.shot_scores = [
            ShotScore(shot_id=5, needs_review=True),
            ShotScore(shot_id=6, needs_review=False),
        ]
        decision = QualityGate().decide(report)
        assert 5 in decision.review_shot_ids
        assert 6 not in decision.review_shot_ids

    def test_systemic_review_load_is_flagged(self):
        report = self._report()
        report.shot_scores = [ShotScore(shot_id=i, needs_review=True) for i in range(1, 11)]
        decision = QualityGate().decide(report)
        assert any("systemic" in r for r in decision.reasons)
