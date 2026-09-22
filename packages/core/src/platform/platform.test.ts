import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnsupportedPlatformError } from "../model/index.js";
import { tmpfsDir } from "../testing/mounts.js";
import { reflinkSupported } from "./caps.js";
import {
  APP_NAME,
  cacheDir,
  configDir,
  dataDir,
  logDir,
  resolveKnownFolder,
  resolveXdg,
  stateDir,
} from "./dirs.js";
import { acquireLockAt, lockPathFor } from "./lock.js";

const onLinux = process.platform === "linux";
const onWindows = process.platform === "win32";

describe("XDG directories", () => {
  // The rule is the assertion, not the separator: `join` is what the code under
  // test uses, and spelling these out with `/` would fail on Windows for a
  // reason that has nothing to do with XDG.
  it("prefers an absolute value from the environment", () => {
    expect(resolveXdg("/custom/config", "/home/u", ".config")).toBe(
      join("/custom/config", APP_NAME),
    );
  });

  it("ignores a relative value, as the specification requires", () => {
    // Honouring it would put user data somewhere different depending on the
    // working directory the process happened to start in.
    expect(resolveXdg("relative/path", "/home/u", ".config")).toBe(
      join("/home/u", ".config", APP_NAME),
    );
  });

  it("falls back under HOME when the variable is unset or empty", () => {
    expect(resolveXdg(undefined, "/home/u", ".local/state")).toBe(
      join("/home/u", ".local/state", APP_NAME),
    );
    expect(resolveXdg("", "/home/u", ".cache")).toBe(join("/home/u", ".cache", APP_NAME));
  });

  it("refuses rather than guessing when there is no HOME either", () => {
    expect(() => resolveXdg(undefined, undefined, ".config")).toThrow(UnsupportedPlatformError);
  });

  it.runIf(onLinux)("puts every directory under the application name", () => {
    for (const dir of [configDir(), dataDir(), stateDir(), cacheDir()]) {
      expect(basename(dir)).toBe(APP_NAME);
    }
    expect(logDir().endsWith(`${APP_NAME}/logs`)).toBe(true);
  });

  it.runIf(!onLinux && !onWindows)(
    "refuses to invent a layout for a platform nobody designed for",
    () => {
      // Runs on the CI matrix, so portability rot appears the day it does rather
      // than at the first port.
      expect(() => configDir()).toThrow(UnsupportedPlatformError);
    },
  );
});

describe("Windows known folders", () => {
  it("puts the role under the application name, not beside it", () => {
    // Two roots, four directories: `%APPDATA%\roost` serving as both config and
    // data would give two of them one namespace (ADR-0041 §2).
    //
    // `win32.join` on both sides, and unguarded, because the rule is about
    // Windows paths rather than about the machine running the suite. With the
    // ambient `node:path` this case could only pass on Windows, and passed
    // there for months while the assertion it was making went unchecked
    // everywhere else.
    expect(resolveKnownFolder("C:\\Users\\u\\AppData\\Roaming", "APPDATA", "config")).toBe(
      win32.join("C:\\Users\\u\\AppData\\Roaming", APP_NAME, "config"),
    );
  });

  it("refuses rather than guessing when the variable is missing or relative", () => {
    // Absent is a broken environment, not a configuration to accommodate; a
    // relative value would move user data with the working directory.
    expect(() => resolveKnownFolder(undefined, "APPDATA", "config")).toThrow(
      UnsupportedPlatformError,
    );
    expect(() => resolveKnownFolder("", "LOCALAPPDATA", "state")).toThrow(UnsupportedPlatformError);
    expect(() => resolveKnownFolder("AppData\\Local", "LOCALAPPDATA", "state")).toThrow(
      UnsupportedPlatformError,
    );
  });

  it.runIf(onWindows)("splits what roams from what must not", () => {
    // `lockDir()` is under `stateDir()` and a lock file records a pid, which
    // means nothing on any machine but the one that issued it.
    expect(configDir()).toBe(join(String(process.env["APPDATA"]), APP_NAME, "config"));
    expect(dataDir()).toBe(join(String(process.env["APPDATA"]), APP_NAME, "data"));
    expect(stateDir()).toBe(join(String(process.env["LOCALAPPDATA"]), APP_NAME, "state"));
    expect(cacheDir()).toBe(join(String(process.env["LOCALAPPDATA"]), APP_NAME, "cache"));
    expect(logDir()).toBe(join(stateDir(), "logs"));
  });
});

describe("the instance lock", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-lock-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A lock inside a scratch directory: the real one is under `$XDG_STATE_HOME`. */
  const scratch = (): string => join(dir, "test.pid");

  it("is held until it is released", async () => {
    const outcome = await acquireLockAt(scratch());
    expect(outcome.kind).toBe("acquired");
    if (outcome.kind !== "acquired") return;

    expect(await readFile(outcome.lock.path, "utf8")).toBe(String(process.pid));
    await outcome.lock.release();

    // Releasing has to actually free it, not just forget it.
    const again = await acquireLockAt(scratch());
    expect(again.kind).toBe("acquired");
  });

  it("takes over a lock left behind by a crashed process", async () => {
    // A pid no live process can have: the kernel's maximum is well below this,
    // so it can only be a leftover. Refusing to open a library because a
    // previous run was killed is worse than the failure this guards against.
    await writeFile(scratch(), "4294967290");
    expect((await acquireLockAt(scratch())).kind).toBe("acquired");
  });

  it("takes over a lock file full of nonsense rather than trusting it", async () => {
    await writeFile(scratch(), "not a pid at all");
    expect((await acquireLockAt(scratch())).kind).toBe("acquired");
  });

  it.runIf(onLinux)("reports a lock held by another live process as busy", async () => {
    // Process 1 exists on every Linux system and is not us. Windows has no
    // equivalent constant — pid 4 is `System`, which a normal process cannot
    // query — so the evidence is Linux's, not the behaviour.
    await writeFile(scratch(), "1");
    const outcome = await acquireLockAt(scratch());
    expect(outcome).toEqual({ kind: "busy", pid: 1 });
  });

  it("does not let a process lock itself out", async () => {
    // Regression from the Rust build: the desktop shell holds the lock for as
    // long as the library is open, so reopening the same library met a live pid
    // that was its own and refused itself forever.
    const first = await acquireLockAt(scratch());
    expect(first.kind).toBe("acquired");
    const second = await acquireLockAt(scratch());
    expect(second.kind).toBe("acquired");
  });

  it.runIf(onLinux)("never puts the lock inside the library", async () => {
    // The binding layout has room for four entries and a lock is not one of
    // them.
    const path = await lockPathFor(dir);
    expect(path.startsWith(dir)).toBe(false);
    expect(path.endsWith(".pid")).toBe(true);
  });

  it.runIf(onLinux)("gives two routes to one library the same lock", async () => {
    // `roost rebuild .` and `roost rebuild /abs/path` must agree, or the guard
    // is no guard at all.
    const nested = join(dir, "sub");
    await rm(nested, { recursive: true, force: true });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(nested);
    expect(await lockPathFor(join(nested, ".."))).toBe(await lockPathFor(dir));
  });

  it.runIf(onLinux)("derives the same lock name the Rust implementation does", async () => {
    // Three lock files `roost-old` actually left behind on this machine, with
    // the libraries that produced them. This is what makes the two builds lock
    // each other out of a library rather than both believing they are alone —
    // and it is the whole reason the derivation is BLAKE3 over the canonical
    // path and not something more convenient.
    const observed: [string, string][] = [
      [
        "/home/orion/.distrobox-homes/fedora44/RoostTest",
        "3c9cd2fe1cb076040cda09c127bd55771484e46f48c2ff102d94decac53e6eef.pid",
      ],
      [
        "/home/orion/.distrobox-homes/fedora44/RoostBench",
        "61dcdb52ce5b51f6be7ba2e5146491d84d872b3e60a57e461a84a7fae6c2c8d2.pid",
      ],
      [
        "/home/orion/.distrobox-homes/fedora44/Projects/testing-data-roost",
        "d4911fc4b40f6574797b178561f27c50867058a3d2225dc9001552b4871afc8b.pid",
      ],
    ];

    for (const [library, expected] of observed) {
      // Skip a path this machine no longer has: the derivation needs a real
      // directory to canonicalise, and the fixture is a record of one machine.
      const exists = await readFile(join(library, "library.json"), "utf8").catch(() => undefined);
      if (exists === undefined) continue;
      expect(basename(await lockPathFor(library))).toBe(expected);
    }
  });
});

describe("probing for reflink support", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-caps-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("leaves nothing behind", async () => {
    await reflinkSupported(dir);
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(dir)).toEqual([]);
  });

  it("answers unknown, not no, for a directory it cannot write to", async () => {
    // "No" would be a lie: an unwritable directory says nothing about whether
    // the filesystem supports cloning, and a caller must not turn it into
    // "importing here will copy bytes".
    expect(await reflinkSupported(join(dir, "does-not-exist"))).toBe("unknown");
  });

  it.runIf(onLinux)("says no on tmpfs, which has no copy-on-write", async () => {
    // `COPYFILE_FICLONE_FORCE` refuses rather than falling back, which is the
    // whole basis of ADR-0012. The plain hint would report success here.
    //
    // Not `os.tmpdir()`: that follows `$TMPDIR`, and pointing it at the Btrfs
    // this repository sits on is an ordinary thing for a developer to do —
    // which turns this check red for a reason that has nothing to do with the
    // code. The mount table is what actually knows.
    const onTmpfs = await tmpfsDir("roost-caps-");
    try {
      expect(await reflinkSupported(onTmpfs)).toBe("no");
    } finally {
      await rm(onTmpfs, { recursive: true, force: true });
    }
  });

  it.runIf(onLinux)("says yes on the Btrfs this repository sits on", async () => {
    // Inside `.tmp-test/`, which is gitignored, so a crashed run leaves
    // nothing for `git status` to report.
    const { mkdir, mkdtemp: make } = await import("node:fs/promises");
    const root = join(process.cwd(), ".tmp-test");
    await mkdir(root, { recursive: true });
    const onRepo = await make(join(root, "caps-"));
    try {
      expect(await reflinkSupported(onRepo)).toBe("yes");
    } finally {
      await rm(onRepo, { recursive: true, force: true });
    }
  });
});
