# tools/

ffmpeg and ffprobe live here.

`vrh.media.ffmpeg.resolve_binary()` checks this directory **before** PATH, so a
checkout can carry its own ffmpeg without touching the host environment. Set
`VRH_FFMPEG_DIR` to point somewhere else.

## Getting the binaries

```bash
python scripts/get_ffmpeg.py
```

Downloads the platform-appropriate release and extracts just the two binaries,
removing the archive afterwards. `scripts/setup.py` calls this automatically.

## Why not PATH only?

Because "install ffmpeg" is the single most common cause of a failed first run,
and because builds differ in ways that matter — a distro ffmpeg lacking
`libx264` fails at encode time with an error that looks like a bug in the
harness. Pinning a known-good build next to the code removes that whole class of
problem.

## Version

The fetched build is whatever the upstream release points at. Release archives
are ~100 MB, so they are gitignored; each checkout fetches its own.

## Manual installation

Any ffmpeg on PATH works if you would rather not bundle it:

| Platform | Command |
|---|---|
| Windows | `winget install Gyan.FFmpeg` |
| macOS | `brew install ffmpeg` |
| Debian/Ubuntu | `sudo apt install ffmpeg` |

`pip install imageio-ffmpeg` is *not* a substitute — it ships only `ffmpeg`, and
the harness needs `ffprobe` for metadata.
