# Roost — Benchmarks

Status: **first results in** · Last updated: 2026-08-28

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

### 2026-08-29 — deriving, per backend (M4)

Machine: Fedora 44 in distrobox, 22 cores, 30 GB RAM, Btrfs on NVMe. Node 22.23.1, sharp 0.35.3
against libvips 8.18.3 (source build), resvg 2.6.2 and pdfium 2.1.13 in WebAssembly, ffmpeg
8.1.2. Method: `node --experimental-strip-types scripts/bench-derive.ts --each 20`, one warm-up
per format so a WASM module's one-time initialisation is not charged to whichever backend
happened to be measured first.

| Format | ms | Per second |
| --- | --- | --- |
| JPEG 4000×3000 | 17.0 | 59 |
| PNG 1600×1200 | 43.6 | 23 |
| SVG, 200 paths | 27.4 | 36 |
| Font specimen | 6.6 | 151 |
| PDF first page | 8.7 | 115 |
| RAW embedded preview | 8.2 | 122 |
| Video frame (720p, 10 s) | 243.5 | 4 |
| Audio waveform (60 s MP3) | 232.8 | 4 |

**A 12-megapixel JPEG is two and a half times faster than a 2-megapixel PNG**, which reads like
a mistake and is not: libvips shrinks a JPEG during its DCT pass, so a thumbnail never decodes
the full image, while a PNG has to be decompressed whole before anything can be resized. The
comment in `decoder.ts` says this is why each size is rendered from the original rather than
chained — the measurement is what it was claiming.

**Video and audio are two orders of magnitude slower, and both are process start.** ADR-0017
measured 0.10 s for an `ffprobe` run on a 1 MB file, which is not reading a megabyte — it is
starting a process. Two spawns per asset is the whole cost, and it is the reason M4 put deriving
behind a queue instead of inside import.

**RAW is as cheap as a PDF page**, because nothing demosaics: the camera's own JPEG preview is
extracted from the TIFF directories and scaled. That is the whole argument for ADR's approach to
RAW, in one number.

#### The threadpool nobody was widening

Corpus: `roost fixture --count 2000 --real-images` (1,301 images averaging 640 KiB, 1.2 GiB),
imported and then derived through the CLI. Warm cache, same corpus each run.

| `UV_THREADPOOL_SIZE` | Thumbnails/sec |
| --- | --- |
| 4 (libuv's default) | 205 |
| Set at the top of `main.ts` | **181** |
| 22, set before the process started | **252–327** |

`ARCHITECTURE.md` §3.3 had said since M1 that the engine raises this at start. Nothing did —
and nothing could: **libuv reads the variable once and creates the pool on first use**, and by
the time an entry point runs, module loading has already used it. The middle row is what a
placebo looks like when it is measured instead of assumed.

What works is setting it for a process that has not started yet, so main now forks the engine
with it set (`threadPoolEnv`), and `roost doctor` prints the pool this process actually got. A
CLI cannot fix its own, so it says what setting it is worth instead.

**Import over the same corpus: 2,178 files/sec**, against `CONCEPT.md` §7's floor of 300 — and
deriving is now separate work, which is what the queue is for. Import no longer waits on
pictures.

### 2026-08-28 — cold start and scroll frames (M3 acceptance)

Machine: Fedora 44 in distrobox, 22 cores, 30 GB RAM, Btrfs on NVMe. Electron 43.4.1 on
Wayland, 120 Hz display. 100,000 assets from `roost fixture --count 100000 --size 2048`,
imported managed, none of them renderable — so every cell is a placeholder at 1:1 and the grid
is doing layout and virtualization rather than decoding pictures.
`node scripts/bench-window.mjs <LIBRARY>`, four runs.

**Cold start — process launch to a grid with rows in it**

| Run | ms | of which, opening the library |
| --- | --- | --- |
| 1 | 833 | 124 |
| 2 | 763 | — |
| 3 | 786 | — |
| 4 | 874 | — |

**Budget is 1,500 ms** (`CONCEPT.md` §7). Between 763 and 874, so roughly half of it, on a
library at the target size. Opening the library itself is ~120 ms of that; the rest is
Chromium.

**Scroll — driven at 40 px per frame for five seconds**

| Run | fps | steady | median | p95 | p99 | worst | hitches | over 60fps |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 110.6 | 120 Hz | 8.3 ms | 16.7 | 16.7 | 30.4 | 7.9% | 5.2% |
| 2 | 113.2 | 120 Hz | 8.3 ms | 16.6 | 16.7 | 31.9 | 5.6% | 4.9% |
| 3 | 114.2 | 120 Hz | 8.3 ms | 16.6 | 16.7 | 16.9 | 5.1% | 3.3% |
| 4 | 96.0 | 119 Hz | 8.3 ms | 16.7 | 24.9 | 33.3 | 23.5% | 15.0% |

**Budget is 60fps.** The worst of four runs held 96, and the median frame never left 8.3 ms.

#### What it revealed

**Reading frames against 60 on a 120 Hz screen is a measurement bug, and the first run had it.**
The benchmark originally counted a dropped frame as any interval over 16.67 ms and reported
13.29% "dropped" — while running at 98 fps. At 120 Hz a skipped vsync *is* 16.7 ms, and against
a 60fps budget that reads as on-time; against the panel it is a miss. It now reports both, and
the rate the run actually held, derived from the median interval. A run that is *uniformly*
slower shows up in that rate rather than in the hitch count, which is the honest place for it —
nothing hitched, the whole run was slower.

**The variance between runs is larger than the headroom looks.** Run 4 held 96 fps with 23.5%
hitches against runs 2 and 3 at 114 with 5%. Four runs on a machine that is also compiling
TypeScript is not a controlled measurement; what the numbers support is "comfortably past 60",
not a defended figure to three digits.

**The benchmark refuses rather than reporting a throttled window**, and that refusal fired
first: Chromium throttles `requestAnimationFrame` for a hidden or occluded window, and the
numbers from one are not slow — they are meaningless. `roost-old` recorded 0.25% dropped frames
while flinging through 79,800 assets, and a throttled run reporting 200 ms frames would read as
a catastrophic regression against it.

**Cold start is Chromium's, not the library's.** Opening 100,000 assets costs ~120 ms of the
~800; the engine's `utilityProcess` is started before the window so its cost overlaps
(ADR-0006). The number to watch as M4 adds work is the difference between this and the same
measurement on an empty library, which was 699 ms.

### 2026-08-26 — search and paging (M2)

Machine: Fedora 44 in distrobox, 22 cores, 30 GB RAM, Btrfs on NVMe. Node 22.23.1.
95,001 assets from `roost fixture --count 100000 --seed 5`, all tagged `corpus`, with 5,000
carrying a second tag, 3,000 rated, 1,000 favourited, and 2,000 in a folder. Warm page cache.
`scripts/bench-search.ts`, 50 runs per query, one page of 100.

| Query | Compile p95 | Run p95 | Run p50 | Hits |
| --- | --- | --- | --- | --- |
| `ext:png` | 0.09 ms | **0.12 ms** | 0.08 ms | 100 |
| `tag:corpus` | 0.01 ms | 0.17 ms | 0.11 ms | 100 |
| `tag:"oak wood"` | 0.01 ms | 0.13 ms | 0.12 ms | 100 |
| `rating:>=4` | 0.05 ms | 0.11 ms | 0.09 ms | 100 |
| `is:favorite` | 0.01 ms | 0.08 ms | 0.08 ms | 100 |
| `ext:png OR ext:jpg OR ext:mp4` | 0.03 ms | 0.28 ms | 0.14 ms | 100 |
| `tag:corpus -ext:png rating:>=1` | 0.01 ms | 0.19 ms | 0.13 ms | 100 |
| `folder:Design` | 0.08 ms | 0.12 ms | 0.09 ms | 100 |
| `asset-0000083` (free text, selective) | 0.01 ms | 0.16 ms | 0.12 ms | 1 |
| `asset` (free text, matches everything) | 0.07 ms | **22.57 ms** | 21.27 ms | 100 |
| `size:>1mb` (matches nothing) | 0.21 ms | **24.48 ms** | 21.97 ms | 0 |
| `is:untagged` (matches nothing) | 0.04 ms | **32.33 ms** | 29.12 ms | 0 |

**Against the budget.** `CONCEPT.md` §7 asks for a p95 under 100 ms. The worst query here is
32 ms and the typical one is a fifth of a millisecond, so M2 clears it with room. The Rust
baseline was 6–30 ms on 95k, and this sits in the same band.

**What this revealed.** The cost is set by **how many rows have to be examined to fill a page,
not by how large the library is.** Every query that fills its page of 100 from an index costs
under 0.3 ms whatever the library holds. The three expensive ones are expensive for one reason:
they cannot stop early.

- A query matching *nothing* is the worst case, not the best. `size:>1mb` and `is:untagged` both
  return zero rows here, and proving that means walking all 95,001. This is the opposite of the
  intuition a search box gives, and it is worth knowing before someone reports "searching for
  something that is not there is slow" as a bug.
- Free text is fast when the term is selective and slow when it is not: 0.16 ms for a term one
  asset carries, 22.57 ms for one every asset carries. The compiled form is
  `a.rowid IN (SELECT rowid FROM assets_fts WHERE assets_fts MATCH ?)`, and the subquery
  materialises every matching rowid before the ordering and the limit are applied. A term that
  matches everything therefore materialises everything. Nothing to fix at this size; the note is
  here so that the shape of the fix — pushing the limit into the FTS side — is already known if
  1M assets makes it matter.

**Paging is flat.** 200 consecutive pages of 100, keyset, never `OFFSET`: **0.22 ms p95 across
the first ten pages and 0.29 ms across the last ten.** Page 200 costs what page 1 costs, which is
the claim `repo.searchSql` makes about writing the cursor timestamp as one named parameter used
twice. The Rust implementation measured 23x on page 200 of a 50,000-asset library when that same
value was written as two parameters, so this is a number worth being able to watch move.

**Rebuild and doctor, on the same library.** `roost rebuild` replayed **201,003 records in 5.1 s**
— roughly 39,000 records per second — and landed on the same 95,001 assets, with every tag,
rating, favourite, and folder membership intact. `roost doctor` is 0.5 s shallow and **18.9 s
deep**, the difference being that deep re-hashes all 371 MiB. That is the price of the only check
that sees silent corruption, and it is why it is opt-in.

### 2026-08-25 — M1 acceptance, end to end

`ROADMAP.md`'s own gate for M1, run through the `roost` binary rather than through a test
harness. 10,000 synthetic images, 6.0 GiB, generated with `--real-images` so the thumbnail path
is real work.

| Step | Result |
| --- | --- |
| `roost import` | 9,722 imported of 10,000 scanned, 278 duplicates, 4.03 s, **2,481 files/sec** |
| `roost import` again | **0 imported, 10,000 duplicates** — a true no-op |
| `roost thumb` | 6,500 generated, 3,222 assets this build cannot draw, 59.7 MiB of WebP |
| `roost stats` | 9,722 assets, 5.9 GiB, schema 5 |
| `originals/` | **256 shard directories, 0 at a second level** |
| Library root | exactly four entries: `index.db`, `journal`, `library.json`, `originals` |
| Object names | every file `<64-hex>[.ext]`, no exceptions |
| Loose thumbnail files | **none** — 6,500 rows and 59.7 MiB of BLOB inside `index.db` |
| `roost rebuild` | 9,722 before, 9,722 after, thumbnails discarded as they must be |

The 3,222 undrawable assets are the `mp4`, `pdf`, and `svg` thirds of the fixture's extension
cycle. They import, carry tags, and have no thumbnail — which is the promise `ARCHITECTURE.md`
§3.3 makes about a missing backend, and the first time it has been exercised at scale.

**Thumbnails ran at 195/sec here against 623/sec in the micro-benchmark**, on *smaller* images.
The difference is everything the micro-benchmark left out: reading 6 GiB off disk instead of a
warm buffer, a 64-byte header sniff per file before the decode, and 60 MiB of BLOB inserts. It
is the same lesson as the WASM concurrency number in the other direction — a rate is only about
the conditions it was taken under — and it is why acceptance runs through the binary.

**Import ran at 2,481 files/sec** rather than the 6,883 measured on 24 KiB files, because these
average 640 KiB and the hash reads all of them. That is the number a real photo library will
see, and it is still eight times the floor.

### 2026-08-25 — the import pipeline (M1)

Machine: Fedora 44 in distrobox, 22 cores, 30 GB RAM, Btrfs on NVMe. Node 22.23.1.
Corpus: 20,000 files, 24 KiB each, 5% duplicates, 445 MiB — generated by **`roost-old`'s own
`roost fixture`**, so both builds import byte-identical input on the same machine.

| Build | Wall | Files/sec | CPU |
| --- | --- | --- | --- |
| Rust (`../roost-old`) | 1.04 s | **18,805** | **98%** |
| TypeScript, sequential | 5.88 s | 3,400 | — |
| TypeScript, 8 files in flight | 2.91 s | **6,883** | 199% |

Against `CONCEPT.md` §7's floor of 300 imports/sec, the slowest of these clears it eleven times
over. The gap to the Rust build is 2.7x and worth understanding rather than shrugging at.

**The hypothesis was wrong, and the measurement is what said so.** The obvious explanation for a
sequential JavaScript pipeline losing to Rust is that the Rust one is parallel. It is not:
`/usr/bin/time` puts it at **98% CPU** — one core, start to finish — while this build sits at
199% and still takes three times as long. In total CPU that is 1.02 core-seconds against 6.24:
**six times the work per file**, spent on promise allocation, libuv round-trips, and the garbage
they make. Concurrency did not remove that cost. It spread it across cores, which is why it
bought 2x in wall clock and nothing at all in CPU.

**Where the time goes, isolated.** The placement path alone — `stat`, `mkdir`, clone, `rename`
— over 5,000 files:

| Variant | Files/sec |
| --- | --- |
| As implemented | 6,035 |
| Caching which shards exist | 6,485 |
| Without the existence check | 9,188 |
| Cloning straight to the destination, no temp file | 12,858 |

The last two are not available. The existence check is what makes `put` idempotent, and the
temp-and-rename is what keeps a torn write from appearing at a real content address — a file
that would look like valid content named by a hash it does not have. The shard cache is worth 7%
and was left out: at eight in flight the `mkdir` calls overlap anyway, and a cache that goes
stale when a directory is removed underneath it is not worth 7% of a stage that is not the
bottleneck.

**Concurrency plateaus at four, not at the core count.**

| In flight | 1 | 2 | 4 | 8 | 16 | 32 |
| --- | --- | --- | --- | --- | --- | --- |
| Placement path, files/sec | 6,277 | 13,340 | 20,027 | 23,339 | 21,782 | 23,959 |
| Whole pipeline, files/sec | 3,400 | — | 6,786 | 6,883 | 7,176 | 7,234 |

Past four, the pipeline is flat inside its own noise — one run at eight gave 6,883 and another
6,324. The bottleneck has moved off the filesystem and onto the single thread doing BLAKE3
updates, `sharp` metadata reads, and the JavaScript around them. Eight is kept as the setting
because it is the middle of the plateau and a slower disk would want the queue.

**`UV_THREADPOOL_SIZE` does nothing here, and that corrects a general claim.**
`ARCHITECTURE.md` §3.3 tells the engine to raise it to the core count. Measured against the
placement path, widening the pool changed nothing at every concurrency up to 16 and made 32
*slower* — 14,100/sec against 23,959. The advice is right and stays, but it is about `sharp`,
which does real CPU work on those threads. A `stat` or a `rename` is a short kernel call that
the pool cannot help with, and §3.3 now says which workload it means.

**A units trap, noted before it becomes a bug report.** The Rust CLI prints `445.3 MB` where
this build's harness printed `467.0 MB` for the same 19,001 files. Neither is wrong and nothing
disagrees: 445.3 MiB is 467.0 MB. The CLI should print MiB, so that two implementations reporting
one library do not look like they disagree about its size.

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
