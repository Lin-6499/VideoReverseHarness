# VRH — Video Reverse Harness

Turns a video into structured, replayable prompts.

The harness treats a video as a *source file* and a prompt bundle as its
*compiled output*. Five stages run in sequence, each writing a JSON artifact that
the next stage reads back — no shared in-memory state, no orchestration
framework.

```
video ──> L1 parse ──> L2 segment ──> L3 understand ──> L4 generate ──> L5 evaluate
          meta.json    shots.json     annotations.json   prompt.json    score.json
```

---

## Quick start

```bash
# One command: creates .venv, installs deps, fetches ffmpeg, runs doctor.
python scripts/setup.py
```

Then:

```bash
.venv/Scripts/activate          # Windows
source .venv/bin/activate       # macOS / Linux

# Generate a sample clip to try it on
python scripts/make_sample.py

# Run (no API keys needed — fake providers are the default)
vrh run --video samples/clip.mp4 --keyframe-strategy triple

# Open the review page
#    output/<video-id>/report.html
```

Every command also works without activating, via
`.venv/Scripts/python -m vrh.cli <args>`.

### Manual setup

If you would rather do it step by step:

```bash
python -m venv .venv
.venv/Scripts/python -m ensurepip --default-pip     # only if pip is missing
.venv/Scripts/python -m pip install setuptools wheel
.venv/Scripts/python -m pip install -e ".[media,dev]" --no-build-isolation
python scripts/get_ffmpeg.py                        # or install ffmpeg yourself
.venv/Scripts/python -m vrh.cli doctor
```

`--no-build-isolation` is deliberate: it uses the setuptools already present in
the venv rather than fetching a fresh build backend, which is what makes the
install work in restricted or offline environments.

Out of the box the pipeline uses deterministic fake providers, so it runs
end-to-end with no credentials and no network. Point it at real models by
editing `configs/local.yaml` (see [Switching to real models](#switching-to-real-models)).

### ffmpeg

ffmpeg is the one hard dependency. `scripts/get_ffmpeg.py` fetches a portable
build into `tools/`, which takes priority over PATH — see
[`tools/README.md`](tools/README.md). If you prefer a system install:

| Platform | Command |
|---|---|
| Windows | `winget install Gyan.FFmpeg` |
| macOS | `brew install ffmpeg` |
| Debian/Ubuntu | `sudo apt install ffmpeg` |

Resolution order is `tools/` first, then PATH. `vrh doctor` reports which binary
will actually be used.

### No ffmpeg at all? Use Docker.

```bash
docker build -t vrh .
docker run --rm -v "$PWD:/work" vrh run --video /work/samples/clip.mp4
```

The image bundles ffmpeg, PySceneDetect and OpenCV, so nothing degrades.

---

## What it produces

`output/<video-id>/prompt.json`:

```jsonc
{
  "global_prompt": "A 3-shot sequence, 35mm film grain, documentary...",
  "style_anchor": "35mm film grain, shallow depth of field",
  "genre": "documentary",
  "pacing": "slow",
  "aspect_ratio": "16:9",
  "shots": [
    {
      "shot_id": 1,
      "start_s": 0.0,
      "end_s": 3.2,
      "prompt": "a person in a dark jacket, walking forward, a quiet city street at dusk, camera: medium shot, push in, lighting: low key warm, 35mm film grain",
      "negative_prompt": "blurry, low quality, distorted anatomy, watermark",
      "slots": { "subject": "...", "action": "...", "camera": "..." },
      "confidence": 0.82
    }
  ]
}
```

Three granularities are produced because downstream tools want different things:
`shots[].prompt` for image-to-video reproduction, `global_prompt` for
text-to-video style alignment, and `style_anchor` as a reusable prefix.

---

## Pipeline stages

| Stage | Artifact | What it does |
|---|---|---|
| **L1 parse** | `meta.json` | Container/stream metadata, audio extraction, rotation handling |
| **L2 segment** | `shots.json` | Cut detection, keyframe extraction, **optical-flow camera motion** |
| **L3 understand** | `annotations.json` | Per-shot vision annotation, transcript alignment |
| **L4 generate** | `prompt.json` | Deterministic slot filling + LLM global synthesis |
| **L5 evaluate** | `score.json` | Field coverage, CLIP similarity, review flagging |

Two things in there are worth calling out, because they are what separate this
from a thin wrapper over a vision API:

**Optical-flow motion analysis (L2).** Hard-cut detection only tells you the
picture changed. It cannot tell you the camera pushed in. Camera motion is one of
the highest-signal attributes in any generation prompt, so L2 runs Farneback flow
between keyframes and classifies the flow field into 12 discrete moves. Without
it, the `camera` slot is guesswork.

**Content-addressed keyframes (L2).** Every frame is stored under its SHA-256.
Two shots sharing a frame share one file *and one API call*. At thousands of
videos this is the largest single cost lever — larger than model choice.

---

## Common operations

```bash
# Dry run: find out how many shots and how much it will cost before spending
vrh run --video clip.mp4 --until segment

# Inspect what any stage produced
vrh inspect --video clip.mp4 --stage segment
vrh inspect --video clip.mp4 --stage segment --field shots.0.motion

# Re-tune cut detection without re-invoking the vision model
vrh run --video clip.mp4 --only segment --cut-threshold 18

# Regenerate the prompt from existing annotations (no vision calls)
vrh run --video clip.mp4 --only generate

# Quality gate with one retry round
vrh run --video clip.mp4 --verify --rounds 2 --threshold 0.75

# Copy-pasteable flat text
vrh report --video clip.mp4 --format flat
```

`--only` and `--until` are the two flags that matter most day to day. Tuning the
cut threshold should not re-bill the vision model for every shot. They accept the
same gate flags as a full run (`--verify`, `--rounds`, `--threshold`), so a
partial rerun reports the verdict you actually asked for.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | error (bad path, unresolvable ffmpeg, corrupt artifact) |
| 2 | `--fail-on-gate` and the quality gate was not satisfied |
| 130 | interrupted; completed stages are checkpointed and will resume |

Errors print one line to stderr rather than a traceback. Add `--log-level DEBUG`
when you want the full stack.

---

## Switching to real models

Create `configs/local.yaml` (gitignored) and set the provider plus the *name* of
the environment variable holding your key — never the key itself:

```yaml
providers:
  vision:
    name: openai_vlm
    model: gpt-4o-mini
    api_key_env: OPENAI_API_KEY

  llm:
    name: openai
    model: gpt-4o-mini
    api_key_env: OPENAI_API_KEY

cost:
  track: true
  price_per_image: 0.0006        # per frame sent to the vision model
  price_per_1k_input_tokens: 0.00015
  price_per_1k_output_tokens: 0.0006
  max_usd_per_video: 2.00        # aborts the run rather than overspending

cache:
  enabled: true                  # leave this on
```

Or override anything from the environment:

```bash
VRH_PROVIDERS__VISION__NAME=openai_vlm \
VRH_COST__MAX_USD_PER_VIDEO=1.50 \
vrh run --video clip.mp4
```

The `max_usd_per_video` cap aborts rather than warns. Silent overspend is
discovered at the end of the month; a failed run is discovered immediately.

---

## Prompts presets

Slots are rendered per preset, so supporting a new generation model means adding
one YAML file in `configs/presets/` — never touching pipeline code.

| Preset | Ordering | For |
|---|---|---|
| `t2v_generic` | subject → action → scene → camera → lighting → style | Text-to-video |
| `i2v_generic` | action → camera → lighting → style | Image-to-video (motion-forward) |

A preset can remap vocabulary (`dolly_in` → `push in`), cap prompt length, and
override the negative prompt.

---

## Configuration

Three layers, lowest precedence first:

1. `configs/default.yaml` — committed defaults
2. `configs/presets/<name>.yaml` — target-model preset
3. `configs/local.yaml` — machine overrides, gitignored

Environment variables (`VRH_` prefix, `__` for nesting) override all three.

---

## Design decisions worth knowing

**No orchestration framework.** The pipeline is five linear stages, not a DAG.
Airflow/LangGraph/Prefect would add a dependency, a version-drift surface and an
abstraction to debug, while solving no problem this project has. State lives in
`run_state.json`; resuming means reading it back. See `docs/DESIGN.md`.

**Middleware instead of inline concerns.** Caching, retry, cost accounting and
compliance are wrappers composed around providers:

```
Cache(Retry(Compliance(Cost(RawProvider))))
```

Order matters, and every link is load-bearing. Cost sits innermost so it observes
only *real* provider calls — if it sat outside the cache it would bill for cache
hits, and a warm rerun would cost the same as a cold one. Compliance sits above
Cost so the scrubbed value is what gets cached, and a cached value can never
reintroduce unscrubbed data. Retry sits above Compliance so a retry neither skips
scrubbing nor goes unbilled. Cache sits outermost so a hit short-circuits
everything else.

**Two-step understanding, not one.** The vision model observes; the LLM
synthesises. Asking a vision model to emit final prompt text directly gets worse
results than having it fill structured slots, because prompt syntax and visual
observation are different skills.

**Compliance is on by default.** Identity-specific descriptions are downgraded to
generic attributes before they can reach a prompt. This is a legal requirement in
most jurisdictions, not a nicety.

---

## Testing

```bash
.venv/Scripts/python -m pytest tests/unit          # fast, no ffmpeg needed
.venv/Scripts/python -m pytest tests/integration   # generates a real video, runs all five stages
.venv/Scripts/python -m pytest                     # everything
```

Current status on a clean checkout: **115 passed** (92 unit + 23 integration),
no skips.

The unit split by concern: configuration merging and env-var layering, the
annotation/prompt/score contracts, the CLI error contract, and the vision
providers — `tests/unit/test_gemini_vlm.py` pins the Gemini request shape
(`inline_data` parts, `x-goog-api-key`, one endpoint per model), which failures
would otherwise only surface against the live API.

The integration suite builds a 6-second three-colour clip with ffmpeg and runs
all five stages against it. It needs no credentials and costs nothing, but it
exercises real decoding, real cut detection and real frame extraction — which is
where the bugs actually live.

Integration tests skip automatically when ffmpeg cannot be resolved. If you see
skips, run `python scripts/get_ffmpeg.py`.

---

## Troubleshooting

**`ffprobe was not found on PATH (and no bundled copy in ./tools)`** — ffmpeg is
missing. Run `python scripts/get_ffmpeg.py`, or use Docker, or
`winget install Gyan.FFmpeg` / `brew install ffmpeg` / `apt install ffmpeg`.

**Only one shot detected in a long video** — cut detection found nothing. Lower
`--cut-threshold` (try 15–20) and re-run with `--only segment`.

**Camera motion is always `unknown`** — OpenCV is missing, so optical flow is
skipped. `pip install "vrh[media]"`.

**Second run costs the same as the first** — the cache is not being hit. Check
that `cache.enabled` is true, and that the provider model name is stable between
runs (the model name is part of the cache key).

**Costs are higher than expected** — reduce `--frames-per-shot`. API calls scale
roughly as `shots × frames × rounds`, so dropping from 4 to 3 frames saves about
25%.
