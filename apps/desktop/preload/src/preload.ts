import type { Outcome, RequestOf, RequestType, ResponseOf, RoostBridge } from "@roost/contract";
import { contextBridge, ipcRenderer } from "electron";

/**
 * The `contextBridge` surface, and nothing else.
 *
 * This file is the whole of the renderer's ambient authority: two functions,
 * over one channel each. It holds no logic, reads no files, and imports nothing
 * from `@roost/contract` at run time — only its types, which are erased. A
 * sandboxed preload cannot load ESM or resolve a local module, so anything more
 * would have to be bundled, and a bundle is a place for things to hide.
 */

const REQUEST_CHANNEL = "roost:request";
const EVENT_CHANNEL = "roost:event";

const bridge: RoostBridge = {
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
};

function isEnvelope(value: unknown): value is { event: unknown } {
  return typeof value === "object" && value !== null && "event" in value;
}

contextBridge.exposeInMainWorld("roost", bridge);
