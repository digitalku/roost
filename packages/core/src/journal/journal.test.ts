import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidTimestampError, parseContentHash } from "../model/index.js";
import { type JournalRecord, MalformedRecordError, OP_NAMES, toLine, toRecord } from "./op.js";
import { CollectingSink, isClean, replay } from "./replay.js";
import { Journal, monthKey, monthsIn } from "./writer.js";

const HASH = parseContentHash("e683cfdda42a354a1148b1d436f66d20074afbc207ff70efa7971d31e557bcc5");
const FIXTURE_DIR = join(import.meta.dirname, "__fixtures__/rust-written-journal");
const FIXTURE = join(FIXTURE_DIR, "2026-08.jsonl");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "roost-journal-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("against a journal written by the Rust implementation", () => {
  const lines = async () =>
    (await readFile(FIXTURE, "utf8")).split("\n").filter((line) => line !== "");

  it("applies every line, with nothing malformed and nothing unknown", async () => {
    const sink = new CollectingSink();
    const report = await replay(FIXTURE_DIR, sink);

    expect(report.applied).toBe((await lines()).length);
    expect(report.malformed).toEqual([]);
    expect(report.tornTrailing).toEqual([]);
    // An unrecognised op here would mean the two implementations have stopped
    // agreeing on the vocabulary, which is exactly what this fixture watches.
    expect([...report.unknownOps.keys()]).toEqual([]);
    expect(isClean(report)).toBe(true);
  });

  it("covers every operation the two implementations share", async () => {
    const sink = new CollectingSink();
    await replay(FIXTURE_DIR, sink);

    // The fixture holds the 22 operations that existed when both builds were
    // writing journals. The rest are this repository's own — `trash` and
    // `restore` from ADR-0022, the three comment ops from ADR-0023 — and the
    // Rust build cannot write them, so they are subtracted by name rather than
    // by loosening the comparison: the point of this test is that the *shared*
    // vocabulary cannot shrink unnoticed.
    const ours = new Set(["trash", "restore", "comment_add", "comment_set", "comment_remove"]);
    expect([...new Set(sink.records.map((r) => r.op))].sort()).toEqual(
      OP_NAMES.filter((name) => !ours.has(name)),
    );
  });

  it("re-serialises every record byte for byte", async () => {
    // The strongest form of the format promise: this implementation reads what
    // the other one writes *and* writes what the other one reads — field order
    // and omitted optionals included. A stray `"link":null` or a reordered key
    // would fail here and nowhere else.
    for (const line of await lines()) {
      const record = toRecord(JSON.parse(line));
      expect(toLine(record)).toBe(`${line}\n`);
    }
  });
});

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
    hash: HASH,
    ext: "png",
    size: 13,
    name: "alpha.png",
    mode: "managed",
    link: "hardlink",
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

  const good = `{"ts":1787580324,"op":"remove","hash":"${HASH}"}`;

  it("skips an operation from a newer build, and counts it", async () => {
    const journalDir = await write(`${good}\n{"ts":1787580325,"op":"stack_create","id":1}\n`);
    const sink = new CollectingSink();
    const report = await replay(journalDir, sink);

    // This is what lets a library written by a newer Roost still open in an
    // older one (`STORAGE_SPEC.md` §Journal Format). It is expected, not a fault.
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
    const journalDir = await write(`{"ts":1787580324,"op":"remove","hash":"nope"}\n`);
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
  const base = { ts: 1787580324, hash: HASH };

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
    // The reverse case: `link` is absent in referenced mode, and writing
    // `"link":null` would be a different line for the same fact.
    const line = toLine(
      toRecord({
        ts: 1,
        op: "add",
        hash: HASH,
        ext: "jpg",
        size: 3,
        name: "d.jpg",
        mode: "referenced",
        ref: "/home/u/d.jpg",
      }),
    );
    expect(line).not.toContain("link");
    expect(line).toContain('"ref":"/home/u/d.jpg"');
  });

  it("treats partial:false as absent, since that is how it is written", () => {
    const line = toLine(
      toRecord({
        ts: 1,
        op: "add",
        hash: HASH,
        ext: "mp4",
        size: 3,
        name: "v.mp4",
        mode: "managed",
        partial: false,
      }),
    );
    expect(line).not.toContain("partial");
  });

  it("rejects an integer too large to round-trip through JSON", () => {
    expect(() => toRecord({ ts: 1, op: "folder_delete", id: 2 ** 53 })).toThrow(
      MalformedRecordError,
    );
  });
});
