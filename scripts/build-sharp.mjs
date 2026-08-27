/**
 * Builds `sharp` from source against the libvips the platform supplies.
 *
 * ADR-0013: the prebuilt `@img/sharp-linux-x64` statically bundles GLib and
 * exports its symbols, while Electron dynamically links the system GLib. One
 * process, two GLibs, one type registry each — `vips_init` registers its
 * operations in one and the lookup happens in the other, so the first decode
 * calls through a null function pointer and the process dies on SIGSEGV. A
 * source build links the same GLib Electron does, and there is only one.
 *
 * macOS and Windows keep the prebuilt: there is no system GLib there for a
 * bundled one to collide with.
 *
 * This runs from `postinstall` because `pnpm install` replaces the package and
 * takes `src/build/` with it. A source build that has to be remembered is a
 * source build that will be forgotten, and forgetting it does not fail — it
 * silently falls back to the prebuilt, which loads fine and segfaults later.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const log = (message) => console.log(`build-sharp: ${message}`);
const die = (message) => {
  console.error(`build-sharp: ${message}`);
  process.exit(1);
};

if (process.env.ROOST_SKIP_SHARP_BUILD === "1") {
  // Deliberately loud. A job that sets this has no business decoding an image,
  // and one that does will segfault under Electron rather than report anything.
  log("ROOST_SKIP_SHARP_BUILD=1 — skipping. sharp will segfault under Electron on Linux.");
  process.exit(0);
}

if (process.platform !== "linux") {
  log(`${process.platform} keeps the prebuilt binary (ADR-0013) — nothing to build`);
  process.exit(0);
}

// Resolved from the package that declares the dependency, the way the engine
// resolves it. pnpm's node_modules is strict and the root does not depend on
// sharp.
const requireFromMedia = createRequire(join(root, "packages/media/package.json"));
let sharpDir;
try {
  // sharp's `exports` does not expose `package.json`, so the entry point is
  // what can be resolved and the package root is two directories above it.
  sharpDir = dirname(dirname(requireFromMedia.resolve("sharp")));
} catch {
  die("sharp is not installed — run `pnpm install` first");
}

// Loaded by path rather than by specifier for the same reason. These are the
// helpers sharp itself uses to name the binary, so the name checked here is the
// name it will look for — `linuxmusl-x64` on Alpine, not `linux-x64`.
const require_ = createRequire(import.meta.url);
const { version } = require_(join(sharpDir, "package.json"));
const { runtimePlatformArch } = require_(join(sharpDir, "dist/libvips.cjs"));
const target = join(
  sharpDir,
  "src/build/Release",
  `sharp-${runtimePlatformArch()}-${version}.node`,
);
if (existsSync(target)) {
  log(`already built: ${target.slice(root.length)}`);
  process.exit(0);
}

const vips = spawnSync("pkg-config", ["--modversion", "vips-cpp"], { encoding: "utf8" });
if (vips.status !== 0) {
  die(
    "no system libvips: `pkg-config --modversion vips-cpp` failed.\n" +
      "  Install the development package (Fedora: vips-devel, Debian: libvips-dev).\n" +
      "  See docs/SETUP.md and ADR-0013.",
  );
}
log(`system libvips ${vips.stdout.trim()}`);

// sharp shells out to `node-gyp` by name, so the shim has to be findable. It is
// a root devDependency for exactly this reason.
const binDir = join(root, "node_modules/.bin");
if (!existsSync(join(binDir, "node-gyp"))) {
  die("node-gyp is not installed — run `pnpm install` first");
}

const build = spawnSync(process.execPath, ["install/build.js"], {
  cwd: sharpDir,
  stdio: "inherit",
  env: {
    ...process.env,
    // Without this, sharp 0.35 searches, finds the prebuilt, and keeps it.
    SHARP_FORCE_GLOBAL_LIBVIPS: "1",
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
  },
});
if (build.status !== 0) die(`node-gyp exited ${build.status ?? build.signal}`);
if (!existsSync(target)) die(`the build reported success but ${target} is not there`);

// The build producing a file is not the same as that file being the one that
// loads: sharp tries the source build first, but a stale name or a different
// arch would send it back to the prebuilt without saying so.
const loaded = spawnSync(
  process.execPath,
  [
    "-e",
    `require("sharp");
     const objects = process.report.getReport().sharedObjects;
     const binary = objects.find((o) => /[/\\\\]sharp-[^/\\\\]+\\.node$/.test(o));
     console.log(binary ?? "");`,
  ],
  { cwd: join(root, "packages/media"), encoding: "utf8" },
);
const binary = loaded.stdout.trim();
if (!binary.startsWith(sharpDir)) {
  die(`built ${target}, but sharp loaded ${binary || "nothing recognisable"}`);
}
log(`built and loading: ${binary.slice(sharpDir.length + 1)}`);
