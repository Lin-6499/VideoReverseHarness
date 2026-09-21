"""Pipeline stages.

Each stage is a class with a single `run` method that reads one set of artifacts
from the run directory and writes the next. Stages never communicate through
shared memory, which is what makes them individually testable and rerunnable.
"""

from vrh.stages.base import Stage, StageContext, StageResult
from vrh.stages.s1_parse import ParseStage
from vrh.stages.s2_segment import SegmentStage
from vrh.stages.s3_understand import UnderstandStage
from vrh.stages.s4_generate import GenerateStage
from vrh.stages.s5_evaluate import EvaluateStage

__all__ = [
    "EvaluateStage",
    "GenerateStage",
    "ParseStage",
    "SegmentStage",
    "Stage",
    "StageContext",
    "StageResult",
    "UnderstandStage",
]
