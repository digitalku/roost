/**
 * `@roost/contract` is the IPC surface as data: one union of request messages,
 * one union of event messages, and a validator per member (ADR-0007).
 *
 * It is imported by main, preload, the renderer, and the engine, so it depends
 * on nothing — not on `@roost/core`, not on a Node built-in, not on the DOM.
 * Anything that cannot be structured-cloned does not belong in it, and neither
 * do bytes (ADR-0008).
 *
 * Arrives with M3, which is the first milestone with two processes to talk to
 * each other.
 */
export {};
