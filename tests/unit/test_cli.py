"""Tests for CLI argument handling and the process-boundary error contract.

Two behaviours are worth pinning down mechanically, because both were wrong at
some point and neither is visible from reading a single function:

1. A bad `--video` must produce a one-line error and exit 1, not a stack trace
   and exit 0. Exit 0 on failure is the worst possible outcome for a harness that
   is meant to be driven by scripts.
2. A partial rerun (`--only` / `--until`) must carry the same gate options as a
   full run. Dropping them silently makes `--until evaluate --verify --threshold`
   report a verdict computed against the wrong threshold.
"""

from __future__ import annotations

import pytest

from vrh.cli import _wants_traceback, build_parser, main


class TestErrorContract:
    def test_missing_video_exits_one_not_zero(self, tmp_path, capsys):
        """The exact bug: FileNotFoundError escaped and the process exited 0."""
        code = main(["run", "--video", str(tmp_path / "does-not-exist.mp4")])
        captured = capsys.readouterr()

        assert code == 1, "a failed run must not report success"
        assert "video not found" in captured.err
        assert "Traceback" not in captured.err, (
            "a missing file is a user error, not a crash; no traceback by default"
        )

    def test_debug_flag_opts_into_a_traceback(self, tmp_path):
        """`--log-level DEBUG` is how a developer asks for the full stack."""
        with pytest.raises(FileNotFoundError):
            main(
                [
                    "run",
                    "--video",
                    str(tmp_path / "does-not-exist.mp4"),
                    "--log-level",
                    "DEBUG",
                ]
            )

    def test_wants_traceback_reads_the_flag_case_insensitively(self):
        parser = build_parser()
        args = parser.parse_args(
            ["run", "--video", "x.mp4", "--log-level", "debug"]
        )
        assert _wants_traceback(args) is True

    def test_wants_traceback_is_false_by_default(self):
        parser = build_parser()
        args = parser.parse_args(["run", "--video", "x.mp4"])
        assert _wants_traceback(args) is False


class TestPartialRerunOptions:
    """`--only` / `--until` must not silently drop the other flags."""

    def test_parser_accepts_gate_flags_alongside_only(self):
        parser = build_parser()
        args = parser.parse_args(
            [
                "run",
                "--video",
                "x.mp4",
                "--only",
                "generate",
                "--verify",
                "--rounds",
                "3",
                "--threshold",
                "0.85",
            ]
        )
        assert args.only == "generate"
        assert args.verify is True
        assert args.rounds == 3
        assert args.threshold == 0.85

    def test_only_and_until_accept_stage_names(self):
        parser = build_parser()
        for stage in ("parse", "segment", "understand", "generate", "evaluate"):
            assert parser.parse_args(
                ["run", "--video", "x.mp4", "--only", stage]
            ).only == stage
            assert parser.parse_args(
                ["run", "--video", "x.mp4", "--until", stage]
            ).until == stage

    def test_unknown_stage_is_rejected_by_the_parser(self):
        parser = build_parser()
        with pytest.raises(SystemExit):
            parser.parse_args(["run", "--video", "x.mp4", "--only", "s4_generate"])
