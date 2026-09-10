import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, run } from "@roost/cli";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** Collects what a command would have printed, so no subprocess is needed. */
function capture(): {
  streams: Parameters<typeof run>[1];
  out: string[];
  warn: string[];
} {
  const out: string[] = [];
  const warn: string[] = [];
  return {
    streams: { out: (l) => out.push(l), warn: (l) => warn.push(l), progress: () => {} },
    out,
    warn,
  };
}

describe("the command line", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roost-cli-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("prints help to stdout on request, and to stderr when nothing was asked", async () => {
    // `roost --help` is a request and its answer is output; bare `roost` is a
    // mistake, and its answer is a diagnostic. Piping the first must work.
    const asked = capture();
    expect(await run(["--help"], asked.streams)).toBe(EXIT.ok);
    expect(asked.out.join("\n")).toContain("Usage: roost <COMMAND>");
    expect(asked.warn).toEqual([]);

    const bare = capture();
    expect(await run([], bare.streams)).toBe(EXIT.usage);
    expect(bare.out).toEqual([]);
    expect(bare.warn.join("\n")).toContain("Usage: roost <COMMAND>");
  });

  it("answers a command's own --help without touching a library", async () => {
    const { streams, out } = capture();
    expect(await run(["import", "--help"], streams)).toBe(EXIT.ok);
    expect(out.join("\n")).toContain("Usage: roost import");
    expect(out.join("\n")).toContain("--mode <MODE>");
  });

  it("separates a wrong command line from a failed command", async () => {
    // Exit 2 is "you typed something I cannot act on"; exit 1 is "I tried".
    // A script that retries on failure must be able to tell them apart.
    const unknown = capture();
    expect(await run(["frobnicate"], unknown.streams)).toBe(EXIT.usage);
    expect(unknown.warn.join("\n")).toContain('Unknown command "frobnicate"');

    const badMode = capture();
    expect(
      await run(["import", "--mode", "sideways", join(dir, "x"), "-L", dir], badMode.streams),
    ).toBe(EXIT.usage);
    expect(badMode.warn.join("\n")).toContain("managed or referenced");

    // A path that is not there and a directory that is there and holds no
    // library are different mistakes, and the message has to say which: the
    // first is usually a typo or an unmounted drive.
    const missing = capture();
    expect(await run(["stats", "-L", join(dir, "not-a-library")], missing.streams)).toBe(
      EXIT.failed,
    );
    expect(missing.warn.join("\n")).toContain("[library_not_found]");

    const plain = capture();
    expect(await run(["stats", "-L", dir], plain.streams)).toBe(EXIT.failed);
    expect(plain.warn.join("\n")).toContain("[not_a_library]");
  });

  it("carries a library through init, import, stats, thumb, and rebuild", async () => {
    // What is typed, and where it actually lands: a library is a folder ending
    // in .roost, and the CLI adds the suffix so that it and the window agree
    // about where one library is (ADR-0014).
    const asked = join(dir, "library");
    const root = `${asked}.roost`;
    const corpus = join(dir, "corpus");

    const fixture = capture();
    expect(
      await run(
        ["fixture", corpus, "--count", "12", "--seed", "5", "--real-images"],
        fixture.streams,
      ),
    ).toBe(EXIT.ok);
    expect(fixture.out.join("\n")).toContain("Generated 12 files");

    const init = capture();
    expect(await run(["init", asked, "--name", "Demo"], init.streams)).toBe(EXIT.ok);
    expect(init.out.join("\n")).toContain('Created library "Demo"');
    // The suffix is added, and the path actually used is printed — a command
    // that creates something other than what was typed has to say so (ADR-0014).
    expect(init.out.join("\n")).toContain(root);
    // The manifest is what makes a directory a library, and the format version
    // is part of it.
    const manifest: unknown = JSON.parse(await readFile(join(root, "library.json"), "utf8"));
    expect(manifest).toMatchObject({ roost_library_version: 1, name: "Demo" });

    const imported = capture();
    expect(await run(["import", corpus, "-L", root, "--tag", "demo"], imported.streams)).toBe(
      EXIT.ok,
    );
    expect(imported.out.join("\n")).toContain("of 12 files scanned");

    const stats = capture();
    expect(await run(["stats", "-L", root], stats.streams)).toBe(EXIT.ok);
    expect(stats.out.join("\n")).toContain("tags        1");
    // Sizes are MiB and say so, so that this build and the Rust one cannot look
    // like they disagree about how big a library is.
    expect(stats.out.join("\n")).toMatch(/total size {2}[\d.]+ (B|KiB|MiB)/);

    const thumbs = capture();
    expect(await run(["thumb", "-L", root, "--size", "256"], thumbs.streams)).toBe(EXIT.ok);
    expect(thumbs.out.join("\n")).toContain("thumbnail(s) at 256 px");

    const rebuilt = capture();
    expect(await run(["rebuild", "-L", root], rebuilt.streams)).toBe(EXIT.ok);
    expect(rebuilt.out.join("\n")).toContain("Replayed");
    // The one thing a rebuild is allowed to lose, said out loud rather than
    // discovered by a user wondering where the grid went.
    expect(rebuilt.out.join("\n")).toContain("roost thumb");
  });

  it("finds the library from inside it, the way git does", async () => {
    const root = join(dir, "library.roost");
    await run(["init", root], capture().streams);

    const previous = process.cwd();
    process.chdir(root);
    try {
      const { streams, out } = capture();
      expect(await run(["stats"], streams)).toBe(EXIT.ok);
      expect(out.join("\n")).toContain("assets      0");
    } finally {
      process.chdir(previous);
    }
  });

  it("refuses to lay a second library over an existing one", async () => {
    const root = join(dir, "library");
    expect(await run(["init", root], capture().streams)).toBe(EXIT.ok);

    const again = capture();
    expect(await run(["init", root], again.streams)).toBe(EXIT.failed);
    expect(again.warn.join("\n")).toContain("[already_a_library]");

    // Adding the suffix is idempotent, so the suffixed spelling of the same
    // intent has to collide with it rather than make a second library.
    const suffixed = capture();
    expect(await run(["init", `${root}.roost`], suffixed.streams)).toBe(EXIT.failed);
    expect(suffixed.warn.join("\n")).toContain("[already_a_library]");
  });
});
