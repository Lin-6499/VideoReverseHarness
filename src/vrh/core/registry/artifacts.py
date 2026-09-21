"""Artifact registry.

Named so the pipeline does not hardcode filenames in a dozen places. Each stage
declares its artifact and the readers look it up here.
"""

from pathlib import Path

ARTIFACTS: dict[str, str] = {
    "parse": "meta.json",
    "segment": "shots.json",
    "understand": "annotations.json",
    "generate": "prompt.json",
    "evaluate": "score.json",
}

RUN_STATE_FILE = "run_state.json"


def artifact_path(run_dir: Path, stage: str) -> Path:
    """Resolve a stage's artifact path within a run directory."""
    name = ARTIFACTS.get(stage)
    if name is None:
        raise KeyError(f"unknown stage '{stage}'; known: {sorted(ARTIFACTS)}")
    return run_dir / name


__all__ = ["ARTIFACTS", "RUN_STATE_FILE", "artifact_path"]
