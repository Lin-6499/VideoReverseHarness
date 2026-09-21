"""VRH - Video Reverse Harness.

Turns a video into structured, replayable prompts.

The package is organised as a five-stage pipeline:

    L0 input    -> Job (config + video path)
    L1 parse    -> MediaMeta
    L2 segment  -> ShotSet   (+ keyframes on disk)
    L3 understand -> ShotAnnotation list
    L4 generate -> PromptBundle  (the deliverable)
    L5 evaluate -> ScoreReport   (quality gate + optional rollback)

Every stage communicates through the contracts in `vrh.contracts`, and only
through them. See docs/DESIGN.md for why this matters.
"""

__version__ = "0.1.0"

__all__ = ["__version__"]
