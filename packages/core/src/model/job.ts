/**
 * Work the library owes an asset but does not do during import.
 *
 * Derived work is queued rather than run inline because it is orders of
 * magnitude more expensive than placing bytes — a video thumbnail costs two
 * process spawns (ADR-0017) where an import step costs a `rename` — and because
 * it can fail for reasons that are not the asset's fault. A queued job survives
 * a crash, resumes, and can be re-run when a missing backend appears.
 */
export const JOB_KINDS = ["derive"] as const;

export type JobKind = (typeof JOB_KINDS)[number];

export function isJobKind(value: string): value is JobKind {
  return (JOB_KINDS as readonly string[]).includes(value);
}

/**
 * Where a job is.
 *
 * A finished job is deleted, so there is no `done`: the derived data is its own
 * record that the work happened (`DATA_MODEL.md` §2.5).
 *
 * - `ready` — waiting to be claimed.
 * - `running` — claimed by a runner. Not a state that survives a crash; the
 *   runner resets these to `ready` when it starts.
 * - `blocked` — cannot be done on this machine as it stands: no ffmpeg, or a
 *   format nothing in this build can draw. Waiting on the world to change,
 *   not on a retry.
 * - `failed` — was tried and did not survive. Waiting on a retry.
 */
export const JOB_STATES = ["ready", "running", "blocked", "failed"] as const;

export type JobState = (typeof JOB_STATES)[number];

export function isJobState(value: string): value is JobState {
  return (JOB_STATES as readonly string[]).includes(value);
}

/**
 * Claim order, lowest first.
 *
 * An asset someone is looking at outranks the backfill behind it: the grid asks
 * for what is on screen, and a scroll should not wait behind ten thousand
 * queued thumbnails. The numbers are spaced so a priority can be inserted
 * between two of them without renumbering what is already queued.
 */
export const JOB_PRIORITY = {
  /** Something is on screen waiting for this. */
  interactive: 0,
  /** Just imported, and the window is showing it. */
  import: 10,
  /** Filling in what an older import or a rebuild left missing. */
  backfill: 20,
} as const;
