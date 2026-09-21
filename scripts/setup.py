#!/usr/bin/env python3
"""Bootstrap a working environment.

Does the four things a fresh checkout needs, and nothing else:

1. create ``.venv`` if absent
2. install the package plus the media/dev extras
3. fetch a portable ffmpeg into ``tools/``
4. run ``vrh doctor`` to confirm

Idempotent: safe to re-run.

Usage::

    python scripts/setup.py
    python scripts/setup.py --no-ffmpeg     # skip the download
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import venv
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENV = ROOT / ".venv"
IS_WINDOWS = sys.platform == "win32"


def venv_python() -> Path:
    return VENV / ("Scripts/python.exe" if IS_WINDOWS else "bin/python")


def run(cmd: list[str], **kwargs) -> None:
    print(f"$ {' '.join(str(c) for c in cmd)}")
    subprocess.run(cmd, check=True, **kwargs)


def ensure_venv() -> Path:
    python = venv_python()
    if python.exists():
        print(f"reusing {VENV}")
        return python

    print(f"creating {VENV}")
    venv.EnvBuilder(with_pip=True, upgrade_deps=False).create(VENV)
    return python


def ensure_pip(python: Path) -> None:
    """Guarantee pip exists.

    Some bundled interpreters create a venv without pip; `ensurepip` repairs
    that and is a no-op when pip is already present.
    """
    probe = subprocess.run(
        [str(python), "-m", "pip", "--version"],
        capture_output=True,
        text=True,
    )
    if probe.returncode == 0:
        return
    print("pip missing; bootstrapping with ensurepip")
    run([str(python), "-m", "ensurepip", "--default-pip"])


def install(python: Path) -> None:
    # setuptools must be present before an editable install with
    # --no-build-isolation, which is what works in restricted environments.
    run([str(python), "-m", "pip", "install", "--quiet", "--upgrade", "pip", "setuptools", "wheel"])
    run([str(python), "-m", "pip", "install", "-e", ".[media,dev]", "--no-build-isolation"])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-ffmpeg", action="store_true", help="skip ffmpeg download")
    parser.add_argument("--no-install", action="store_true", help="skip dependency install")
    args = parser.parse_args()

    python = ensure_venv()
    ensure_pip(python)

    if not args.no_install:
        install(python)

    if not args.no_ffmpeg:
        run([str(python), str(ROOT / "scripts" / "get_ffmpeg.py")])

    print("\nverifying")
    run([str(python), "-m", "vrh.cli", "doctor"])

    print(f"\nready. Activate with:\n  {VENV}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
