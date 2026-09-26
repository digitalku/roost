/**
 * Measures what moving the thumbnails into their own database costs and buys
 * (ADR-0051 §10).
 *
 *   node --experimental-strip-types scripts/bench-pictures.ts <SCRATCH>
 *     [--assets 1000000] [--files 1000]
 *
 * Two parts, in a directory the script creates and deletes. Put it on a real
 * disk rather than tmpfs, or the sizes and the `stat`s measure memory.
 *
 * **At scale**, an index of `--assets` assets, each with a 256 thumbnail in
 * the attached `thumbs/roost.db`. The pictures are 64 bytes, because what is
 * measured here is the query plans across the two files, not the bytes: the
 * folder covers, the backfill sweep that now also asks `derived_at IS NULL`,
 * and the cleaner's `NOT IN`.
 *
 * **A rebuild**, a real library of `--files` JPEG photographs: derived once,
 * rebuilt, and derived again. The second pass is the one ADR-0051 exists for.
 */
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Db, IndexSink, parseAssetId, THUMBNAILS_FILE } from "@roost/core";
import { enqueueMissing, importInto, Library, runDerives } from "@roost/library";
import { GRID_SIZE, gradient } from "@roost/media";

const { values, positionals } = parseArgs({
  options: { assets: { type: "string" }, files: { type: "string" } },
  allowPositionals: true,
  strict: true,
});

const scratch = positionals[0];
if (scratch === undefined) {
  console.error("usage: bench-pictures.ts <SCRATCH> [--assets N] [--files N]");
  process.exit(2);
}
const assets = Number(values.assets ?? 1_000_000);
const files = Number(values.files ?? 1_000);
const work = join(scratch, `bench-pictures-${process.pid}`);

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A valid, distinct id for asset `n`: `n` in Crockford base32, padded. */
function idFor(n: number): ReturnType<typeof parseAssetId> {
  let text = "";
  for (let rest = n; text.length < 12; rest = Math.floor(rest / 32)) {
    text = (ALPHABET[rest % 32] ?? "0") + text;
  }
  return parseAssetId(text);
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = fn();
  return { value, ms: performance.now() - started };
}

async function timedAsync<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - started };
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

const ms = (value: number): string => `${value.toFixed(2)} ms`;
const mib = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

async function atScale(): Promise<void> {
  const root = join(work, "scale");
  await mkdir(root, { recursive: true });
  const db = Db.open(join(root, "index.db"));
  const picture = Buffer.alloc(64, 7);
  const BIG = 1;
  const SMALL = 2;

  const built = timed(() => {
    const sink = new IndexSink(db);
    db.transaction(() => {
      sink.apply({ ts: 1, op: "folder_create", id: BIG, parent: null, name: "big" });
      sink.apply({ ts: 1, op: "folder_create", id: SMALL, parent: null, name: "small" });
    });
    for (let start = 0; start < assets; start += 50_000) {
      db.transaction(() => {
        for (let n = start; n < Math.min(assets, start + 50_000); n += 1) {
          const id = idFor(n);
          sink.apply({ ts: 1_700_000_000 + n, op: "add", id, ext: "jpg", name: `p${n}` });
          // A hundred thousand spread across the library, and twenty old ones.
          if (n % Math.max(1, Math.floor(assets / 100_000)) === 0) {
            sink.apply({ ts: 1, op: "folder_add", asset: id, folder: BIG });
          }
          if (n < 20) sink.apply({ ts: 1, op: "folder_add", asset: id, folder: SMALL });
          db.repo.putThumbnail(id, GRID_SIZE, 256, 192, picture);
          db.repo.putDerived(id, { size: 1000 + n, mtime: 1_700_000_000 }, 1);
        }
      });
    }
  });
  // ANALYZE every table, as the earlier covers bench did: `0x10000` checks
  // tables nothing has queried yet, `0x02` analyses them.
  db.pragma("optimize = 0x10002");
  console.log(`built ${assets.toLocaleString()} assets in ${(built.ms / 1000).toFixed(1)} s`);

  for (const [label, folder] of [
    ["folder covers, 100,000 members spread", BIG],
    ["folder covers, 20 old members", SMALL],
  ] as const) {
    const samples: number[] = [];
    for (let run = 0; run < 10; run += 1) {
      samples.push(timed(() => db.repo.folderCovers([folder], GRID_SIZE, 4)).ms);
    }
    console.log(`${label}: p50 ${ms(percentile(samples, 0.5))}, max ${ms(Math.max(...samples))}`);
  }

  // What the queue sweep costs with nothing to do, and then with every asset
  // unmeasured, which is what a rebuild leaves now that the pictures stay.
  const idle = timed(() => db.repo.enqueueMissingDerives("derive", [GRID_SIZE], 0, 1, assets));
  console.log(`sweep, nothing to queue: ${ms(idle.ms)} (${idle.value} queued)`);

  // Strays, as a rebuild of a library that lost one asset in a hundred leaves.
  const strays = Math.floor(assets / 100);
  db.transaction(() => {
    for (let n = 0; n < strays; n += 1) {
      db.repo.putThumbnail(idFor(assets + n), GRID_SIZE, 256, 192, picture);
    }
  });
  const pruned = timed(() => db.repo.prunePictures());
  console.log(`cleaner: ${pruned.value.toLocaleString()} strays removed in ${ms(pruned.ms)}`);
  const reclaimed = timed(() => db.reclaimPictureSpace());
  console.log(`reclaim: ${mib(reclaimed.value)} handed back in ${ms(reclaimed.ms)}`);

  db.close();
  const index = await stat(join(root, "index.db"));
  const pictures = await stat(join(root, THUMBNAILS_FILE));
  console.log(
    `index.db ${mib(index.size)}, thumbs/roost.db ${mib(pictures.size)} (64-byte pictures)`,
  );
}

async function aRebuild(): Promise<void> {
  const root = join(work, "rebuild");
  const source = join(root, "photographs");
  await mkdir(source, { recursive: true });
  for (let n = 0; n < files; n += 1) {
    await writeFile(join(source, `p${n}.jpg`), await gradient(1600, 1200, n, "jpeg"));
  }

  const library = await Library.create(join(root, "library"), "bench");
  try {
    await importInto(library, [source]);
    const derive = async () => {
      enqueueMissing(library, [GRID_SIZE]);
      return runDerives(library, { sizes: [GRID_SIZE] });
    };

    const first = await timedAsync(derive);
    const replayed = await timedAsync(() => library.rebuild());
    const second = await timedAsync(derive);

    console.log(`${files} photographs, 1600×1200 JPEG`);
    console.log(
      `  first derive:  ${(first.ms / 1000).toFixed(2)} s, ${first.value.thumbnails} drawn`,
    );
    console.log(`  rebuild:       ${(replayed.ms / 1000).toFixed(2)} s`);
    console.log(
      `  derive after:  ${(second.ms / 1000).toFixed(2)} s, ` +
        `${second.value.kept} kept, ${second.value.thumbnails} drawn`,
    );
    console.log(`  thumbnails still held: ${library.stats().thumbnails}`);
  } finally {
    await library.close();
  }
  const left = await readdir(join(root, "library"));
  console.log(`  library root: ${left.sort().join(", ")}`);
}

try {
  await atScale();
  await aRebuild();
} finally {
  await rm(work, { recursive: true, force: true });
}
