/**
 * `@roost/cli` produces the `roost` binary: a first-class frontend over the
 * same services the desktop app uses (ADR-0005). The graphical interface may
 * not grow a capability this lacks.
 *
 * It is also how the engine is exercised without Electron, which is how it runs
 * in CI and in containers where no window can open.
 *
 * Arrives with M1.
 */
export {};
