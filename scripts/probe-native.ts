/**
 * Loads every native module under the runtime this script is started with, and
 * reports what it found.
 *
 * The engine runs on Electron's Node and the CLI on the system's — different
 * ABIs (127 and 148 as of Electron 43) — so a module that loads under one is
 * not thereby proven to load under the other. Both current modules are Node-API
 * and the same installed binary serves both (ADR-0009); this keeps that a
 * checked claim rather than a remembered one.
 *
 *   node --experimental-strip-types scripts/probe-native.ts          # this runtime
 *   node --experimental-strip-types scripts/probe-native.ts --both   # and Electron's
 *
 * Exits non-zero if any module fails to load or answers wrongly, so it can be a
 * CI step. `--both` needs Electron's binary present, which
 * `ELECTRON_SKIP_BINARY_DOWNLOAD` suppresses — the CI job that passes it clears
 * that variable for itself.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * Resolution starts from the package that declares the dependency, not from
 * this script.
 *
 * pnpm's node_modules is strict: a package sees only what it depends on, and
 * the root depends on neither of these. Resolving from the owner is also what
 * the engine and the CLI actually do, so the probe exercises the same lookup
 * rather than a flattened one that happens to work.
 */
const requireFrom = (pkg: string): NodeJS.Require =>
  createRequire(new URL(`../packages/${pkg}/package.json`, import.meta.url));

/** The published BLAKE3 digest of "abc". */
const BLAKE3_ABC = "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85";

/**
 * Each module, and one call that proves the binary actually works.
 *
 * "Works" means doing the module's real job, not loading. sharp's prebuilt
 * binary **loads** under Electron on Linux and then segfaults on the first
 * decode, because it carries its own GLib into a process that already links the
 * system's (ADR-0013). A probe that only called `require` reported that
 * combination as healthy.
 */
const MODULES: { name: string; probe: () => string | Promise<string> }[] = [
  {
    name: "better-sqlite3",
    probe: () => {
      const Database = requireFrom("core")("better-sqlite3");
      const db = new Database(":memory:");
      try {
        // FTS5 is not optional here: migration 0001 creates a virtual table
        // with it, so a build without it fails at `Db.open`, not at search.
        db.exec("CREATE VIRTUAL TABLE probe USING fts5(a)");
        const row = db.prepare("SELECT sqlite_version() AS v").get() as { v: string };
        return `sqlite ${row.v}, fts5 present`;
      } finally {
        db.close();
      }
    },
  },
  {
    name: "sharp",
    probe: async () => {
      const sharp = requireFrom("media")("sharp");
      const { vips } = sharp.versions as { vips: string };

      // Not a key count on `sharp.format`: a format is listed whether or not
      // this build can read or write it. And not a load-only check either —
      // see the note above. This decodes and encodes, which is where the
      // GLib collision actually fires.
      const png: Buffer = await sharp({
        create: { width: 320, height: 200, channels: 3, background: { r: 10, g: 80, b: 160 } },
      })
        .png()
        .toBuffer();
      const thumb: Buffer = await sharp(png)
        .resize({ width: 64, height: 64, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      const meta = (await sharp(thumb).metadata()) as { format: string; width: number };
      if (meta.format !== "webp" || meta.width !== 64) {
        throw new Error(`round-trip produced ${meta.format} ${meta.width}px`);
      }
      return `libvips ${vips}, decoded and encoded a ${thumb.length} B webp`;
    },
  },
  {
    name: "@napi-rs/blake-hash",
    probe: () => {
      const { Blake3Hasher } = requireFrom("media")("@napi-rs/blake-hash");
      const hasher = new Blake3Hasher();
      hasher.update(Buffer.from("abc"));
      const digest = hasher.digest("hex");
      // A module that loads but hashes differently is worse than one that
      // fails to load: it would put one asset at two addresses.
      if (digest !== BLAKE3_ABC) throw new Error(`digest ${digest}, expected ${BLAKE3_ABC}`);
      return "blake3 test vector matches";
    },
  },
];

async function probeThisRuntime(): Promise<boolean> {
  const runtime = process.versions.electron
    ? `Electron ${process.versions.electron} (Node ${process.versions.node})`
    : `Node ${process.versions.node}`;
  console.log(`${runtime}, ABI ${process.versions.modules}, ${process.platform}-${process.arch}`);

  let ok = true;
  for (const { name, probe } of MODULES) {
    try {
      console.log(`  ok    ${name} - ${await probe()}`);
    } catch (error) {
      ok = false;
      console.log(`  FAIL  ${name} - ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return ok;
}

/**
 * Runs this same file under Electron's Node.
 *
 * The path comes from the `electron` package rather than being spelled out,
 * because it is `electron.exe` on Windows and this job runs on three platforms.
 */
function probeUnderElectron(): boolean {
  const electron = createRequire(import.meta.url)("electron") as unknown;
  if (typeof electron !== "string") {
    console.log("  FAIL  electron - binary not installed (ELECTRON_SKIP_BINARY_DOWNLOAD?)");
    return false;
  }

  const result = spawnSync(electron, [fileURLToPath(import.meta.url)], {
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });

  // A module that takes the process down leaves no message of its own, so the
  // listing simply stops mid-way and the reason has to be reported from here.
  // This is not hypothetical: it is exactly what sharp's prebuilt does under
  // Electron on Linux (ADR-0013).
  if (result.signal !== null) {
    console.log(`  FAIL  the runtime died on ${result.signal} while probing the module above`);
    return false;
  }
  return result.status === 0;
}

let ok = await probeThisRuntime();
if (process.argv.includes("--both") && !process.versions.electron) {
  console.log("");
  ok = probeUnderElectron() && ok;
}
process.exitCode = ok ? 0 : 1;
