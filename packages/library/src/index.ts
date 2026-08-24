/**
 * `@roost/library` is the application service layer and the only public API
 * worth calling: open and create, import, edit, search, thumbnails, doctor,
 * and rebuild.
 *
 * It must run in a plain Node process. The engine hosts it in a
 * `utilityProcess` and the CLI calls it directly (ADR-0005, ADR-0006), and that
 * the two hosts stay interchangeable is what keeps the layering honest —
 * nothing here may import `electron`.
 *
 * Arrives with M1.
 */
export {};
