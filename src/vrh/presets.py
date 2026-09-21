"""Preset loading.

A preset is pure data describing how structured slots become prompt text. The
renderer in this module is the only place that knows prompt syntax, so adding
support for a new generation model never touches the pipeline.
"""

from __future__ import annotations

from pathlib import Path

import yaml
from pydantic import BaseModel, Field

PRESET_DIR = Path(__file__).resolve().parents[2] / "configs" / "presets"


class PresetConstraints(BaseModel):
    max_prompt_chars: int = Field(default=480, gt=0)
    max_slots_per_shot: int = Field(default=8, gt=0)
    drop_empty_slots: bool = True


class Preset(BaseModel):
    """A prompt-rendering specification for one target model family."""

    name: str
    description: str = ""
    slot_order: list[str] = Field(default_factory=list)
    slot_templates: dict[str, str] = Field(default_factory=dict)
    separator: str = ", "
    global_prompt_template: str = "{shot_summary}"
    style_anchor_template: str = "{style}"
    negative_prompt: str = ""
    camera_motion_map: dict[str, str] = Field(default_factory=dict)
    shot_size_map: dict[str, str] = Field(default_factory=dict)
    constraints: PresetConstraints = Field(default_factory=PresetConstraints)

    def render_slots(self, slots: dict[str, str]) -> str:
        """Render an ordered slot dict into a single prompt string.

        Unknown slots are ignored rather than appended, so a stage adding a new
        field cannot silently bloat prompts for presets that predate it.
        """
        parts: list[str] = []
        for key in self.slot_order:
            value = (slots.get(key) or "").strip()
            if not value:
                if self.constraints.drop_empty_slots:
                    continue
                value = ""
            template = self.slot_templates.get(key)
            parts.append(template.format(value=value) if template else value)
            if len(parts) >= self.constraints.max_slots_per_shot:
                break

        out = self.separator.join(p for p in parts if p)
        if len(out) > self.constraints.max_prompt_chars:
            # Truncate on a separator boundary so we never emit half a word.
            out = out[: self.constraints.max_prompt_chars].rsplit(self.separator, 1)[0]
        return out

    def map_motion(self, canonical: str) -> str:
        return self.camera_motion_map.get(canonical, canonical.replace("_", " "))

    def map_shot_size(self, canonical: str) -> str:
        return self.shot_size_map.get(canonical, canonical.replace("_", " "))


_BUILTIN: Preset | None = None


def load_preset(name: str = "t2v_generic", preset_dir: Path | None = None) -> Preset:
    """Load a preset by name.

    Falls back to an inline default when the file is absent, so a missing config
    degrades quality rather than halting the run.
    """
    preset_dir = preset_dir or PRESET_DIR
    path = preset_dir / f"{name}.yaml"
    if not path.exists():
        if name == "t2v_generic":
            return _fallback_preset()
        raise FileNotFoundError(f"preset not found: {path}")

    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    data.setdefault("name", name)
    if not data.get("slot_order"):
        data["slot_order"] = ["subject", "action", "scene", "camera", "lighting", "style"]
    return Preset.model_validate(data)


def _fallback_preset() -> Preset:
    global _BUILTIN
    if _BUILTIN is None:
        _BUILTIN = Preset(
            name="t2v_generic",
            description="inline fallback",
            slot_order=["subject", "action", "scene", "camera", "lighting", "style"],
            negative_prompt="blurry, low quality, distorted anatomy, watermark",
        )
    return _BUILTIN


def available_presets(preset_dir: Path | None = None) -> list[str]:
    preset_dir = preset_dir or PRESET_DIR
    if not preset_dir.exists():
        return []
    return sorted(p.stem for p in preset_dir.glob("*.yaml"))
