/**
 * `@roost/core` owns everything `docs/STORAGE_SPEC.md` governs, so the binding
 * specification maps to exactly one package and a reviewer has one place to
 * check compliance.
 *
 * Modules arrive with the milestone that needs them: `model`, `storage`, and
 * `journal` are here; `db`, `platform`, and `log` land in M1 alongside them.
 */
export * from "./journal/index.js";
export * from "./model/index.js";
export * from "./storage/index.js";
