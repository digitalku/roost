/**
 * The half of Electron's `MessagePortMain` this engine actually uses.
 *
 * Declared here rather than imported from `electron`, so the engine's message
 * loop can be driven by a plain object in a test and so `@roost/desktop-engine`
 * needs no Electron in its dependency graph. The process it runs in is a host,
 * not a dependency — which is the same claim ADR-0006 makes about the CLI
 * hosting the same library in an ordinary Node process.
 */
export interface Port {
  on(channel: "message", listener: (message: { readonly data: unknown }) => void): void;
  postMessage(message: unknown): void;
  start(): void;
}
