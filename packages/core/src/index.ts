/**
 * `@roost/core` owns everything `docs/STORAGE_SPEC.md` governs, so the binding
 * specification maps to exactly one package and a reviewer has one place to
 * check compliance.
 *
 * Modules arrive with the milestone that needs them: `model` and `storage` are
 * here, and `db`, `journal`, `platform`, and `log` land in M1 alongside them.
 */
export * from "./model/index.js";
export * from "./storage/index.js";
