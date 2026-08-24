/**
 * `@roost/cli` is a first-class frontend, not a debugging aid (ADR-0005).
 *
 * M1 is deliberately GUI-free: the engine has to be provable on its own, and in
 * a container where no window can open. Everything here goes through
 * `@roost/library`, the same service layer the desktop shell will use.
 */
export { EXIT, run, type Streams } from "./run.js";
