/**
 * `@roost/core` owns everything `docs/STORAGE_SPEC.md` governs, so the binding
 * specification maps to exactly one package and a reviewer has one place to
 * check compliance.
 *
 * Modules arrive with the milestone that needs them: `model` is here, and
 * `db`, `storage`, `journal`, `platform`, and `log` land in M1.
 */
export * from "./model/index.js";
