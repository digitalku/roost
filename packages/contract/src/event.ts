import { bad, type Checked, isRecord, ok, within } from "./checked.js";

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
  { readonly type: "library:changed" };

export type EventType = Event["type"];
export type EventOf<T extends EventType> = Extract<Event, { type: T }>;

export const EVENT_VALIDATORS: {
  readonly [T in EventType]: (source: Record<string, unknown>) => Checked<EventOf<T>>;
} = {
  "library:changed": () => ok({ type: "library:changed" }),
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
