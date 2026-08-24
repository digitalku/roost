# Roost — Benchmarks

Status: **empty, on purpose** · Last updated: 2026-08-24

Nothing has been measured in this implementation, because nothing has been built. What this
file holds today is the **baseline**: the numbers the Rust implementation at `../roost-old`
actually recorded, on the same machine, against the same fixture generator and the same library
format.

They are not aspirations. They are what this application already did once, and they are what a
regression is measured against.

---

## 1. How measurements are taken here

Two scales, and both are needed:

- **End to end.** `roost fixture` builds a reproducible synthetic library from a seed; the CLI
  imports, queries, and pages it, and reports per-stage timings. This is what the product
  actually costs.
- **Micro.** Per-package benchmarks fine enough to see a query plan change. `roost-old` learned
  this the expensive way: end-to-end timing read a 2.5× climb in paging cost as noise for a day,
  and the first micro-benchmark run showed it as a clean straight line.

Every entry below must record the machine, the library size, and — this is the part that makes
the file worth keeping — **what the measurement revealed**. A number with no finding attached is
a number nobody will act on.

## 2. Baseline: the Rust implementation

Source: `../roost-old/docs/BENCHMARKS.md`. Read that file for the full method and the option
tables behind each decision.

| What | Baseline | Where it came from |
| --- | --- | --- |
| Import throughput | **4,900 files/sec** at 100k assets | M1, against a target of ≥300/sec |
| Search p95 | **6–30 ms** on 95k assets | M2, against a budget of <100 ms at 1M |
| Grid filter query (`ext:png`) | **18.9 ms** before, **0.51 ms** after migration 0005 | The sort key inside the filter index; 37× |
| First grid page | **369–435 ms** on 96,666 assets | M3 |
| Dropped frames, reading speed | **none**, across three consecutive runs | M3, on WebKitGTK |
| Dropped frames, flinging | **0.25%** through 79,800 assets | M3, on WebKitGTK |
| Thumbnail storage | **9.4 GB** per 1M assets | Grid size eager, preview size on first use; 34 GB if both were eager |

Two of those deserve a note before they are used as targets.

**The frame numbers were measured on a weaker webview than this one.** Chromium should make them
easier, not harder, which means matching them is the floor and not the achievement.

**The cold-start budget is the one that got harder.** `CONCEPT.md` §7 asks for under 1.5s to an
interactive grid on a 100k-asset library. Electron starts heavier than Tauri, so this is the
target now under pressure — and it is measured from M3, the first milestone that has a window,
rather than assumed until someone complains.

## 3. Results

Nothing yet. The first entry lands with M1.
