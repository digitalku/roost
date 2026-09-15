import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type Db,
  IoError,
  monthsIn,
  platformName,
  platformOf,
  type ReplayReport,
} from "@roost/core";

/**
 * What the index knows about the journal it was folded from.
 *
 * Three questions, and the index is the only place any of them can be answered
 * cheaply: has the journal moved since this cache was built, what did the fold
 * have to skip, and whose was it.
 *
 * All of it is derived — `meta` is not journalled and a rebuild recomputes
 * every key here — so none of it weakens invariant 1. It is in the cache
 * because that is what a cache is for: the alternative is re-reading a
 * million-line journal to answer a question the window asks at every open.
 */

/** How far the index has folded each month file, as `{ "2026-01": bytes }`. */
const FOLDED_KEY = "journal.folded";
/** Operations the fold did not recognise, as `{ "mac.quicklook_tag": 1 }`. */
const SKIPPED_KEY = "journal.skipped";
/** How many records named something that was not there (RL-26a). */
const DANGLING_KEY = "journal.dangling";

/**
 * One operation a fold could not apply, and whose it is.
 *
 * `platform` comes from the name itself (RL-29): a core operation carries no
 * prefix, and one belonging to a platform carries it before a dot. That single
 * character is what lets the message say *"this is available in Roost for
 * Mac"* without anybody keeping a registry of everybody's features.
 */
export interface SkippedOp {
  readonly op: string;
  readonly count: number;
  /** `null` for a core operation from a later revision of the format. */
  readonly platform: string | null;
  /** The platform under a name a person would recognise. `null` with it. */
  readonly platformLabel: string | null;
}

/**
 * What the last fold of this library's journal could not do.
 *
 * Empty is the ordinary answer and means the window says nothing. RL-28
 * requires the first list be told to the **person** rather than only to a log:
 * an unrecognised operation means another build holds meaning this one cannot
 * show, and opening the library there is something only they can do. The
 * dangling count is deliberately not in that category — it is the ordinary
 * result of editing a library from two builds, and the same requirement says
 * it is a diagnostic rather than news.
 */
export interface JournalNotice {
  readonly skipped: readonly SkippedOp[];
  readonly dangling: number;
}

export const NOTHING_SKIPPED: JournalNotice = { skipped: [], dangling: 0 };

/**
 * The size of every month file, which is what "the journal has not moved" means.
 *
 * Sizes rather than hashes: the journal is append-only (RL-18, RL-22), so a
 * file that has grown has been appended to and a file that has not cannot have
 * changed. Reading the bytes to hash them would make every open cost what a
 * rebuild costs, to learn something the length already says.
 *
 * It is not a security measure and does not need to be. It answers "did another
 * build write here while this one was closed", and the answer is wrong only if
 * somebody rewrote the journal in place to exactly its former length — which
 * RL-22 forbids and which no implementation does.
 */
export async function journalFingerprint(journalDir: string): Promise<Record<string, number>> {
  const fingerprint: Record<string, number> = {};
  for (const month of await monthsIn(journalDir)) {
    const path = join(journalDir, `${month}.jsonl`);
    try {
      fingerprint[month] = (await stat(path)).size;
    } catch (cause) {
      throw new IoError("stat", path, cause);
    }
  }
  return fingerprint;
}

/**
 * Whether the index still describes the journal on disk.
 *
 * False for the three cases that matter, and they are one case: a cache that
 * was never built (a library this build has not opened before, or one written
 * by another implementation, which keeps its own), a cache somebody deleted,
 * and a cache built before another implementation appended to the journal. The
 * format puts the index outside itself for exactly this reason — RL-2 — so
 * meeting a library with no cache of ours is the normal case rather than the
 * damaged one.
 */
export function indexMatchesJournal(db: Db, fingerprint: Record<string, number>): boolean {
  const stored = db.repo.meta(FOLDED_KEY);
  if (stored === undefined) return false;
  return stored === JSON.stringify(fingerprint);
}

/** Records that the index now reflects the journal as it stands on disk. */
export function rememberFold(db: Db, fingerprint: Record<string, number>): void {
  db.repo.setMeta(FOLDED_KEY, JSON.stringify(fingerprint));
}

/** Records what a replay skipped, so a later open can say so without replaying. */
export function rememberSkips(db: Db, report: ReplayReport): void {
  const counts: Record<string, number> = {};
  for (const [op, count] of report.unknownOps) counts[op] = count;
  db.repo.setMeta(SKIPPED_KEY, JSON.stringify(counts));
  db.repo.setMeta(DANGLING_KEY, String(report.dangling.length));
}

/**
 * What this library's last fold could not do.
 *
 * Read from the cache rather than recomputed, which is the whole reason it is
 * written down: the question is asked at every open and answering it honestly
 * would otherwise mean replaying the journal to find out.
 */
export function journalNotice(db: Db): JournalNotice {
  const raw = db.repo.meta(SKIPPED_KEY);
  const dangling = Number.parseInt(db.repo.meta(DANGLING_KEY) ?? "0", 10);

  let counts: Record<string, unknown> = {};
  if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        counts = parsed as Record<string, unknown>;
      }
    } catch {
      // A hand-edited `meta` row is not worth failing an open over: the index
      // is a cache, and the worst outcome is a notice this session does not
      // draw. The next rebuild writes a good value.
    }
  }

  const skipped: SkippedOp[] = [];
  for (const [op, count] of Object.entries(counts)) {
    if (typeof count !== "number" || count <= 0) continue;
    const platform = platformOf(op) ?? null;
    skipped.push({
      op,
      count,
      platform,
      platformLabel: platform === null ? null : platformName(platform),
    });
  }
  skipped.sort((a, b) => a.op.localeCompare(b.op));

  return { skipped, dangling: Number.isFinite(dangling) ? dangling : 0 };
}
