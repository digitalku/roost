import { bad, type Checked, isRecord, ok, readInteger, within } from "./checked.js";
import type { WireProblem } from "./dto.js";
import { checkEvent, type Event } from "./event.js";
import { checkRequest, type Request } from "./request.js";

/**
 * What actually crosses the port.
 *
 * A request carries an id so its reply can be matched to it; ids are per
 * connection and monotonic, never reused. A reply is a success or a problem and
 * never both, so a caller cannot read a value out of a failure by forgetting to
 * check.
 */

export interface RequestEnvelope {
  readonly id: number;
  readonly request: Request;
}

export type ReplyEnvelope =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly problem: WireProblem };

export interface EventEnvelope {
  readonly event: Event;
}

/** Either an envelope the engine should act on, or an event it emitted. */
export type Message = RequestEnvelope | ReplyEnvelope | EventEnvelope;

export function checkRequestEnvelope(value: unknown): Checked<RequestEnvelope> {
  if (!isRecord(value)) return bad("expected an object");
  const id = readInteger(value, "id");
  if (!id.ok) return id;
  const request = within("request", checkRequest(value["request"]));
  if (!request.ok) return request;
  return ok({ id: id.value, request: request.value });
}

export function checkEventEnvelope(value: unknown): Checked<EventEnvelope> {
  if (!isRecord(value)) return bad("expected an object");
  const event = within("event", checkEvent(value["event"]));
  if (!event.ok) return event;
  return ok({ event: event.value });
}

/**
 * Validates a reply.
 *
 * `value` is deliberately left as `unknown`: the caller knows which request it
 * sent and therefore which response type it expects, and a validator here would
 * have to switch on a request type this envelope does not carry. What is
 * checked is the envelope's own shape — that a success is a success and a
 * failure carries a problem with a code.
 */
export function checkReplyEnvelope(value: unknown): Checked<ReplyEnvelope> {
  if (!isRecord(value)) return bad("expected an object");
  const id = readInteger(value, "id");
  if (!id.ok) return id;

  const succeeded = value["ok"];
  if (typeof succeeded !== "boolean") return bad("ok: expected a boolean");
  if (succeeded) {
    if (!Object.hasOwn(value, "value")) return bad("value: missing");
    return ok({ id: id.value, ok: true, value: value["value"] });
  }

  const problem = within("problem", checkProblem(value["problem"]));
  if (!problem.ok) return problem;
  return ok({ id: id.value, ok: false, problem: problem.value });
}

function checkProblem(value: unknown): Checked<WireProblem> {
  if (!isRecord(value)) return bad("expected an object");
  const code = value["code"];
  if (typeof code !== "string" || code === "") return bad("code: expected a non-empty string");
  const message = value["message"];
  if (typeof message !== "string") return bad("message: expected a string");

  const detail = value["detail"];
  if (!isRecord(detail)) return bad("detail: expected an object");
  for (const [key, item] of Object.entries(detail)) {
    const kind = typeof item;
    if (item !== null && kind !== "string" && kind !== "number" && kind !== "boolean") {
      return bad(`detail.${key}: expected a string, number, boolean, or null`);
    }
  }

  return ok({
    code,
    message,
    detail: detail as Record<string, string | number | boolean | null>,
  });
}
