"""Quality gating and reporting.

`gate.py` holds the pass/fail policy; `report.py` renders a human-readable
summary. Kept out of L5 because the stage *measures*, and policy about what to do
with the measurement is a separate concern that callers may want to override.
"""

from vrh.quality.gate import GateDecision, QualityGate
from vrh.quality.report import render_report, render_report_html

__all__ = ["GateDecision", "QualityGate", "render_report", "render_report_html"]
