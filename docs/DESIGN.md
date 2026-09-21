# Architecture and design rationale

This document records *why* the harness is built the way it is. The code shows
what happens; this shows what was rejected and why.

---

## 1. Why no orchestration framework

The pipeline is five linear stages. Not a DAG, not an agent loop, not a
human-in-the-loop workflow.

Evaluated and rejected:

| Framework | Why rejected |
|---|---|
| **Agent harnesses** (multi-agent task orchestration) | Stages here are deterministic. Making stage behaviour model-decided would destroy reproducibility, and reproducibility is the precondition for A/B comparison — without it there is no way to know whether a prompt change helped. |
| **LangGraph** | Strength is conditional branching and cyclic retry. This pipeline has exactly one conditional (the quality gate) and one loop (bounded rounds). An `if` statement covers it; the dependency is not worth carrying. |
| **AutoGen / CrewAI** | Built for multi-role conversation. There is no conversational structure here, and forcing one would degrade the L2→L3 handoff from a typed contract into prose. |
| **Airflow / Prefect / Dagster** | Aimed at DAGs plus scheduled batch. The flow is linear, and the requirement is *per-stage rerun*, which these schedulers model awkwardly. Scheduler daemon + metadata DB is real operational cost for no matching benefit. |
| **Ray / Dask** | The bottleneck is API latency (IO-bound), not local compute. Distributing would raise complexity an order of magnitude without touching the actual constraint. |

**What replaced them:** a status file. Each stage writes its artifact and commits a
record to `run_state.json`. Resuming reads it back. Single-stage rerun means
running the loop with a restricted stage list. These capabilities come free from
using the filesystem as the contract, and no framework is needed to provide them.

**Trigger conditions for revisiting:** if the task grows into multi-round
autonomous prompt optimisation (LangGraph), arbitrary branching (Prefect), or
10k+ videos across machines (Ray/Celery). None hold today, and the contracts are
decoupled enough that migration would be contained.

---

## 2. Why the filesystem is the interface

Stages exchange Pydantic models *written to disk*, never Python objects passed in
memory. The cost is some serialisation; the benefits are structural:

- **Resumability** is free — state recovery is reading files.
- **Stage isolation** — each stage is testable by writing an input JSON and
  calling one method.
- **Debugging** — the intermediate state after any stage is a file you can open.
- **Parallel development** — contract-first means stages can be built against
  hand-written fixtures before neighbours exist.

The alternative (a shared context object threaded through stages) would be faster
per run and worse in every other dimension.

---

## 3. Why middleware for cross-cutting concerns

Caching, retry, cost tracking and compliance are all wrappers:

```
Cache(Retry(Compliance(Cost(RawProvider))))
```

Read outside-in. **Order is load-bearing, not incidental:**

- **Cache outermost.** A hit short-circuits everything inside it, including the
  retry and compliance work. That is what makes a rerun cheap.
- **Cost innermost.** It must observe only *real* provider calls. Placed outside
  the cache it would charge for cache hits — and since the entire cost argument
  rests on "a hit costs nothing", that would silently invalidate the design
  while every other test still passed. This was a real bug, caught only because
  an integration test asserted the rerun bills zero.
- **Compliance inside Cache, outside Cost.** The scrubbed value is what gets
  cached, so a cached value can never reintroduce unscrubbed data on a later
  run. Cost still measures the call that produced it.

The general rule: **a caching layer must sit outside anything that must not run
on a miss, and inside anything that must not observe a hit.** Cost and cache are
opposite in this respect, which is why their relative order is the part that
gets written down rather than left to intuition.

The payoff: adding an audit log is one class and one line in the wrapping
function. It never means editing the code that understands video.

---

## 4. Why understanding is split into two model calls

Vision model observes; LLM synthesises. Not one combined call.

The reasoning is about matching capability to task:

- A vision model is good at **noticing** — what objects, what lighting, what
  framing. It is bad at emitting prompt syntax, because that is a distribution
  shift away from its training objective.
- An LLM knows prompt vocabulary and can reason about **cross-shot consistency**
  — that shot 4 is a continuation of shot 3 — but cannot see anything.

A single call asking for the final prompt gets the worst of both: the vision
model's observational power is spent on syntax it handles poorly, and the
cross-shot reasoning never happens because each call sees one shot.

Per-shot prompt text is therefore rendered **deterministically** from slots. The
LLM is used only for the global synthesis that a per-shot view cannot produce. An
LLM rephrasing each shot individually would add cost and non-determinism while
restating what the slots already say.

---

## 5. Why optical flow is not optional in practice

Cut detection answers "did the picture change". It cannot answer "how did the
camera move". These are different questions and the second is the one prompt
generation cares about.

Method: Farneback dense flow between sampled keyframes, then classify the flow
field statistically.

| Flow signature | Classification |
|---|---|
| Low magnitude | `static` |
| Uniform direction, coherent across pairs | `pan_*` / `tilt_*` |
| Radial outward from centre | `dolly_in` / `zoom_in` |
| Radial inward | `dolly_out` / `zoom_out` |
| High magnitude, incoherent direction | `handheld` |

**Farneback, not RAFT.** RAFT is more accurate but needs a GPU and a model
download, and its advantage is per-pixel motion separation — which the prompt
contract does not need. Farneback runs on CPU in milliseconds per pair and is
sufficient for 12-way classification.

Confidence is deliberately conservative. A weak, incoherent flow field scores
low, which flags the shot for review instead of silently writing a wrong camera
value into the prompt.

---

## 6. Why keyframes are content-addressed

Every extracted frame is stored as `keyframes/<sha256[:16]>.jpg`. Two shots
containing the same frame share one file and one API call.

Cost scales as roughly `shots × frames_per_shot × rounds`. At M-scale this ends up
dominating everything else, which means:

> A 10-point cache hit rate improvement is worth more than a 20% cheaper model.

That is why the cache key includes the frame *content* plus provider, model and
temperature — so a model change invalidates automatically, and identical pixels
never bill twice. It is also why `--frames-per-shot` is the first knob to turn
under budget pressure.

---

## 7. Why compliance runs before prompt generation

The guard redacts identity-specific content from annotations *before* L4 can put
it in a prompt. Running it after generation would mean redacting a deliverable
that had already been written to disk.

It redacts rather than blocks. Refusing to process any frame containing a face
would make the tool useless on real footage. Downgrading "this is John Smith" to
"a person" preserves utility while removing the identifying claim.

---

## 8. Deliberate omissions

Not implemented, and why:

| Omitted | Reasoning |
|---|---|
| Distributed execution | IO-bound workload; premature distribution is the most common over-engineering mistake here. |
| A web UI | The HTML review page covers the actual need (spotting and correcting bad shots). A server adds deployment surface for no new capability. |
| Vector search over results | No retrieval use case yet. Adding it would mean maintaining an index alongside the artifacts. |
| Action localisation (temporal action detection) | Needs a different model class and a much larger annotation budget. The `action` slot captures the label; precise boundaries are a separate project. |
| Fine-tuning | No labelled dataset exists. Cold-start with prompted models is the correct first move. |
| Async task queue (Redis/Celery) | Not needed at S-scale. When it is, `concurrent.futures` is the next step, not Redis. |

---

## 9. Why ffmpeg resolution prefers a bundled copy

`resolve_binary()` checks `<repo>/tools/` before PATH, overridable via
`VRH_FFMPEG_DIR`.

Two reasons, both about failure modes rather than elegance:

- **"Install ffmpeg" is the most common first-run failure.** Bundling makes
  setup a command the project can run itself instead of a prerequisite the user
  must satisfy.
- **Builds differ in ways that surface as harness bugs.** A distro ffmpeg
  compiled without `libx264` fails at encode time with an error originating from
  deep inside a subprocess. Pinning a known-good build removes an entire
  diagnostic dead end.

The cost is ~100 MB of gitignored binaries per checkout, re-fetched by
`scripts/get_ffmpeg.py`. That is the right trade: disk is cheap, and a
misattributed codec failure is not.

---

## 10. Bugs found during initial verification

Recorded because each one was invisible to the unit suite and would have been
expensive to find later.

**`ActionAnnotation.label` was required, but `ShotAnnotation.action` used
`default_factory=ActionAnnotation`.** Every provider passed `label` explicitly,
so the failure only appeared when constructing a default action — which is
exactly what the documented contract promises is possible. Fixed by giving
`label` a default of `""`, consistent with every neighbouring field.

**`StageContext` used `pydantic.Field(description=...)` inside a `@dataclass`,
and `StageResult` used `dataclasses.field` inside a `BaseModel`.** Both are
import-confusion errors that raise only at class-definition time, so they took
the whole module — and every integration test — down on import. The unit suite
never imported them.

**Cost tracking sat *outside* the cache, so cache hits were billed.** The
middleware chain read `Cost(Cache(Retry(Compliance(raw))))`, which charges
before delegating and therefore cannot know whether the inner layer served the
request from cache. The rerun-bills-zero property — the entire justification for
the cache — was false, while every other test passed. Fixed by moving cost
innermost (see §3).

The common thread: **none of these were algorithm errors. They were contract
violations and ordering mistakes, and all three were caught by integration tests
running a real video rather than by unit tests over the pieces.** That is the
argument for keeping the end-to-end suite in the default `pytest` run.

### 10a. Bugs found during the usability pass

A second pass, run by actually driving the CLI rather than by reading it, turned
up two more. Both are recorded because they share a shape: they live in the
argument-handling layer, which the integration suite reaches through the
*library* API and therefore never exercises.

**A missing `--video` raised an unhandled `FileNotFoundError` and the process
exited 0.** The traceback was ugly but harmless; the exit code was not. A harness
whose primary consumers are shells, Makefiles and CI runners had no way to detect
failure — `vrh run && next-step` would proceed on a run that produced nothing.
Fixed by making `main()` the process boundary: expected errors become a one-line
message and exit 1, and a traceback is opt-in via `--log-level DEBUG`, which is
how a developer asks for one. `KeyboardInterrupt` exits 130 so a wrapper can tell
an interrupt from a failure.

**`--only` / `--until` silently dropped `--verify`, `--rounds` and
`--threshold`.** `_run_partial` constructed a `RunOptions` by hand and copied only
the segmentation-related fields. The consequence is subtle rather than loud: the
run still completed and still printed a verdict, just computed against the default
0.7 threshold instead of the one requested. A rerun-reports-the-wrong-answer bug
is worse than a crash, because nothing signals that the output is wrong. Fixed by
carrying all gate options through, and pinned by tests asserting the parser keeps
them.

The lesson generalises: **the library API and the CLI are two different contracts,
and testing one does not validate the other.** The integration suite covers the
pipeline thoroughly, so every one of these defects lived in the gap between it and
the command line.

### 10b. The stale-artifact bug

Found by running the same video twice at two different gate thresholds — the kind
of thing a user does casually and a test suite does not, unless it is told to.

Run A requested `--threshold 0.99` and failed, correctly. Run B then requested
`--threshold 0.5` against the same video, at which the aggregate of 0.748 plainly
passes. It reported `passed: False` and exited 2, having reused run A's
`score.json`. Every stage had been skipped as "already complete", including
`evaluate` — the one stage whose output is a *function of the threshold*.

Two properties make this worse than an ordinary bug:

1. **It fails silently and confidently.** No warning, no error, no non-zero exit
   until the gate was consulted. The output looked entirely normal.
2. **It affects the artifact a user would trust.** `score.json` is the verdict.
   A stale verdict is indistinguishable from a fresh one at a glance.

The underlying design flaw: `RunState.completed` recorded *that* a stage ran, not
*what it ran under*. Resumption therefore assumed options are immutable for the
lifetime of a run directory — true for an accidental crash/resume, false for the
deliberate re-invocation that is the documented way to retune a threshold.

**The fix:** each `StageRecord` now carries an `options_fingerprint`, and a stage
whose fingerprint no longer matches the current job is re-run rather than skipped.
The fingerprint is per-stage and covers only that stage's true inputs — L5 is keyed
on the threshold alone, L2 on segmentation and keyframe options — so changing
`max_rounds` does not throw away a perfectly good L2. Hashing the entire options
object would have been shorter and worse: it would invalidate work needlessly,
turning correctness into a reason to stop using `resume`.

This is the same shape as §10's middleware bug, one level up: **an optimization
(caching, skipping) that is not conditioned on the thing it assumes is constant.**
The cache assumed the provider call is a pure function of its inputs and got that
right; resumption assumed the *options* were constant and got it wrong.

---

## 11. Known limitations

Stated plainly, because a harness that oversells its reliability is worse than one
that does not.

1. **Extraction is lossy.** Sampling cannot capture everything between frames.
   Fast motion and transitions are systematically under-described.
2. **Camera classification is heuristic.** Flow-based classification confuses
   subject motion with camera motion when a large object fills the frame. The
   `consistency` metric partially detects this.
3. **The fake embedding provider is not semantically meaningful.** It exists to
   prove the scoring plumbing works. Real similarity requires a CLIP backend.
4. **The lexical compliance guard has false negatives.** It catches name-shaped
   output, not every possible identity inference.
5. **Long videos are processed whole.** No chunking yet, so a feature-length video
   would produce a very large shot list and a very large bill.
