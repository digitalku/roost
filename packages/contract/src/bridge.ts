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

/**
 * What the preload adds on top, and why it is not part of {@link RoostBridge}.
 *
 * `pathForFile` takes a DOM `File`, and this package compiles with neither DOM
 * nor Node types — deliberately, because "must load in a sandboxed renderer" is
 * enforced by the compiler here rather than asked for in review. Naming `File`
 * would mean widening `lib`, which would also hand this package `document` and
 * `window`, and the engine imports it.
 *
 * So the member is declared where its type already exists: the renderer, which
 * has DOM, and the preload, which builds the object. This interface is only a
 * reminder that the surface is three members and not two.
 */
export interface BridgeExtras {
  /**
   * The path of a file the user dropped on the window.
   *
   * The renderer's third and last piece of ambient authority, and the smallest
   * one that makes drag-and-drop import possible at all: a `File` from a drop
   * has carried no path of its own since Electron 32, and the renderer has no
   * `node:path`, no `fs`, and no way to read the file.
   *
   * It reads nothing and grants nothing. What comes back is a string the engine
   * treats as untrusted like any other request field, and it is only ever a
   * file the user themselves dragged onto the window.
   */
  readonly pathForFile: unknown;
}
