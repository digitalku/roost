import type {
  Event,
  Outcome,
  RequestOf,
  RequestType,
  ResponseOf,
  RoostBridge,
} from "@roost/contract";
import { checkEvent } from "@roost/contract";

/**
 * The renderer's side of `window.roost`.
 *
 * Two things happen here and nowhere else: the global is read once and typed,
 * and every event arriving from main is **validated before it is believed**.
 * The type on the other side of `contextBridge` was erased two processes ago,
 * and the rule is that a message is checked at the end that receives it.
 */

declare global {
  interface Window {
    readonly roost?: RoostBridge;
  }
}

/**
 * Missing only when the page is open somewhere that is not the app — a browser
 * pointed at the dev server, which is a real thing to do by accident.
 */
export function bridge(): RoostBridge {
  const found = window.roost;
  if (found === undefined) {
    throw new Error("window.roost is missing: this page is not running inside Roost");
  }
  return found;
}

/** Sends a request and returns its outcome. Never throws for a failed request. */
export function invoke<T extends RequestType>(
  request: RequestOf<T>,
): Promise<Outcome<ResponseOf<T>>> {
  return bridge().invoke(request);
}

/** Subscribes to engine events, dropping anything that does not validate. */
export function onEvent(listener: (event: Event) => void): () => void {
  return bridge().onEvent((payload) => {
    const checked = checkEvent(payload);
    if (checked.ok) listener(checked.value);
    // A payload that does not validate is dropped in silence here on purpose:
    // the renderer has no log sink, and main already logged what it forwarded.
  });
}
