#!/usr/bin/env python3
"""Fetch a portable ffmpeg into ``tools/``.

ffmpeg is the harness's only hard dependency and the most common cause of a
failed first run. Rather than requiring a system-wide install, this script drops
``ffmpeg``/``ffprobe`` into ``tools/``, where :mod:`vrh.media.ffmpeg` picks them
up before consulting PATH.

Usage::

    python scripts/get_ffmpeg.py            # fetch if missing
    python scripts/get_ffmpeg.py --force    # re-fetch even if present

The binaries are gitignored (~100 MB each); run this once per checkout.
"""

from __future__ import annotations

import argparse
import platform
import shutil
import stat
import sys
import urllib.request
import zipfile
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parents[1] / "tools"

# Single source per platform. Official project builds are preferred; the
# Windows build (gyan.dev) is the de-facto standard distribution.
SOURCES = {
    "Windows": "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    "Linux": "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz",
    "Darwin": None,  # use `brew install ffmpeg`; no stable portable build to fetch
}


def _binary_names() -> list[str]:
    if platform.system() == "Windows":
        return ["ffmpeg.exe", "ffprobe.exe"]
    return ["ffmpeg", "ffprobe"]


def already_present() -> bool:
    return all((TOOLS_DIR / name).is_file() for name in _binary_names())


def download(url: str, dest: Path) -> None:
    print(f"downloading {url}")
    with urllib.request.urlopen(url, timeout=300) as response:  # noqa: S310
        total = int(response.headers.get("Content-Length") or 0)
        read = 0
        with open(dest, "wb") as handle:
            while chunk := response.read(1 << 20):
                handle.write(chunk)
                read += len(chunk)
                if total:
                    pct = read * 100 // total
                    print(f"\r  {read >> 20} / {total >> 20} MiB ({pct}%)", end="")
    print()


def extract_zip(archive: Path, wanted: list[str]) -> list[Path]:
    """Pull the named binaries out of an ffmpeg release archive."""
    extracted: list[Path] = []
    with zipfile.ZipFile(archive) as zf:
        for member in zf.namelist():
            basename = member.rsplit("/", 1)[-1]
            if basename in wanted:
                target = TOOLS_DIR / basename
                with zf.open(member) as src, open(target, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                extracted.append(target)
    return extracted


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="re-fetch even if present")
    args = parser.parse_args()

    system = platform.system()
    if already_present() and not args.force:
        print(f"ffmpeg already present in {TOOLS_DIR}")
        return 0

    url = SOURCES.get(system)
    if url is None:
        print(
            f"no portable build configured for {system}.\n"
            "Install ffmpeg via your package manager instead:\n"
            "  brew install ffmpeg",
            file=sys.stderr,
        )
        return 1

    TOOLS_DIR.mkdir(parents=True, exist_ok=True)
    archive = TOOLS_DIR / "ffmpeg-download.zip"

    try:
        download(url, archive)
        got = extract_zip(archive, _binary_names())
    finally:
        archive.unlink(missing_ok=True)

    if not got:
        print("archive contained no expected binaries", file=sys.stderr)
        return 1

    for binary in got:
        binary.chmod(binary.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP)
        print(f"  -> {binary}")

    print(f"\nffmpeg ready in {TOOLS_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
