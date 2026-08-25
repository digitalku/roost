import type { WireProblem } from "./dto.js";
import type { RequestOf, RequestType, ResponseOf } from "./request.js";

/**
 * The renderer's only door, as a type.
 *
 * Declared here because both sides need it and neither owns it: the preload
 * builds the object, the renderer consumes it, and this package is the one
 * thing they both already depend on.
 */

/**
 * A call's result.
 *
 * Never a thrown error. An exception crossing `contextBridge` arrives as a
 * plain `Error` with the code stripped — the same loss `WireProblem` exists to
 * prevent — so a failure is a value here and the caller has to look at it.
 */
export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: WireProblem };

export interface RoostBridge {
  invoke<T extends RequestType>(request: RequestOf<T>): Promise<Outcome<ResponseOf<T>>>;

  /**
   * Subscribes to engine events. Returns the unsubscribe.
   *
   * The listener is handed `unknown` on purpose. Main forwards what the engine
   * sent, and the rule is that every message is validated **at the receiving
   * end** — so the renderer runs `checkEvent` itself rather than trusting a
   * type that was erased two processes ago.
   */
  onEvent(listener: (event: unknown) => void): () => void;
}
