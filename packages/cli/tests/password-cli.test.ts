import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, type PasswordRole, run, setPasswordSource } from "@roost/cli";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * A library's password on the command line (ADR-0071 §3.4).
 *
 * The source is replaced, as the terminal cannot be typed into from a test:
 * what it answers for each role stands in for the person, or for the
 * environment variables a script would set.
 */

function capture() {
  const out: string[] = [];
  const warn: string[] = [];
  return {
    streams: {
      out: (line: string) => out.push(line),
      warn: (line: string) => warn.push(line),
      progress: () => {},
    },
    out,
    warn,
  };
}

let dir: string;
let root: string;
let answers: Partial<Record<PasswordRole, string>>;
let asked: PasswordRole[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "roost-cli-password-"));
  root = join(dir, "private.roost");
  answers = {};
  asked = [];
  setPasswordSource(async (role) => {
    asked.push(role);
    return answers[role];
  });
  expect(await run(["init", root], capture().streams)).toBe(EXIT.ok);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const manifest = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(root, "library.json"), "utf8")) as Record<string, unknown>;

describe("roost password", () => {
  it("sets one, typed twice, and the library is version 3", async () => {
    answers = { new: "secret", again: "secret" };
    const run1 = capture();
    expect(await run(["password", "set", "-L", root], run1.streams)).toBe(EXIT.ok);
    expect(run1.out.join("\n")).toContain("encrypts nothing");
    expect(asked).toEqual(["new", "again"]);
    expect((await manifest())["roost_library_version"]).toBe(3);
  });

  it("changes nothing when the two do not match", async () => {
    answers = { new: "secret", again: "secrex" };
    const run1 = capture();
    expect(await run(["password", "set", "-L", root], run1.streams)).toBe(EXIT.failed);
    expect(run1.warn).toContain("The two do not match. Nothing was changed.");
    expect((await manifest())["roost_library_version"]).toBe(2);
  });

  it("asks every command for it, and refuses one that has none to give", async () => {
    answers = { new: "secret", again: "secret" };
    await run(["password", "set", "-L", root], capture().streams);

    answers = {};
    const refused = capture();
    expect(await run(["stats", "-L", root], refused.streams)).toBe(EXIT.failed);
    expect(refused.warn[0]).toMatch(/^error \[password_required\]/);
    expect(refused.warn.join("\n")).toContain("ROOST_PASSWORD");

    answers = { library: "guess" };
    const wrong = capture();
    expect(await run(["stats", "-L", root], wrong.streams)).toBe(EXIT.failed);
    expect(wrong.warn[0]).toMatch(/^error \[password_wrong\]/);

    answers = { library: "secret" };
    const right = capture();
    expect(await run(["stats", "-L", root], right.streams)).toBe(EXIT.ok);
  });

  it("removes it with the current one, and asks a library without one for nothing", async () => {
    answers = { new: "secret", again: "secret" };
    await run(["password", "set", "-L", root], capture().streams);

    answers = { library: "secret" };
    expect(await run(["password", "remove", "-L", root], capture().streams)).toBe(EXIT.ok);
    const plain = await manifest();
    expect(plain["roost_library_version"]).toBe(2);
    expect("password" in plain).toBe(false);

    asked = [];
    expect(await run(["stats", "-L", root], capture().streams)).toBe(EXIT.ok);
    expect(asked).toEqual([]);
  });

  it("says which of set and change is meant", async () => {
    const none = capture();
    expect(await run(["password", "change", "-L", root], none.streams)).toBe(EXIT.failed);
    expect(none.warn).toContain("This library has no password.");

    expect(await run(["password", "-L", root], capture().streams)).toBe(EXIT.usage);
    expect(await run(["password", "unlock", "-L", root], capture().streams)).toBe(EXIT.usage);
  });

  it("asks for the target's password before a copy starts", async () => {
    const target = join(dir, "target.roost");
    expect(await run(["init", target], capture().streams)).toBe(EXIT.ok);
    answers = { new: "secret", again: "secret" };
    await run(["password", "set", "-L", target], capture().streams);

    answers = {};
    asked = [];
    const refused = capture();
    expect(await run(["copy", "--to", target, "ABCDEFGHJKMN", "-L", root], refused.streams)).toBe(
      EXIT.failed,
    );
    expect(refused.warn[0]).toMatch(/^error \[password_required\]/);
    expect(asked).toEqual(["target"]);
  });
});
