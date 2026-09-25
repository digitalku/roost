import { generateMissing, Library, queueStatus, retryBlocked, retryFailed } from "@roost/library";
import { capabilities } from "@roost/media";
import { bytes, rate, row, seconds } from "../format.js";

export interface ThumbArgs {
  readonly sizes: readonly number[];
  readonly limit: number;
  /** Offer parked work again, now that a backend may have arrived. */
  readonly retryBlocked?: boolean;
  /** Offer work that failed, up to three attempts each. */
  readonly retry?: boolean;
}

export async function thumb(
  root: string,
  args: ThumbArgs,
  out: (line: string) => void,
  progress: (line: string) => void,
): Promise<void> {
  const library = await Library.open(root);
  try {
    if (args.retryBlocked === true) {
      const released = retryBlocked(library);
      out(`Released ${released} parked job(s)`);
    }
    if (args.retry === true) {
      const released = retryFailed(library);
      out(`Retrying ${released} failed job(s)`);
    }

    let lastShown = 0;
    const report = await generateMissing(library, args.sizes, args.limit, (running) => {
      const done = running.generated + running.unsupported + running.missing;
      if (done - lastShown < 100) return;
      lastShown = done;
      progress(`  generated ${running.generated}`);
    });

    out(`Generated ${report.generated} thumbnail(s) at ${args.sizes.join(", ")} px`);
    if (report.missing > 0) {
      out(
        row("", `${report.missing} referenced original(s) no longer at their recorded path`, 1, 0),
      );
    }
    out(row("", `${bytes(report.bytes)} of WebP`, 1, 0));
    out(
      row("", `${seconds(report.elapsed)} · ${rate(report.generated, report.elapsed)}/sec`, 1, 0),
    );

    for (const failure of report.failed.slice(0, 10)) {
      out(`  failed ${failure.path.slice(0, 12)}: ${failure.reason}`);
    }

    // What is left, and why. A parked job is not a fault — it is work waiting
    // on a capability this machine does not have, or on a format nothing in
    // this build draws — but it is the difference between an empty cell that
    // means something and one that means nothing.
    const status = queueStatus(library);
    if (status.blocked > 0 || status.failed > 0) {
      out("");
      out(`${status.blocked} parked, ${status.failed} failed`);
      for (const reason of status.reasons) {
        out(row("", `${reason.count} × ${reason.reason}`, 1, 0));
      }
      if (status.reasons.some((reason) => reason.reason.startsWith("missing:ff"))) {
        const media = (await capabilities()).find((entry) => entry.name === "media");
        if (media?.available === false) out(row("", media.detail, 1, 0));
      }
      // An ffmpeg that runs and cannot decode what it was given: the detail
      // names what it lacks, and the command is the one that replaces it.
      if (status.reasons.some((reason) => reason.reason.startsWith("missing:decoder:"))) {
        const media = (await capabilities()).find((entry) => entry.name === "media");
        if (media !== undefined) out(row("", media.detail, 1, 0));
        if (media?.install) out(row("", media.install, 1, 0));
      }
      if (status.failed > 0) out(row("", "pass --retry to try the failures again", 1, 0));
      if (status.blocked > 0) {
        out(row("", "pass --retry-blocked after installing a missing tool", 1, 0));
      }
    }
  } finally {
    await library.close();
  }
}
