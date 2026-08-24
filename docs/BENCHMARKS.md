# Roost — Benchmarks

Status: **first results in** · Last updated: 2026-08-24

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

### 2026-08-24 — thumbnails, and where sharp can run (M1)

Machine: Fedora 44 in distrobox, 22 cores, 30 GB RAM, Btrfs on NVMe.
Node 22.23.1 (ABI 127) and Electron 43.4.1 (Node 24.18.1, ABI 148).
sharp 0.35.3 / libvips 8.18.3 in all three builds.

One import's worth of work: decode a 4000x3000 JPEG, downscale to the 256 px grid size,
encode WebP q80 — the thumbnail the schema actually stores. `UV_THREADPOOL_SIZE` set to the
core count for the concurrent column, as `ARCHITECTURE.md` §3.3 requires.

| Build | Node, sequential | Node, concurrency 64 | Electron, concurrency 64 |
| --- | --- | --- | --- |
| Prebuilt `@img/sharp-linux-x64` | 8.9 ms | **623/sec** | **SIGSEGV** |
| Built from source against system libvips | 8.1 ms | 612/sec | 342/sec |
| `@img/sharp-wasm32` | 12.2 ms | **101/sec** | 105/sec |

**What this revealed, first.** The prebuilt sharp **loads** under Electron and then segfaults on
the first decode, in `sharp::OpenInput`, calling through a null function pointer — a GObject
lookup against a type registered in a different GLib. The prebuilt bundles its own GLib and
exports its symbols; the Electron binary dynamically links the system's. Two registries, one
process. ADR-0013 has the stack and the options.

The check that had passed this module was `require()`. It is now a decode and an encode, in
`scripts/probe-native.ts`, and it fails today on Linux under Electron — correctly.

**What this revealed, second, and it is the more transferable half.** WASM is 1.4x slower per
thumbnail and **6.2x slower under concurrency**. It does not scale across libuv's threadpool the
way the native build does, so the sequential figure — the natural one to quote, and the one a
micro-benchmark produces — understates the real cost by more than four times.

`TODO.md` §4.2 records the Rust build's version of this trap: end-to-end timing hid a regression
that a micro-benchmark showed as a straight line. This is the same trap from the other side, and
the rule that covers both is that a number is only about the concurrency it was taken at.

**Against the budget.** `CONCEPT.md` §7 asks for at least 300 imports/sec. Native clears it
twice over even inside Electron; WASM does not clear it at all. That is what makes ADR-0013 a
decision rather than a preference.

### 2026-08-24 — content hashing (M1)

Machine: Fedora 44 in distrobox, 22 cores, 30 GB RAM, Btrfs on NVMe. Node 22.23.1.
Files served from the page cache, so these measure hashing plus buffer copies, not the disk.

**Choosing the binding.** Two BLAKE3 implementations, hashing 256 MiB in 256 KiB chunks with
no file I/O at all:

| Implementation | Throughput |
| --- | --- |
| `@napi-rs/blake-hash` (Node-API native) | **3089 MiB/s** |
| `hash-wasm` (WASM) | 463 MiB/s |

A 6.7× difference, which is what settles ADR-0009's "native, not WASM" for hashing. Both agree
with the published BLAKE3 vectors for `""` and `"abc"`.

**Through the file path**, which is what import actually pays:

| Case | Per file | Effective |
| --- | --- | --- |
| Full hash, 50 MiB | 50.9 ms | 982 MiB/s |
| Full hash, 1 MiB | 1.17 ms | 852 MiB/s |
| Partial hash, 64 MiB file | 0.28 ms | reads 128 KiB, not 64 MiB |

**What this revealed.** The hasher alone runs at 3089 MiB/s and the file path delivers 982 —
so **two thirds of the time is spent getting bytes to it**, not hashing them. That is a lead
for later (a larger read buffer, or the binding's own `digestStream`), not a problem now:
1.17 ms per megabyte-sized file leaves room for ≥300 files/sec several times over, before the
worker pool multiplies it.

It also lands within a few percent of the Rust implementation on the same work — `roost-old`
importing the same fixtures reported ~1020 MB/s of hashing. That is the expected result rather
than a pleasant surprise: both call native BLAKE3, and the bottleneck is on the other side of
the call. It is worth recording because the fear that motivated `CONCEPT.md` §8's "a JS engine
is slower than the Rust one it replaces" does not apply where the work is already native.

**The partial scheme is doing its job.** A 64 MiB file costs 0.28 ms because it reads 128 KiB.
At 4 GB, that number does not change.
