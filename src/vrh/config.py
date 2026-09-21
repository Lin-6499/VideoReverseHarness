"""Configuration loading and merging.

Three layers, lowest to highest precedence:

    1. configs/default.yaml          -- repo defaults, committed
    2. configs/<preset>.yaml         -- target-model preset, committed
    3. configs/local.yaml            -- machine-specific overrides, gitignored

Environment variables override everything, using the `VRH_` prefix with
double-underscore nesting: `VRH_PROVIDERS__VISION__NAME=openai_vlm`.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field

DEFAULT_CONFIG_DIR = Path(__file__).resolve().parents[3] / "configs"

ENV_PREFIX = "VRH_"


class ProviderConfig(BaseModel):
    """Connection settings for one provider slot."""

    name: str = Field(
        default="fake",
        description="Which implementation to load from vrh.providers.registry. "
        "'fake' requires no network and is the default so the pipeline always runs.",
    )
    model: str = Field(default="", description="Backend model identifier.")
    api_key_env: str = Field(
        default="",
        description="Name of the env var holding the credential. Never the "
        "credential itself -- config files get committed.",
    )
    base_url: str = Field(default="")
    timeout_s: float = Field(default=60.0, gt=0)
    max_retries: int = Field(default=3, ge=0)
    temperature: float = Field(
        default=0.0,
        ge=0.0,
        le=2.0,
        description="Defaults to 0. Reproducibility is a hard requirement for "
        "A/B comparison; raise deliberately, not accidentally.",
    )
    extra: dict[str, Any] = Field(default_factory=dict)


class CacheConfig(BaseModel):
    """Content-addressed cache settings."""

    enabled: bool = True
    path: str = Field(default=".cache/vrh_cache.sqlite3")
    ttl_days: int = Field(
        default=0, ge=0, description="0 means entries never expire."
    )


class CostConfig(BaseModel):
    """Cost guardrails."""

    track: bool = True
    price_per_1k_input_tokens: float = Field(default=0.0, ge=0.0)
    price_per_1k_output_tokens: float = Field(default=0.0, ge=0.0)
    price_per_image: float = Field(
        default=0.0, ge=0.0, description="Charged per frame sent to a vision model."
    )
    max_usd_per_video: float = Field(
        default=0.0,
        ge=0.0,
        description="0 disables the cap. A non-zero cap aborts the run rather "
        "than silently overspending.",
    )


class ProvidersConfig(BaseModel):
    vision: ProviderConfig = Field(default_factory=ProviderConfig)
    llm: ProviderConfig = Field(default_factory=ProviderConfig)
    asr: ProviderConfig = Field(default_factory=ProviderConfig)
    embedding: ProviderConfig = Field(default_factory=ProviderConfig)


class ComplianceConfig(BaseModel):
    """Output filtering."""

    enabled: bool = True
    redact_faces: bool = Field(
        default=True,
        description="Downgrade identity-specific subject descriptions to generic "
        "attributes. On by default: this is a legal requirement in most "
        "jurisdictions, not an optional nicety.",
    )
    block_identifying_text: bool = Field(default=True)
    custom_blocklist: list[str] = Field(default_factory=list)


class LoggingConfig(BaseModel):
    level: str = "INFO"
    # Aliased, not named `json`: pydantic BaseModel already defines `json` as a
    # method, and shadowing it makes `settings.logging.json` ambiguous -- it
    # would resolve to the method rather than the flag.
    json_logs: bool = Field(
        default=False,
        validation_alias="json",
        serialization_alias="json",
    )
    show_cost: bool = True

    model_config = {"populate_by_name": True}


class Settings(BaseModel):
    """Root configuration object."""

    providers: ProvidersConfig = Field(default_factory=ProvidersConfig)
    cache: CacheConfig = Field(default_factory=CacheConfig)
    cost: CostConfig = Field(default_factory=CostConfig)
    compliance: ComplianceConfig = Field(default_factory=ComplianceConfig)
    logging: LoggingConfig = Field(default_factory=LoggingConfig)
    output_root: str = "output"

    preset: str = Field(default="t2v_generic")


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """Recursively merge `override` into `base`, returning a new dict."""
    out = dict(base)
    for key, value in override.items():
        if key in out and isinstance(out[key], dict) and isinstance(value, dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def _read_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def _apply_env_overrides(data: dict[str, Any], env: dict[str, str]) -> dict[str, Any]:
    """Fold VRH_-prefixed env vars into the config tree.

    `VRH_PROVIDERS__VISION__NAME=x` sets data['providers']['vision']['name'].
    Values are coerced with yaml.safe_load so `"true"` becomes a bool and
    `"3"` becomes an int.
    """
    out = dict(data)
    for raw_key, raw_value in env.items():
        if not raw_key.startswith(ENV_PREFIX):
            continue
        path = raw_key[len(ENV_PREFIX) :].lower().split("__")
        if not path or not path[0]:
            continue
        try:
            value: Any = yaml.safe_load(raw_value)
        except yaml.YAMLError:
            value = raw_value

        cursor = out
        for part in path[:-1]:
            nxt = cursor.get(part)
            if not isinstance(nxt, dict):
                nxt = {}
                cursor[part] = nxt
            cursor = nxt
        cursor[path[-1]] = value
    return out


def load_settings(
    config_dir: Path | None = None,
    preset: str | None = None,
    env: dict[str, str] | None = None,
) -> Settings:
    """Load and merge all configuration sources.

    Missing files are not an error -- the layered design means a bare checkout
    with no configs at all still produces working defaults.
    """
    config_dir = config_dir or DEFAULT_CONFIG_DIR
    env = env if env is not None else dict(os.environ)

    data = _read_yaml(config_dir / "default.yaml")

    preset_name = preset or data.get("preset") or "t2v_generic"
    data = _deep_merge(data, _read_yaml(config_dir / "presets" / f"{preset_name}.yaml"))
    data = _deep_merge(data, _read_yaml(config_dir / "local.yaml"))
    data = _apply_env_overrides(data, env)

    data.setdefault("preset", preset_name)
    return Settings.model_validate(data)
