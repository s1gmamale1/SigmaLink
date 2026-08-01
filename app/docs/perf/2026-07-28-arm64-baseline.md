# arm64 baseline — ROADMAP Phase 2

**Filename keeps the `2026-07-28` phase id** (it is the artifact the Phase 2
Definition of Done names). The measurement itself was taken **2026-08-01**, on
the first day the operator was running a native-arm64 install.

| | |
|---|---|
| Build measured | `SigmaLink.app` **3.0.0**, installed from `SigmaLink-3.0.0-arm64.dmg` |
| Host | Apple Silicon (M4), macOS 26.4 (25E246) |
| Uptime at capture | renderer A launched 2026-07-31 00:21, sampled after **~47 h** |
| Tooling | `footprint -p`, `vmmap -summary`, `lipo -archs` |

> ⚠️ **This build predates every optimization in Phases 3–5.** v3.0.0 was tagged
> 2026-07-14; the arch-aware updater, the package prune and the scrollback RAM
> brake all merged after it (`5d33351`, unreleased). Both columns below are
> therefore *pre-optimization* — which is exactly what a baseline is for. Do not
> read the arm64 column as "the saving from Phase 5".

---

## 1. Native execution confirmed

```
$ lipo -archs /Applications/SigmaLink.app/Contents/MacOS/SigmaLink
arm64

$ vmmap -summary <pid> | grep -ci rosetta      # all six processes
0
```

`vmmap` also self-reports `Code Type: ARM64` for the renderer. Zero Rosetta
regions on **all six** processes — main, GPU, both renderers, both utility
helpers. Phase 2's "`vmmap` confirms zero Rosetta regions" clause is met.

---

## 2. A/B footprint table

x64 column: recorded from the operator's then-running Rosetta-translated v3.0.0
(the source for `ROADMAP.md:87`). arm64 column: this capture.

| Process | x64 under Rosetta | native arm64 | Δ |
|---|---:|---:|---:|
| main | 389 MB | **146 MB** | −243 MB |
| renderer A (heavy) | 1684 MB | **715 MB** | −969 MB |
| renderer B | 757 MB | **414 MB** | −343 MB |
| GPU helper | 464 MB | **461 MB** | −3 MB |
| utility helpers (×2) | 44 MB | **26 MB** | −18 MB |
| **total** | **3338 MB** | **1761 MB** | **−1577 MB (−47%)** |

Peaks on the arm64 run (`vmmap` "Physical footprint (peak)"): main 331.8 MB ·
renderer A 942.9 MB · renderer B 466.7 MB · GPU **1.2 GB** · utilities ~14 MB.
The GPU helper's peak is the largest single excursion in the whole app and is
the one process the arm64 switch did **not** improve.

### ⚠️ The workloads are not identical — read the total as indicative

The x64 run was recorded at **17 live panes / 2 windows**. This capture is
**14 sessions in `running` state / 2 windows** (168 not-yet-closed rows across
21 workspaces in `agent_sessions`). That is a ~18% workload gap in SigmaLink's
single heaviest per-unit cost, and it is not correctable after the fact — the
x64 install is gone.

So: **the −47% total is not a controlled A/B and must not be quoted as the
Rosetta saving.** The controlled findings are the two below.

---

## 3. What is actually load-bearing

**a. Rosetta translation arenas: 468 MB → 0 MB.** This one *is* clean. The x64
run carried 468 MB across `Rosetta JIT` / `Generic` / `IndirectBranch` / `Arena`
regions; the arm64 run has no such regions at all, on any process. That is a
pure-translation tax that the native build deletes outright, independent of pane
count.

**b. The heavy renderer's own working set is ~336 MB, not ~715 MB.** Region
table for renderer A (pid 38345):

| | |
|---|---:|
| resident | 795.7 MB |
| **dirty** | **335.9 MB** |
| swapped out | 377.8 MB |
| region count | 20717 |

Top dirty contributors:

| Region | dirty | resident | count |
|---|---:|---:|---:|
| Memory Tag 255 (V8 / Blink heaps) | 260.6 MB | 260.6 MB | 4494 |
| Memory Tag 253 | 67.8 MB | 68.2 MB | 10368 |
| `__DATA_CONST` | 2.1 MB | 18.4 MB | 1029 |
| `__DATA` | 0.8 MB | 8.6 MB | 971 |
| `__TEXT` | 0 MB | 337.5 MB | 1051 |

`__TEXT` is 337.5 MB **resident but zero dirty** — file-backed library code
shared across processes. It inflates every per-process footprint reading and no
amount of app-side optimization touches it.

**Consequence for Phase 5.** The reclaimable target in the heavy renderer is the
~261 MB of V8/Blink heap (Tag 255), not the 715 MB headline and certainly not
the 1684 MB x64 one. A tuning constant chosen against "1684 MB" is calibrated
against a number that is ~5× the addressable working set. `ROADMAP.md:322`'s
renderer decomposition should be re-derived from this table before any further
tuning — it was inferred from the x64 run.

---

## 4. Reproducing this

```sh
lipo -archs /Applications/SigmaLink.app/Contents/MacOS/SigmaLink   # expect: arm64
pgrep -f 'SigmaLink' | while read p; do
  printf '%s ' "$p"; footprint -p "$p" | grep phys_footprint
done
vmmap -summary <heavy-renderer-pid> | grep -i rosetta              # expect: empty
vmmap -summary <heavy-renderer-pid> | sed -n '/REGION TYPE/,/^$/p'
```

Record the pane count in the same breath as the footprints, or the next A/B has
the same defect this one does.
