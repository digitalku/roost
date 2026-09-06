import { bad, type Checked, isRecord, ok, readInteger, readNullable, within } from "./checked.js";
import type { DeriveProgress, ImportProgress } from "./dto.js";

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
  | ({ readonly type: "job:progress" } & DeriveProgress);

export type EventType = Event["type"];
export type EventOf<T extends EventType> = Extract<Event, { type: T }>;

export const EVENT_VALIDATORS: {
  readonly [T in EventType]: (source: Record<string, unknown>) => Checked<EventOf<T>>;
} = {
  "library:changed": () => ok({ type: "library:changed" }),

  "import:progress": (source) => {
    const counts: Record<string, number> = {};
    for (const field of ["scanned", "imported", "duplicates", "failed", "thumbnails"] as const) {
      const value = readInteger(source, field);
      if (!value.ok) return value;
      counts[field] = value.value;
    }
    // Nullable rather than one more of the five: an unknown total and a total
    // of zero are different things, and only one of them is a number.
    const total = readNullable(source, "total", readInteger);
    if (!total.ok) return total;

    return ok({
      type: "import:progress",
      scanned: counts["scanned"] ?? 0,
      imported: counts["imported"] ?? 0,
      duplicates: counts["duplicates"] ?? 0,
      failed: counts["failed"] ?? 0,
      thumbnails: counts["thumbnails"] ?? 0,
      total: total.value,
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
