# cam-bench — headless CAM slice+prepare bench

Drives the full kiri CAM slice + prepare pipeline in node (no browser, no
UI) against an STL model, and reports wall time of each phase. Built for
perf work on CAM ops (rough/flats area generation, stock removal model,
clipper passes).

## What it does

1. bundles the kiri worker (`src/kiri/run/worker.js`) and minion
   (`src/kiri/run/minion.js`) with esbuild into a temp workspace
   (`os.tmpdir()/cam-bench`), copying `src/wasm/*.wasm` next to them
   (emscripten's manifold module resolves `../wasm/manifold.wasm`
   relative to cwd — the bench chdirs there);
2. runs the worker in-process and minions in `worker_threads`, with
   browser shims (`self`, `navigator`, `Worker`, `fetch`, `atob/btoa`);
   `pool-shim.mjs` bridges the browser-worker `onmessage`/`postMessage`
   globals that `worker_threads` does not provide;
3. drives the same message protocol the kiri client uses:
   `pool_start` → `slicePre` → `sync` (widget) → `slice` → `prepare`,
   with a single Rough op (`flats: true`, `all: true`, `inside: true`,
   `skipclear: true`, step 0.4, down 2 — see env knobs below);
4. prints phase times: `SLICE DONE in N ms`, `PREPARE DONE in N ms`.

## Usage

```bash
# reference model for the rough-flats work (cavity + wall ledge):
node bin/cam-bench/bench.mjs "/path/to/cup 3.1 L-longX.stl" 8   # Ø8
node bin/cam-bench/bench.mjs "/path/to/cup 3.1 L-longX.stl" 6   # Ø6
```

Reference timings on `cup 3.1 L-longX.stl` (44464 tris, 22 slices):
slice Ø8 ≈ 9–12 s, Ø6 ≈ 9–15 s (flats planes 30 / 27.5 / 5 / 1,
rough planes every 2 mm, stock top 35). A Ø6 slice of minutes means a
perf regression — see the case study below.

## Env knobs (rough op)

| var | default | meaning |
| --- | --- | --- |
| `STEP` | 0.4 | stepover (fraction of tool diameter) |
| `DOWN` | 2 | step down (mm) |
| `LEAVE` | 0 | rough leave_xy (mm) |
| `LEAVEZ` | 0 | rough leave_z (mm) |
| `ALL` | 1 | clear whole stock (0 = part shadow) |
| `INSIDE` | 1 | inside only |
| `SKIPCLEAR` | 1 | skip regions already cleared (stock model) |
| `SPIRAL` | 0 | stitch rings into a spiral |
| `STOCKRES` | auto | stock model grid resolution (mm/cell) |
| `MINION_LOG` | off | log minion traffic |

## Profiling recipe

```bash
node --cpu-prof --cpu-prof-dir=/tmp/cam-bench-prof bin/cam-bench/bench.mjs model.stl 6
```

Each thread writes a `.cpuprofile`. To find hot spots (self time per
function, and the caller chain of a given function):

```js
// node -e sketch: aggregate self time from a .cpuprofile
const p = JSON.parse(fs.readFileSync('CPU.<...>.cpuprofile'));
const nodes = new Map(p.nodes.map(n => [n.id, n]));
const dt = (p.endTime - p.startTime) / p.samples.length;
const self = new Map();
for (const s of p.samples) self.set(s, (self.get(s) || 0) + dt);
// build parent map, then aggregate by callFrame.functionName + url:line
```

Phase-level timing inside `freeAnchorRings` (op-area.js) can be added
temporarily with `Date.now()` checkpoints between its stages
(reach / clearedRegion / strip union / anchor / mat / ring loop /
coverage net) — the ring loop is where clipper-heavy work lives.

## Determinism check (same polygons before/after a change)

accept.mjs prints two geometry checksums every run:

- `FARRHASH` — order-, direction- and rotation-invariant multiset hash
  (FNV-1a over the sorted rounded point set) of the AUTHORED free-anchor
  ring sets, captured from the `[FARRJ]` worker channel before any
  emitter effect. The strict cross-build control for free-anchor work:
  a change that only reorders paths, reverses fragments or re-rotates
  closed ring starts hashes EQUAL; any moved/added/removed authored
  point flips it. Task #5f60fe5a acceptance: the fragment chaining fix
  must keep FARRHASH identical across builds.
- `CAMHASH` — the same invariant hash over the emitted CUTTING points
  (pure-vertical plunge/retract records excluded). COARSE: the emitter
  reacts to a new path order (closed-ring start rotation toward the new
  tool position, arc fitting from the rotated start), so an
  order-changing fix shifts a few emitted points by 1-2 mm along
  unchanged contours. Use it as a same-order tripwire, not for
  cross-build equality — FARRHASH is the cross-build geometry control.

`ACCEPT_LINKS=1` prints the per-link within-level travel breakdown of
check 10 (see below).

## Acceptance checks (accept.mjs)

Runs the 8 geometric/order checks of the rough-flats free-edge anchor
work (goal #7434434b), plus:

- check 9: every top-plane path model-true (task #c7a102e5);
- check 10: traversal chaining within broken ring levels (task
  #5f60fe5a). A ring contour broken into open fragments by the
  safe-zone clip must emit as a head-to-tail chain: freeAnchorRings
  orders each offset level's fragments (exact permutation search of the
  predicted emitted orientations for levels with >= 2 open fragments
  and <= 8 candidates, greedy nearest-start fallback) before the
  farrSeq stamp, and the inOrder emitter honors it. The harness
  re-runs the same solver over the authored `[FARRJ]` set (canonical
  candidate key + identical tie-breaking) and holds the emitted order
  to it: total within-level link travel within one stepover of the
  solved chain, no single link above the chain's own longest link +
  2x stepover, and every emitted open-fragment start on its predicted
  orientation (the downstream winding normalization fixes each open
  fragment's direction, so the generator must chain the orientation it
  will actually be emitted with). Self-relative — no travel budgets;
  the un-chained clipper order (80-95 mm cross-cavity jumps between
  fragments of ONE ring) fails by an order of magnitude.

## Case study: slice time 19x on Ø6 vs Ø8 (2026-11)

Symptom: slice Ø6 = 206 s vs Ø8 = 11 s on the reference model, same
planes. Profile: ~95 s of 107 s in `Clipper.PointInPolygon` via
`FixupFirstLefts2/Poly2ContainsPoly1` inside a single `POLY.subtract`
call — the fresh-material engagement bookkeeping in the
`freeAnchorRings` family loop (`fresh − removed`), run per ring on
stock-matrix ("pixel") contours: many holes + dense wiggle at clipper
scale 1e5 make Clipper's `StrictlySimple` post-pass quadratic
(isolated repro: same polygons, 61 s with `StrictlySimple=true`,
81 ms without).

Ø6 hits the pathological class because the stock model auto-resolution
is toolDiam/8 (0.75 mm vs Ø8's 1.0) — a finer matrix produces
hairier contours. Fix: `POLY.subtract` accepts
`{ strictlySimple: false }`, and the engagement subtract opts out
(its result feeds only area accounting and later even-odd clipper
passes; default behavior everywhere else is unchanged). Verified:
Ø6 9–11 s, Ø8 unchanged, emitted polygons byte-identical (camhash)
with both anchoring modes.
