# Roost — Benchmarks

Status: **first results in** · Last updated: 2026-10-01

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
| Grid ordered by name | **28.6 ms** before, **0.05 ms** after migration 0014 | One index per sort key; ADR-0039 |
| First grid page | **369–435 ms** on 96,666 assets | M3 |
| Dropped frames, reading speed | **none**, across three consecutive runs | M3, on WebKitGTK |
| Dropped frames, flinging | **0.25%** through 79,800 assets | M3, on WebKitGTK |
| Thumbnail storage | **9.4 GB** per 1M assets | Grid size eager, preview size on first use; 34 GB if both were eager. In `thumbs/roost.db` since ADR-0051 |
| `index.db` without the pictures | **358 MiB** at 1M assets | ADR-0051 |
| Derive after a rebuild | **4.93 s → 0.20 s** for 1,000 photographs | ADR-0051: kept, not drawn |

Two of those deserve a note before they are used as targets.

**The frame numbers were measured on a weaker webview than this one.** Chromium should make them
easier, not harder, which means matching them is the floor and not the achievement.

**The cold-start budget is the one that got harder.** `CONCEPT.md` §7 asks for under 1.5s to an
interactive grid on a 100k-asset library. Electron starts heavier than Tauri, so this is the
target now under pressure — and it is measured from M3, the first milestone that has a window,
rather than assumed until someone complains.

## 3. Results

### 2026-10-01 — a folder's count, its subtree's, each asset once (ADR-0036 §6)

Machine: Fedora 44 host, Intel Core Ultra 7 155H, NVMe. A throwaway script, not kept, against a
synthetic index on the real schema: **1,000,000 assets**, 2 % in the trash, **3,330 folders** three
deep (30 × 10 × 10), and 1.1 million memberships — 70 % of assets in one folder, 20 % in two, 10 %
in none. That is far more filing than an ordinary library, on purpose. Each figure is the mean of
five warm runs, and the two correct ones agreed with a recursive-CTE reference on all 3,330 folders.

| What the sidebar reads | Time |
| --- | --- |
| Each folder's own live count, one join from every membership to its asset (before) | 3.7 s |
| The same with the planner left to choose the order of the trash join | 7.4 s |
| A recursive CTE and `count(DISTINCT)` per ancestor, the obvious correct one | 12.3 s |
| Every membership, `GROUP BY folder_id` | 27 ms |
| The trashed memberships, through `idx_assets_trashed`, `CROSS JOIN` | 18 ms |
| The assets in two folders or more, one `group_concat` over the membership key | 0.25 s |

**What it revealed.** The sidebar had been paying **3.7 s** at this size for a number it got wrong.
The join looked up the asset behind every membership to leave out the trash, where the trash is two
per cent and has a partial index of its own: counting everything and subtracting the trash is
**45 ms**. Without statistics the planner walked the trash join from the wrong end (7.4 s), so the
order is fixed with `CROSS JOIN`. Counting an asset once costs only the assets held more than once,
which is a fifth of them here and few in a real library; one ordered pass over the membership key
with `group_concat` hands them over in 0.25 s, against 0.74 s for a window function over the same
rows and 0.6 s just to stream every membership to JavaScript. In total the sidebar's folder counts
went from 3.7 s and wrong to about 0.3 s and right. **`tags()` has the same join** and was not
measured; it is on `TODO.md`.

### 2026-09-27 — counting an import before it starts (ADR-0055 §3.1)

Machine: Fedora 44 host, Intel Core Ultra 7 155H, NVMe. A throwaway script, not kept, walked `/usr`
the way `discover` does, with and without a `stat` per file, twice. The figures are the second
run, with the cache warm.

| Walk | 209,032 files, 9.1 GiB |
| --- | --- |
| Directory entries only | 1.6 s |
| With a `stat` per file, one at a time | 4.1 s |
| With a `stat` per file, eight at a time | 2.3 s |

**What it revealed.** Counting costs about 11 µs a file once the `stat`s overlap, which is why
`measure` runs eight at a time. Beside an import at 2,000 to 5,000 files a second it adds 2 to 5 %,
and it buys a bar with a total from the first byte. The first run was slower (2.7 s for the entries
alone), which is the cold-cache case, and a hard disk or a network share would be slower still;
neither was measured. One mistake is worth recording: a first version summed the sizes with
`bytes += (await stat(p)).size`, which reads `bytes` before the `await`, and under eight at a time
it lost three quarters of the total (2.1 GiB of 9.1). `measure` adds after the `stat` returns.

### 2026-09-27 — a copy that can be counted and stopped (ADR-0054 §3.9)

Machine: Fedora 44 host, Intel Core Ultra 7 155H. A throwaway script, not kept, copied one
512 MiB file of random bytes from the repository's Btrfs to `/dev/shm`, three rounds, first with
`fs/promises.copyFile` and then through `FileStore.put` with `onBytes`, which takes the counted
path (4 MiB chunks, read and write in turn). The reflink rung refuses across a device, so both are
full copies. The source was in the page cache after the first round.

| Round | `copyFile` | Counted |
| --- | --- | --- |
| 1 | 135 ms | 173 ms |
| 2 | 135 ms | 162 ms |
| 3 | 133 ms | 172 ms |

**What it revealed.** The counted copy costs about a quarter more where nothing but memory is the
limit: 3.0 GB/s against 3.8 GB/s. That case is the least likely one for a transfer. The case the
counted copy exists for is a file of several gigabytes going onto a hard disk that writes about
0.15 GB/s, where the copy waits on the disk and the difference cannot be seen. The import path
passes no options and keeps `copyFile`, so an import costs what it did.

Not measured, and worth knowing: **a transfer reads each file twice**, once to hash it and once to
copy it. On a spinning source disk that is the larger cost, and doing both in one pass is in
`TODO.md`.

### 2026-09-26 — thumbnails in a database of their own (ADR-0051)

Machine: Fedora 44 host, Intel Core Ultra 7 155H, on the SSD rather than tmpfs.
`scripts/bench-pictures.ts scratch --assets 1000000 --files 1000`. The first part builds an index of
1,000,000 assets, each with a 256 thumbnail of **64 bytes** in the attached `thumbs/roost.db`,
because what is measured there is the plans across two files, not the bytes. It then runs
`optimize = 0x10002`, which analyses every table. The second part is a real library of 1,000
JPEG photographs at 1600×1200.

| | Result |
| --- | --- |
| Folder covers, 100,000 members spread across the library | 2.41 ms p50, 3.53 ms max |
| Folder covers, 20 old members | 0.08 ms p50, 0.49 ms max |
| Backfill sweep with nothing to queue, old predicate (picture missing) | 344 ms |
| The same, new predicate (`derived_at IS NULL OR` picture missing) | 366 ms |
| Cleaner, 10,000 strays among 1,000,000 | 357 ms |
| `index.db` at 1,000,000 assets, without pictures | **358 MiB** |
| 1,000 photographs: first derive | 4.93 s, 1,000 drawn |
| The same after `rebuild` (0.09 s) | **0.20 s, 1,000 kept, 0 drawn** |

**What it revealed.** The point of the change is the last two rows. The derive pass after a rebuild
fell by a factor of 25 on photographs, and it will fall by more on video, where drawing means an
ffmpeg spawn and keeping still means a `stat`. At a million photographs that is the difference
between about 80 minutes of placeholders and about three minutes of `stat`s. The index at a million
assets is 358 MiB, where the pictures alone had been 9.4 GB inside it.

The costs are small and where they were expected. The folder covers cross into the attached file
for their picture probe, at 2.41 ms against the 1.59 ms measured on 2026-09-25. That run was on a
different day's build, so the comparison is indicative, and both are far inside a frame. The sweep
pays 6% for its second question. The cleaner's 357 ms runs after a fold or a rebuild, never on an
ordinary open.

**One mistake the tests caught rather than the reasoning.** A test helper applied journal records
through `IndexSink` outside a transaction. The sink batches, so it left one open, and a thumbnail
written afterwards was visible on the same connection and **absent from the file** once the
connection closed. The test reading the file back failed, which is what it was for. Every caller
in the engine already wraps the sink.

### 2026-09-25 — a picture onto the clipboard (ADR-0034 §5)

Machine: Fedora 44 host, KDE Plasma. Electron 43.4.1, and a 6000×4000 JPEG (24 megapixels) made
for the purpose. The clipboard was read back with `wl-paste`. The window ran under XWayland
(`--ozone-platform=x11`), because Wayland refuses a clipboard write from a window without the
focus and KDE does not give the focus to a window a script opens.

| Step | Time | Size |
| --- | --- | --- |
| JPEG → PNG in sharp, zlib level 0 | 122 ms | 72.1 MB |
| JPEG → PNG in sharp, zlib level 1 | 555 ms | 18.1 MB |
| JPEG → PNG in sharp, zlib level 6 (the default) | 2,047 ms | 12.4 MB |
| `clipboard.writeImage(nativeImage.createFromBuffer(png))`, main's thread | 654–722 ms | re-encoded, 17.0 MB |
| `clipboard.writeBuffer("image/png", png)`, main's thread | 32–34 ms | the same bytes |
| `wl-paste -t image/png` reading the 18 MB back | 142 ms | |

**What it revealed** is that the obvious API was the expensive one. `writeImage` takes a
`NativeImage`, which is a bitmap, so a PNG handed to it is decoded and then encoded again, both on
the thread that answers every request from the window. That is two-thirds of a second of a frozen
engine router for one copy. The clipboard on Linux wants `image/png`, which the bytes already are,
and `writeBuffer` under that name offers exactly the format `writeImage` offers (checked with
`wl-paste --list-types`) and costs one copy of the buffer. Level 1 is the encode to use. The encode
runs on libvips' threads, so its time is a wait rather than a stall. A clipboard manager keeps
every picture it sees, so 72 MB per copy is the wrong direction to save half a second in.

### 2026-09-25 — the four pictures on a folder's tile (ADR-0043 §7)

Machine: Fedora 44 host. An index built from `0001_initial.sql` with **1,000,000 assets**, every one
with a 256 thumbnail, then `ANALYZE`. `Repo.folderCovers([folder], 256, 4)`, ten runs each.

| Folder | p50 | max |
| --- | --- | --- |
| 100,000 members, spread across the library | 1.59 ms | 2.28 ms |
| 20 members | 0.06 ms | 0.40 ms |
| no members, one subfolder of 10 | 0.11 ms | 0.40 ms |
| 5,000 members, all old | 4.40 ms | 5.43 ms |
| 30,000 members, all old (the walk finds nothing, falls back) | 56.8 ms | 63.4 ms |

**What it revealed** is that one statement could not serve both ends. The first draft did the
whole subtree in a recursive CTE with a `GROUP BY`, and took **~390 ms for every folder, small or
large**. SQLite drove it from `assets` in primary-key order and visited the whole library. Per
folder, driven from `idx_asset_folders_folder` with `CROSS JOIN` pinning the order, a small folder
fell to 0.04 ms, but sorting a large one's members still cost 80 ms at 100,000. Walking
`idx_assets_imported` newest-first and stopping at four matches does that one in 3 ms, and costs
140 ms for 5,000 members that are all old. So a member count, which takes 1.5 ms at 100,000,
chooses the plan: up to 20,000 are sorted, and more than that are walked, with the walk bounded to
the newest 50,000. The last row is that bound doing its job. A large folder with nothing recent
pays the walk and then the sort, and it is the one case above 5 ms.

### 2026-09-24 — why a cell has no picture, read beside every page (`UI_SPEC.md` §6.1)

Machine: Fedora 44 host, the same as above. An in-memory index built from `0001_initial.sql` with
**1,000,000 assets**, a tenth of them holding a stalled derive job (half `blocked`, half `failed`),
then `ANALYZE`. The statement is `Repo.stalledReasons`, asked for 200 consecutive ids from a random
point — a page of the grid — 500 times.

| | p50 | p95 |
| --- | --- | --- |
| 200 ids, `json_each` joined to `jobs` | 0.221 ms | 0.522 ms |

The plan is `SCAN e VIRTUAL TABLE INDEX 1 | SEARCH j USING INDEX sqlite_autoindex_jobs_1 (kind=?
AND asset_id=?)`: one seek per card on the table's own `UNIQUE (kind, asset_id)`, and no index
added for it.

**What it revealed** is mostly why it is a second statement rather than a column. Joined into the
page query it would cost the same for the indexed orders, which read only the rows they return —
and for `random`, which has no index and sorts every match before `LIMIT` (ADR-0039, 18.4 ms a
page), it would be evaluated for all of them first. Read after the page, it is a fixed 200 seeks
whatever the order, and half a millisecond against a p95 search budget of 100 ms.

### 2026-09-24 — what opening a library costs, and the watcher that was most of it

Machine: Fedora 44 host, the same as 2026-09-23. The library has 100,000 files from `roost
fixture --count 100000 --size 2048` (95,001 after deduplication). None of them can be thumbnailed,
so every asset stays in the derive queue, which is the worst case for the backfill sweep. The
timings come from probes that drive `Library.open`, `EngineHost.handle` and a real window, and
each was run two to three times.

**The engine's reply to an ordinary `library:open`: 1,568–1,671 ms before, 248–314 ms after.**

| Step | ms | Notes |
| --- | --- | --- |
| `Library.open`, index matches the journal | 15–18 | |
| `Library.open`, journal folded | 2,298–2,375 | only after 100% is reached: 13 ms |
| `enqueueMissing` | 172–216 | runs before the reply, on every open |
| `watchFiles`, recursive `fs.watch` | 1,330–1,428 | **the event loop ran 0 ticks** |
| `watchFiles`, one watch per shard | 41 | |
| `catchUp` | 7,086–7,660 | not awaited; worst loop gap 7 ms |
| `library:stats` | 24–29 | |

Recursive `fs.watch` over the same `files/` directory on its own took 1,334 ms on Node 22.23.1
and **1,116 ms on Electron's Node 24.18.1**, blocking the loop for all of it.

**In the window**, from a click on a recent row to the first cells:

| | before | after |
| --- | --- | --- |
| index matches the journal | the engine alone was ~1.6 s | 0.76 s |
| journal folded | bar at 100% held for 1.2 s | 2.57 s, with 0.2 s of *Getting it ready* |

#### What it revealed

**The watcher added in ADR-0047 was most of the cost of opening a library.** Node's recursive
`fs.watch` on Linux does not simply ask the kernel. It walks every file under the directory, in
JavaScript and synchronously, before the call returns. The inotify count ADR-0047 worked out was
right, but it never measured what placing those watches costs. The call is fire-and-forget, so
nothing ever waited on it on purpose. Because it holds the event loop, though, `library:open`'s
reply and every request the window sends after it waited behind it. Watching each shard
directory is the same set of inotify watches without the walk (ADR-0047 §10).

**The first probe was misleading, and in a way worth remembering.** It timed `Library.open` and
`enqueueMissing`, came to about 0.2 s, and that figure was given to the user as the time an
ordinary open takes. Timing `EngineHost` from end to end gave 1.6 s. Anything the open starts
and does not await still counts toward the open if it runs synchronously.

**What remains before the reply is `enqueueMissing`,** about 200 ms here, and the fixture is its
worst case: every row is a candidate, and every candidate reaches the `ON CONFLICT` of a job that
is already queued. In a library whose pictures are drawn, the `NOT EXISTS` probes answer from
the index. It is in `TODO.md` rather than fixed.

**`catchUp` took 7 s at 100,000 files**, which is about a minute at a million. It does not block
anything, but it runs alongside the first pages the window asks for.

### 2026-09-23 — what a running derive queue costs everything else

**Machine:** Fedora 44 on the host, Intel Core Ultra 7 155H, 22 threads, 30 GB RAM, Node 22.23.1,
sharp 0.35.3 against libvips 8.18.3, ffmpeg 8.1.2. The engine's threadpool as main forks it
(`UV_THREADPOOL_SIZE=22`) unless a row says otherwise.

Asked by the user: *does the "Deriving… N to go" line make everything slower?* Measured with
`scripts/bench-contention.ts`, which works the queue at a fixed concurrency while it asks for a
grid page every 25 ms **on the same event loop** — timed from when the page was due, so waiting
behind the loop is charged — and times a fixed slice of arithmetic on another thread, which
stands in for main and the renderer. Two corpora: `roost fixture --count 4000 --real-images
--seed 7` (3,889 imported: JPEG, PNG and WebP gradients, and SVG, PDF and MP4 files of random
bytes that fail fast), and 80 H.264 clips, 1080p, 20 s, made with ffmpeg's `testsrc2`.

**Pictures: nothing to fix.**

| Derive | Jobs/s | Cores | Page p50 | Page p95 | Page p99 | Loop p99 | Neighbour slice |
| --- | --- | --- | --- | --- | --- | --- | --- |
| idle | — | 0.3 | 0.74 ms | 1.04 ms | 1.42 ms | 6.14 ms | 1.00× |
| 16 at once | 458 | 8.9 | 0.28 ms | 1.21 ms | 2.25 ms | 6.39 ms | 1.21× |
| 8 | 323 | 5.4 | 0.45 ms | 1.07 ms | 1.52 ms | 6.57 ms | 1.09× |
| 4 | 217 | 3.2 | 0.28 ms | 0.94 ms | 1.18 ms | 5.98 ms | 1.03× |
| 4, pinned to 4 cores | 224 | 2.9 | 0.35 ms | 2.10 ms | 3.01 ms | 7.70 ms | 1.05× |

(*Cores* is this process's CPU over the run, the neighbour thread's ~0.3 included. The loop's
p99 has a floor of the histogram's 5 ms resolution.) libvips does its work off the event loop,
and a thumbnail from a 1200×800 source is cheap enough that even on four cores the neighbour
lost 5%. The hypothesis that brought this here — derive starving the query — is **wrong for
pictures**.

**Videos: the event loop is what pays, and it was paying in bursts.**

| Runner | Derive | Jobs/s | Page p95 | Page p99 | Loop p99 |
| --- | --- | --- | --- | --- | --- |
| A batch at a time | 16 at once | 16–17 | 5.2–11.7 ms | **50–67 ms** | 18–25 ms |
| A batch at a time | 4 | 9 | 2.3 ms | 8.8 ms | 10.9 ms |
| One job at a time | 16 at once | 18 | 10.4–10.7 ms | **17–27 ms** | 18 ms |
| One job at a time | 4 | 8 | 2.2–3.3 ms | 5.8–8.1 ms | 11 ms |

A CPU profile of the engine thread over 80 clips put **spawn at ~960 ms** of it (`spawn` plus
`normalizeSpawnArguments`), against 564 ms for BLAKE3 and very little else. `child_process.spawn`
is synchronous — a `fork` and an `exec` of a process holding a few hundred megabytes — at
**~5.5 ms each** (p50, 326 MB RSS), and a clip is two of them. The runner claimed a batch of 32,
started sixteen at once, and waited for all 32 before claiming again, so every batch began with
sixteen ffprobe spawns back to back: ~80 ms in which no page could be answered. Claiming one job
per free worker spreads the spawns out and costs nothing in throughput; p99 fell by two to three
times.

What is left is the spawn itself, and it is not cheap to remove. Passing a snapshot of the
environment instead of letting Node enumerate `process.env` saved 0.4 ms of the 5.5, which is not
worth a second copy of the environment. The real lever is spawning from a worker thread, whose
event loop can block without the engine's noticing — recorded in `TODO.md` rather than done.

**The queue's own bookkeeping was the one thing that got worse with size.** Measured on a
synthetic `jobs` table with migration 0001's indexes, a million rows, 1% of them blocked:

| Query | As it was | Now | Why |
| --- | --- | --- | --- |
| Claim the next job | **69.9 ms** | 0.002 ms | SQLite seeked on `kind` through `UNIQUE (kind, asset_id)` and sorted every ready row; `+kind` sends it down `idx_jobs_ready` in order |
| Count each state (`jobCounts`) | **238.8 ms** | ~20 ms | A `GROUP BY` over the table; now a covered count per kind, less the unfinished rows grouped through their partial index (0.35 ms) |
| Blocked reasons | 25.6 ms | 6.8 ms | `state = ?` could not prove the partial index applies; a redundant `state <> 'ready'` lets it |

At 100,000 queued the claim was 6.5 ms and the counts 18 ms — invisible at the sizes anybody had
tried, and paid **per batch** by the runner and again by the status line, on exactly the library
that has a million queued: one opened for the first time, or just rebuilt. `job:progress` is now
sent at most once a second, since the window only uses it as a cue to re-read.

**What is on screen goes first.** The last half of the question was about order. The queue
worked by priority and then by arrival, so a window opened on 2,000 undrawn pictures drew the
screen it opened on **last**: an import queues files in the order it met them and the grid shows
the newest import first. A thumbnail miss is now passed from main to the engine as
`derive:wanted`. `scripts/check-derive-order.mjs`, with the engine's threadpool at one so the
queue takes long enough to watch:

| | Screen drawn after | Still queued then |
| --- | --- | --- |
| With `derive:wanted` | **451–454 ms** | 1,919 of 2,000 |
| Without | 11,284 ms | 287 of 2,000 |

**What it revealed.** Three things. Contention is a property of the **format**, not of the
queue: pictures cost the rest of the application nothing, and a video costs the engine's event
loop two process spawns. The costs that grow with the library were in **SQL nobody had run at
size**, which is where they always are. And the first draft of the window check **passed with
the feature switched off**, twice: once because it scrolled to the part of the grid the queue does
first anyway, and once because it read `v=` in a thumbnail's address as "drawn" when import has
already put one there. It was only trusted after it failed without the hint.

### 2026-09-21 — what libvips' operation cache is worth on the derive path (ADR-0047)

**Machine:** Windows 11, the development machine · **sharp** against the prebuilt libvips.

`CLAUDE.md` §8 requires a measurement rather than a guess before a cache is changed, and this
one is a **correctness** change with a performance question attached rather than the reverse.
RL-21 forbids holding a file under `files/` in a way that stops another application writing to
it, renaming it or deleting it. libvips maps every file it reads and the operation cache holds the
mapping for the life of the process, so on Windows a file Roost has thumbnailed cannot be replaced
by the application the user opened it from. The knob is `sharp.cache({ files: 0 })`, and the
question is what it costs.

120 generated 512×512 PNGs, each through `derive` once, plus an animated GIF:

| | Cache on | Cache off |
|---|---|---|
| 120 files through `derive` | **1478 ms** | **1463 ms** |
| Files a second | 81.2 | 82.0 |
| Can the PNG be unlinked afterwards? | yes | yes |
| Can the **animated GIF** be unlinked afterwards? | **no — `EBUSY`** | **yes** |

**It buys nothing here, and it was costing a requirement.** The derive path opens each file
once, thumbnails it, hashes it and never reads it again, which is the one access pattern an
operation cache cannot help — the 15 ms between the two runs is noise, and the run without the
cache was the faster of the two.

Three things came out of it.

**The format is what exposed it, not the change.** `TODO.md` had carried this since 2026-09-11 as
a test-cleanup annoyance — *"libvips keeps the file it read mapped, and Windows will not unlink an
open file"* — with two test teardowns tolerating it and the product knowing nothing about it. Under
version 1 that was nearly true: files under `originals/` were immutable, so nothing wanted to write
one. Under version 2 it is the workspace failing, and it fails the way RL-21 says it does — Word
reports *"the file is in use"* and blames nobody.

**Only the animated GIF reproduced it.** A plain `sharp(path).resize().webp()` released the file
on this machine either way; it took the real `derive` path and a multi-page image to hold one. A
measurement that had stopped at the hand-rolled pipeline would have concluded there was nothing to
fix.

**It fixed a failing test nobody had connected to it.** `packages/media/src/derive.test.ts`'s
animated-GIF case had been failing on Windows with `EBUSY` since the machine moved there, and had
been recorded as a known failure in two session logs. It passes now. The suite went from *1 failed*
to green without that test being touched.

### 2026-09-10 — HEIC, and what it costs to assemble one (ADR-0040)

Machine: Fedora 44 in distrobox, 22 cores, 30 GB RAM, Btrfs on NVMe. Node 22.23.1, libheif 1.21.2
with the libde265 1.0.18 plugin, sharp 0.35.3 against libvips 8.18.3 (source build), ffmpeg 8.1.2.
Measured **twice on purpose**: once on the generated corpus, which is what makes runs comparable,
and once on a real iPhone photograph, which is what the backend exists for.

**The corpus**, `node --experimental-strip-types scripts/bench-derive.ts --each 8`:

| Format | ms | Per second |
| --- | --- | --- |
| JPEG 4000×3000 | 17.2 | 58 |
| PNG 1600×1200 | 44.0 | 23 |
| SVG, 200 paths | 27.1 | 37 |
| Font specimen | 12.5 | 80 |
| PDF first page | 10.3 | 97 |
| RAW embedded preview | 9.4 | 106 |
| **HEIC 3024×4032** | **710.4** | **1** |
| Video frame (720p, 10 s) | 225.0 | 4 |
| Audio waveform (60 s MP3) | 216.5 | 5 |

**A real iPhone photograph**, 3024×4032 in 48 tiles of 512×512, six runs each:

| Step | ms |
| --- | --- |
| `heif-dec` alone, to JPEG q88 | 180–200 |
| `heif-dec` alone, to PNG | **1,350** |
| `derive`, grid size only | 227 |
| `derive`, grid **and** preview size | 279 |
| `renderForBrowser`, what the preview pane asks for | 325 |

Four readings.

**The intermediate is a JPEG because PNG costs seven times as much.** 1.35 s against 0.19 s for the
same picture, all of it compression — a file that exists only until sharp has read it. It is the
one decision in `heif.ts` that a reader would otherwise assume was arbitrary.

**A photograph in tiles decodes faster than one that is not.** The generated fixture is a single
3024×4032 HEVC image and costs **710 ms**; the real photograph is the same size cut into 48 tiles
and costs 227 ms end to end. libde265 has 48 independent pieces to work on there and one long
scan here, and the corpus number is therefore a **worst case** rather than a typical one — worth
knowing before anybody optimises against it.

**HEIC is the second-slowest backend, and it belongs on the queue for the same reason video does.**
At 227 ms a thousand photographs is nearly four minutes. That is background work by any reading
(ADR-0017's argument, arriving again), and it is why the derive queue commits per batch and why a
library of iPhone photographs fills in rather than blocking on import.

**A rendition costs about what a derive does**, 325 ms, which is why `roost://render/` is left to
the ordinary HTTP cache rather than stored: it is cheap enough to make again on the next open, and
storing it would be megabytes per asset plus a derived column `rebuild` has to account for
(invariant 1).

### 2026-09-09 — the orders a view menu can ask for (ADR-0039)

Machine: Fedora 44 in distrobox, 22 cores, 30 GB RAM, Btrfs on NVMe. Node 22.23.1. 95,001 assets
from `roost fixture --count 100000 --size 2048 --seed 5`, warm page cache. Measured through
`MATCH_LIVE`, which is the scope every grid query carries and the scope every index is partial to —
a query without it cannot use one and would measure a plan no window ever asks for.

**The first page of the unfiltered grid, before and after migration 0014's indexes:**

| Order | Without an index | With | Plan without |
| --- | --- | --- | --- |
| `added` (the only order there was) | 0.07 ms | **0.07 ms** | index seek |
| `name` | 28.6 ms | **0.05 ms** | TEMP B-TREE |
| `size` | 30.4 ms | **0.06 ms** | TEMP B-TREE |
| `created` | 28.0 ms | **0.06 ms** | TEMP B-TREE |
| `rating` | 31.1 ms | **0.07 ms** | TEMP B-TREE |

The 28–35 ms is SQLite reading the whole match set into a sorter to produce one screen — the same
plan migration 0005 was written to avoid, arriving again through a different door. At a million
assets it is ~300 ms against a 100 ms p95 budget, which is why every key gets an index and why
`random` is the one that cannot.

**Resuming: one predicate against two seeks.** Page 500, walked by cursor:

| Order | `key ≥ @k AND (key > @k OR hash > @h)` | Two seeks, `UNION ALL` |
| --- | --- | --- |
| `rating` | 5.82 ms | **0.06 ms** |
| `created` | 3.66 ms | **0.06 ms** |
| `name` | 3.38 ms | **0.04 ms** |
| `size` | 2.11 ms | **0.05 ms** |

This is the measurement that decided the shape of `searchSql`. Written as one predicate, SQLite
seeks on the key and then **walks the entire run of rows sharing it** — invisible in any fixture
small enough to write down, and unavoidable in real data: a rating has six values, and this fixture
has one distinct size across 95,001 rows, which is the worst case a library can present. Split into
a seek for *the same key, a later hash* and a seek for *beyond the key*, both halves are ranges over
an index that already holds `(key, hash)`.

**Every order, at the first page and at page 200** (`scripts/bench-search.ts`):

| Order | First page p95 | Page 200 p95 |
| --- | --- | --- |
| `added` | 0.11 ms | 0.14 ms |
| `created` | 0.11 ms | 0.17 ms |
| `name` | 0.27 ms | 0.14 ms |
| `size` | 0.11 ms | 0.17 ms |
| `rating` | 0.11 ms | 0.16 ms |
| `random` | **18.39 ms** | **24.00 ms** |

**What this revealed.** Three things, and the third is the one worth carrying forward.

- **A mixed order is what made the resume hard, and it was removable.** `hash` ascending under a
  descending timestamp meant one index served a single direction and the cursor could not be a
  comparison of the pair — a comment `searchSql` had carried since M2. Turning the tie-break to
  follow the key made both directions of every key one index walk, forwards or backwards.
- **`random` costs what it costs, and it is constant.** 18.4 ms at page 1 and 24.0 ms at page 200:
  the seeded rotation of the hash is a full index scan with a sorter every time, so paging into it
  does not get worse — it is simply never cheap. At a million that is ~200 ms, above the search
  budget, and ADR-0039 §5 accepts it deliberately rather than shipping a shuffle that is one fixed
  cyclic order.
- **A filtered sort is the number nobody has paid for yet.** `ext:png` ordered by name is 10.46 ms
  and by size 6.52 ms, against 0.10 ms for the same filter in the default order: SQLite seeks the
  filter's index and sorts the ~19,000 matches. Fixing it means a composite index per key *per
  filter*, five by four, all maintained on every insert against a ≥300 imports/sec target. Recorded
  here so the trade is visible if a library ever makes it matter.

**Correctness at scale, checked with the timings**: every one of the six orders, both directions,
paged the whole library — 951 pages of 100 — and returned each of the 95,001 assets exactly once,
including the two pathological keys this fixture has (one distinct size, no ratings at all).

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
