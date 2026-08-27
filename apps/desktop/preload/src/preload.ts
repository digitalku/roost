import type { Outcome, RequestOf, RequestType, ResponseOf, RoostBridge } from "@roost/contract";
import { contextBridge, ipcRenderer, webUtils } from "electron";

/**
 * The `contextBridge` surface, and nothing else.
 *
 * This file is the whole of the renderer's ambient authority: three functions,
 * two of them over one channel each and the third a pure lookup. It holds no logic, reads no files, and imports nothing
 * from `@roost/contract` at run time — only its types, which are erased. A
 * sandboxed preload cannot load ESM or resolve a local module, so anything more
 * would have to be bundled, and a bundle is a place for things to hide.
 */

const REQUEST_CHANNEL = "roost:request";
const EVENT_CHANNEL = "roost:event";

/**
 * `RoostBridge` plus the one member that needs a DOM type.
 *
 * `@roost/contract` compiles without DOM and without Node, so it cannot name
 * `File` — see `BridgeExtras` there. This is where the two halves meet.
 */
type Bridge = RoostBridge & { pathForFile(file: File): string };

const bridge: Bridge = {
  invoke: <T extends RequestType>(request: RequestOf<T>): Promise<Outcome<ResponseOf<T>>> =>
    ipcRenderer.invoke(REQUEST_CHANNEL, request) as Promise<Outcome<ResponseOf<T>>>,

  onEvent: (listener: (event: unknown) => void): (() => void) => {
    // The Electron event object is dropped rather than forwarded: it carries a
    // sender the renderer has no business holding.
    const wrapped = (_source: unknown, payload: unknown): void => {
      listener(isEnvelope(payload) ? payload.event : payload);
    };
    ipcRenderer.on(EVENT_CHANNEL, wrapped);
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNEL, wrapped);
    };
  },

  // A `File` from a drop has carried no `path` since Electron 32, and this is
  // the replacement. It reads nothing and opens nothing: it answers where a
  // file the user dragged onto this window already lives, and only for one
  // they dragged.
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
};

function isEnvelope(value: unknown): value is { event: unknown } {
  return typeof value === "object" && value !== null && "event" in value;
}

contextBridge.exposeInMainWorld("roost", bridge);
