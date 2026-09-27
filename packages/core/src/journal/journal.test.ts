import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidTimestampError, parseAssetId } from "../model/index.js";
import { type JournalRecord, MalformedRecordError, OP_NAMES, toLine, toRecord } from "./op.js";
import { CollectingSink, isClean, replay } from "./replay.js";
import { Journal, monthKey, monthsIn } from "./writer.js";

const ASSET = parseAssetId("K7QM4X2AJH9F");
/** The journal of the conformance library at the repository root (RL-52). */
const FIXTURE_DIR = fileURLToPath(
  new URL("../../../../conformance/library.roost/journal", import.meta.url),
);
const FIXTURE = join(FIXTURE_DIR, "2026-01.jsonl");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "roost-journal-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("against the journal the suite publishes", () => {
  const lines = async () =>
    (await readFile(FIXTURE, "utf8")).split("\n").filter((line) => line !== "");

  it("reads it the way `expected.json` says a correct implementation does", async () => {
    const sink = new CollectingSink();
    const report = await replay(FIXTURE_DIR, sink);

    // The numbers are the suite's, not ours: three operations from builds
    // this one is not (RL-37), one line a crash cut short (RL-39), and one
    // record naming a folder nobody created (RL-38).
    expect([...report.unknownOps.keys()].sort()).toEqual([
      "lightbox_create",
      "mac.quicklook_tag",
      "win.shell_pin",
    ]);
    expect(report.tornTrailing).toHaveLength(1);
    // Nothing is *malformed*: a line a crash cut short is not corruption, and
    // an operation from another build is not damage either — skipping is safe
    // because the journal is append-only, and the record is still there when
    // the library opens in the build that wrote it.
    expect(report.malformed).toEqual([]);
    // The torn line is what makes this library unclean, and the three skipped
    // operations are not. A build that reported itself unclean every time it
    // had been opened in two builds would train everybody to ignore the word.
    expect(isClean(report)).toBe(false);
  });

  it("re-serialises every record it recognises, byte for byte", async () => {
    // The strongest form of the format promise: this implementation reads what
    // the suite publishes *and* writes what the suite would read — field
    // order and omitted optionals included. A stray `"created":null` or a
    // reordered key would fail here and nowhere else.
    //
    // A record carrying a field this build does not know is excluded rather
    // than asserted: RL-44 says it must be ignored and never rewritten away,
    // and `toLine` writes what `toRecord` kept.
    for (const line of await lines()) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // The torn final line, which is RL-39's case and not this test's.
        continue;
      }
      if (!OP_NAMES.includes(parsed["op"] as never)) continue;
      if ("spotlight_id" in parsed) continue;
      expect(toLine(toRecord(parsed))).toBe(`${line}\n`);
    }
  });

  it("covers most of the vocabulary, and names what it does not", async () => {
    const sink = new CollectingSink();
    await replay(FIXTURE_DIR, sink);

    // What the fixture does not exercise, subtracted by name rather than by
    // loosening the comparison: the point of this test is that the vocabulary
    // cannot shrink unnoticed.
    const absent = new Set(seen(sink));
    expect(OP_NAMES.filter((name) => !absent.has(name)).length).toBeLessThan(OP_NAMES.length);
    expect(absent.size).toBeGreaterThan(20);
  });
});

/** Every operation a replay applied, once each. */
function seen(sink: CollectingSink): string[] {
  return [...new Set(sink.records.map((record) => record.op))].sort();
}

describe("monthKey", () => {
  it("is UTC, so a library keeps its records where replay looks for them", () => {
    expect(monthKey(1787580324)).toBe("2026-08");
    expect(monthKey(0)).toBe("1970-01");
  });

  it("follows the record's own timestamp across a month boundary", () => {
    // 2025-12-31T23:59:59Z and one second later.
    expect(monthKey(1767225599)).toBe("2025-12");
    expect(monthKey(1767225600)).toBe("2026-01");
  });

  it("refuses a timestamp that is not a point in time", () => {
    expect(() => monthKey(Number.NaN)).toThrow(InvalidTimestampError);
    expect(() => monthKey(1e20)).toThrow(InvalidTimestampError);
  });
});

describe("Journal", () => {
  const add = (ts: number): JournalRecord => ({
    ts,
    op: "add",
    id: ASSET,
    ext: "png",
    name: "alpha",
  });

  it("files a record by its own timestamp, not by the wall clock", async () => {
    const journal = await Journal.open(dir);
    await journal.appendAll([add(1767225599), add(1767225600)]);
    await journal.close();

    expect(await monthsIn(journal.dir)).toEqual(["2025-12", "2026-01"]);
  });

  it("appends rather than rewriting, across separate opens", async () => {
    for (const ts of [1787580324, 1787580325]) {
      const journal = await Journal.open(dir);
      await journal.appendAll([add(ts)]);
      await journal.close();
    }

    const written = await readFile(join(dir, "journal/2026-08.jsonl"), "utf8");
    expect(written.trimEnd().split("\n")).toHaveLength(2);
  });

  it("loses nothing that was only buffered, once closed", async () => {
    const journal = await Journal.open(dir);
    // `append` alone is buffered. Rust flushes on Drop; JavaScript has no
    // equivalent, which is why `close` is part of the contract.
    for (let i = 0; i < 500; i++) await journal.append(add(1787580324 + i));
    await journal.close();

    const written = await readFile(join(dir, "journal/2026-08.jsonl"), "utf8");
    expect(written.trimEnd().split("\n")).toHaveLength(500);
  });

  it("reports no months for a library where nothing has happened", async () => {
    const journal = await Journal.open(dir);
    expect(await journal.months()).toEqual([]);
    await journal.close();
  });

  it("ignores files in the journal directory that are not month files", async () => {
    const journal = await Journal.open(dir);
    await writeFile(join(journal.dir, "notes.txt"), "stray");
    await writeFile(join(journal.dir, "2026-13-backup.jsonl"), "");
    expect(await journal.months()).toEqual([]);
    await journal.close();
  });
});

describe("replay, on a damaged journal", () => {
  const write = async (contents: string) => {
    const journalDir = join(dir, "journal");
    await (await Journal.open(dir)).close();
    await writeFile(join(journalDir, "2026-08.jsonl"), contents);
    return journalDir;
  };

  const good = `{"ts":1787580324,"op":"remove","asset":"${ASSET}"}`;

  it("skips an operation from a newer build, and counts it", async () => {
    const journalDir = await write(`${good}\n{"ts":1787580325,"op":"stack_create","id":1}\n`);
    const sink = new CollectingSink();
    const report = await replay(journalDir, sink);

    // This is what lets a library written by a newer Roost still open in an
    // older one (RL-26). It is expected, not a fault.
    expect(report.applied).toBe(1);
    expect(report.unknownOps.get("stack_create")).toBe(1);
    expect(isClean(report)).toBe(true);
  });

  it("treats an unterminated final line as a torn write, not corruption", async () => {
    const journalDir = await write(`${good}\n{"ts":1787580325,"op":"rem`);
    const report = await replay(journalDir, new CollectingSink());

    expect(report.applied).toBe(1);
    expect(report.tornTrailing).toHaveLength(1);
    expect(report.tornTrailing[0]?.reason).toBe("truncated write");
    expect(report.malformed).toEqual([]);
  });

  it("treats the same damage mid-file as corruption, because it is", async () => {
    const journalDir = await write(`{"ts":1787580325,"op":"rem\n${good}\n`);
    const report = await replay(journalDir, new CollectingSink());

    expect(report.applied).toBe(1);
    expect(report.malformed).toHaveLength(1);
    expect(report.tornTrailing).toEqual([]);
  });

  it("recovers everything around a bad line rather than aborting", async () => {
    const journalDir = await write(`${good}\nnot json at all\n${good}\n`);
    const report = await replay(journalDir, new CollectingSink());

    // The failure mode of a strict parser here is losing a library to one bad
    // line, so a bad line must cost exactly one line.
    expect(report.applied).toBe(2);
    expect(report.malformed).toHaveLength(1);
    expect(report.malformed[0]?.line).toBe(2);
  });

  it("counts a known op with unusable fields as corruption, not a version gap", async () => {
    // This build defines these fields, so a bad one is damage rather than
    // something written by a newer Roost.
    const journalDir = await write(`{"ts":1787580324,"op":"remove","asset":"nope"}\n`);
    const report = await replay(journalDir, new CollectingSink());

    expect(report.applied).toBe(0);
    expect(report.malformed).toHaveLength(1);
    expect(report.unknownOps.size).toBe(0);
  });

  it("ignores blank lines without counting them against the file", async () => {
    const journalDir = await write(`${good}\n\n   \n${good}\n`);
    const report = await replay(journalDir, new CollectingSink());

    expect(report.applied).toBe(2);
    expect(isClean(report)).toBe(true);
  });

  it("replays months oldest first, whatever order the directory lists them", async () => {
    const journal = await Journal.open(dir);
    await journal.appendAll([
      { ts: 1767225600, op: "folder_delete", id: 2 },
      { ts: 1764547200, op: "folder_delete", id: 1 },
    ]);
    await journal.close();

    const sink = new CollectingSink();
    await replay(journal.dir, sink);
    expect(sink.records.map((r) => r.ts)).toEqual([1764547200, 1767225600]);
  });
});

describe("toRecord, on the fields that carry meaning in a null", () => {
  const base = { ts: 1787580324, asset: ASSET };

  it("keeps a cleared rating distinct from one star", () => {
    // `rating: null` clears; a missing field is a malformed record. The two
    // must not collapse, or "unrated" and "one star" become the same thing.
    expect(toRecord({ ...base, op: "rate", rating: null })).toMatchObject({ rating: null });
    expect(() => toRecord({ ...base, op: "rate" })).toThrow(MalformedRecordError);
  });

  it("writes the null back out rather than omitting it", () => {
    const line = toLine(toRecord({ ...base, op: "rate", rating: null }));
    expect(line).toContain('"rating":null');
  });

  it("keeps a top-level folder's null parent", () => {
    const line = toLine(toRecord({ ts: 1, op: "folder_create", id: 7, parent: null, name: "M" }));
    expect(line).toContain('"parent":null');
  });

  it("omits an absent optional instead of writing it as null", () => {
    // The reverse case: `created` is absent when the source file's date could
    // not be read, and writing `"created":null` would be a different line for
    // the same fact.
    const line = toLine(toRecord({ ts: 1, op: "add", id: ASSET, ext: "jpg", name: "d" }));
    expect(line).not.toContain("created");
    expect(line).toBe(`{"ts":1,"op":"add","id":"${ASSET}","ext":"jpg","name":"d"}\n`);
  });

  it("keeps an empty extension, because a file with none is a fact (RL-9a)", () => {
    // Not the same as a missing field: `""` says the file has no extension and
    // is stored under a bare id with **no trailing dot**, which is the rule a
    // Windows implementation breaks without noticing.
    const line = toLine(toRecord({ ts: 1, op: "add", id: ASSET, ext: "", name: "LICENSE" }));
    expect(line).toContain('"ext":""');
    expect(() => toRecord({ ts: 1, op: "add", id: ASSET, name: "LICENSE" })).toThrow(
      MalformedRecordError,
    );
  });

  it("refuses a name that is not an id, rather than storing it", () => {
    // A sixty-four-character hash where a twelve-character id belongs is a
    // record this build must not half-read (RL-14).
    expect(() => toRecord({ ts: 1, op: "add", id: "a".repeat(64), ext: "jpg", name: "d" })).toThrow(
      MalformedRecordError,
    );
  });

  it("rejects an integer too large to round-trip through JSON", () => {
    expect(() => toRecord({ ts: 1, op: "folder_delete", id: 2 ** 53 })).toThrow(
      MalformedRecordError,
    );
  });
});
