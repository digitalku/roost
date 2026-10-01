import {
  bad,
  type Checked,
  isRecord,
  ok,
  readBoolean,
  readInteger,
  readNonEmpty,
  readNullable,
  readOneOf,
  readString,
  within,
} from "./checked.js";
import type {
  DeriveProgress,
  ImportProgress,
  InstallableBackend,
  WireRedrawn,
  WireTransferProgress,
} from "./dto.js";
import { INSTALLABLE_BACKENDS } from "./dto.js";

/**
 * What the engine says without being asked.
 *
 * Events travel the same port as replies and are re-emitted by main to the
 * window. Like requests, each arrives with the feature that emits it: an event
 * nothing sends is an event nothing handles.
 */
export type Event =
  /**
   * Something changed that a listing cannot detect on its own.
   *
   * Deliberately carries no payload. A renderer told *what* changed would still
   * have to decide whether its current query still matches, so it re-reads
   * either way — and an event with a payload nobody uses is a shape that drifts.
   */
  | { readonly type: "library:changed" }
  /**
   * How far opening a library has got, while it folds the journal.
   *
   * Only an open that finds the index behind the journal sends it — a library
   * another implementation wrote, or one whose index was deleted — because
   * that open replays the whole journal before it answers, which is seconds at
   * a hundred thousand assets. Bytes, because the total is the size of the
   * files and is known before the first line is read; the window draws a
   * fraction and never the numbers themselves.
   */
  | { readonly type: "library:folding"; readonly done: number; readonly total: number }
  /**
   * The open library was renamed from a window (ADR-0056 §3.2).
   *
   * Every window hears it, because two can hold one library (ADR-0020) and the
   * one that did not ask still draws the old name in its head. The root and
   * the name are all that changed; the rest of the summary is the same.
   */
  | { readonly type: "library:renamed"; readonly root: string; readonly name: string }
  /**
   * The open library's folder left its path while it was open: renamed or
   * moved from outside, or its drive taken away (ADR-0056 §3.4).
   *
   * The engine has already closed it. `movedTo` is the folder found beside the
   * old one, with its name, or both `null` when it was not there to find.
   */
  | {
      readonly type: "library:lost";
      readonly root: string;
      readonly name: string;
      readonly movedTo: string | null;
      readonly movedName: string | null;
    }
  /**
   * How far an import has got.
   *
   * The one event that carries a payload, because there is nothing to re-read:
   * the numbers exist only while the run is happening. Counts and no path —
   * see {@link ImportProgress}.
   */
  | ({ readonly type: "import:progress" } & ImportProgress)
  /**
   * How far the derive queue has got.
   *
   * Separate from `import:progress` because the two overlap: an import can
   * finish while its thumbnails are still being made, and the window says so.
   */
  | ({ readonly type: "job:progress" } & DeriveProgress)
  /**
   * How far a move or copy into another library has got (ADR-0054 §3.9).
   *
   * Numbers, like `import:progress`, because they exist only while the run is
   * happening. Bytes as well as assets: one video of several gigabytes onto a
   * hard disk is minutes of "0 of 1".
   */
  | ({ readonly type: "transfer:progress" } & WireTransferProgress)
  /**
   * Assets whose derived data was just replaced, and when.
   *
   * The second event that carries a payload, and for the opposite reason to
   * `import:progress`: here there **is** something to re-read and re-reading it
   * is what must be avoided. A grid showing ten thousand cells cannot fetch
   * every page again because one file changed, and the change is not visible
   * without doing something — `roost://thumb/<id>@256` is served `immutable`
   * for a year, so an `<img>` whose `src` did not change is one Chromium never
   * asks about again.
   *
   * So the ids arrive and the window patches the cards it is already holding,
   * the way it does for a pinned poster and a rename. `derivedAt` is the new
   * cache key rather than something a cell draws (ADR-0047), and `undrawn` is
   * why a cell still has no picture, which it does draw (`UI_SPEC.md` §6.1).
   */
  | { readonly type: "assets:derived"; readonly assets: readonly WireRedrawn[] }
  /**
   * What the package manager is saying, while it says it (ADR-0042 §9).
   *
   * An install is the one thing Roost starts that takes minutes and reports
   * nothing until it ends: `winget` fetches its sources, then a hundred and
   * fifty megabytes, and a button reading *Installing…* for all of it is
   * indistinguishable from a button that has hung. So the tool's own output is
   * carried a line at a time, and the window draws the latest one.
   *
   * **A line, not a percentage.** Parsing a package manager's progress would be
   * a guess about a format nobody promised, and it would be wrong quietly. The
   * line is passed through as it was written.
   */
  | {
      readonly type: "install:progress";
      readonly backend: InstallableBackend;
      readonly line: string;
    };

export type EventType = Event["type"];
export type EventOf<T extends EventType> = Extract<Event, { type: T }>;

export const EVENT_VALIDATORS: {
  readonly [T in EventType]: (source: Record<string, unknown>) => Checked<EventOf<T>>;
} = {
  "library:changed": () => ok({ type: "library:changed" }),

  "library:folding": (source) => {
    const done = readInteger(source, "done");
    if (!done.ok) return done;
    const total = readInteger(source, "total");
    if (!total.ok) return total;
    return ok({ type: "library:folding", done: done.value, total: total.value });
  },

  "library:renamed": (source) => {
    const root = readNonEmpty(source, "root");
    if (!root.ok) return root;
    const name = readNonEmpty(source, "name");
    if (!name.ok) return name;
    return ok({ type: "library:renamed", root: root.value, name: name.value });
  },

  "library:lost": (source) => {
    const root = readNonEmpty(source, "root");
    if (!root.ok) return root;
    const name = readNonEmpty(source, "name");
    if (!name.ok) return name;
    const movedTo = readNullable(source, "movedTo", readNonEmpty);
    if (!movedTo.ok) return movedTo;
    const movedName = readNullable(source, "movedName", readNonEmpty);
    if (!movedName.ok) return movedName;
    if ((movedTo.value === null) !== (movedName.value === null)) {
      return bad("movedTo and movedName: both or neither");
    }
    return ok({
      type: "library:lost",
      root: root.value,
      name: name.value,
      movedTo: movedTo.value,
      movedName: movedName.value,
    });
  },

  "import:progress": (source) => {
    const counts: Record<string, number> = {};
    for (const field of [
      "scanned",
      "imported",
      "duplicates",
      "failed",
      "thumbnails",
      "total",
      "bytesDone",
      "bytesTotal",
    ] as const) {
      const value = readInteger(source, field);
      if (!value.ok) return value;
      counts[field] = value.value;
    }
    const counting = readBoolean(source, "counting");
    if (!counting.ok) return counting;

    return ok({
      type: "import:progress",
      scanned: counts["scanned"] ?? 0,
      imported: counts["imported"] ?? 0,
      duplicates: counts["duplicates"] ?? 0,
      failed: counts["failed"] ?? 0,
      thumbnails: counts["thumbnails"] ?? 0,
      total: counts["total"] ?? 0,
      counting: counting.value,
      bytesDone: counts["bytesDone"] ?? 0,
      bytesTotal: counts["bytesTotal"] ?? 0,
    });
  },

  "job:progress": (source) => {
    const counts: Record<string, number> = {};
    for (const field of ["derived", "remaining", "blocked", "failed"] as const) {
      const value = readInteger(source, field);
      if (!value.ok) return value;
      counts[field] = value.value;
    }
    return ok({
      type: "job:progress",
      derived: counts["derived"] ?? 0,
      remaining: counts["remaining"] ?? 0,
      blocked: counts["blocked"] ?? 0,
      failed: counts["failed"] ?? 0,
    });
  },

  "transfer:progress": (source) => {
    const counts: Record<string, number> = {};
    for (const field of ["done", "total", "bytesDone", "bytesTotal"] as const) {
      const value = readInteger(source, field);
      if (!value.ok) return value;
      counts[field] = value.value;
    }
    return ok({
      type: "transfer:progress",
      done: counts["done"] ?? 0,
      total: counts["total"] ?? 0,
      bytesDone: counts["bytesDone"] ?? 0,
      bytesTotal: counts["bytesTotal"] ?? 0,
    });
  },

  "assets:derived": (source) => {
    const assets = source["assets"];
    if (!Array.isArray(assets)) return bad("assets: expected an array");
    const redrawn: WireRedrawn[] = [];
    for (const entry of assets) {
      if (!isRecord(entry)) return bad("assets: expected objects");
      const id = readNonEmpty(entry, "id");
      if (!id.ok) return id;
      const derivedAt = readNullable(entry, "derivedAt", readInteger);
      if (!derivedAt.ok) return derivedAt;
      const undrawn = readNullable(entry, "undrawn", readString);
      if (!undrawn.ok) return undrawn;
      redrawn.push({ id: id.value, derivedAt: derivedAt.value, undrawn: undrawn.value });
    }
    return ok({ type: "assets:derived", assets: redrawn });
  },

  "install:progress": (source) => {
    const backend = readOneOf(source, "backend", INSTALLABLE_BACKENDS);
    if (!backend.ok) return backend;
    // Non-empty: a blank line is the package manager drawing, not saying.
    const line = readNonEmpty(source, "line");
    if (!line.ok) return line;
    return ok({ type: "install:progress", backend: backend.value, line: line.value });
  },
};

export const EVENT_TYPES = Object.keys(EVENT_VALIDATORS) as EventType[];

export function isEventType(value: string): value is EventType {
  return Object.hasOwn(EVENT_VALIDATORS, value);
}

export function checkEvent(value: unknown): Checked<Event> {
  if (!isRecord(value)) return bad("expected an object");
  const type = value["type"];
  if (typeof type !== "string") return bad("type: expected a string");
  if (!isEventType(type)) return bad(`type: unknown event "${type}"`);
  return within(type, EVENT_VALIDATORS[type](value) as Checked<Event>);
}
