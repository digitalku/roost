import { generateMissing, Library } from "@roost/library";
import { bytes, rate, row, seconds } from "../format.js";

export interface ThumbArgs {
  readonly sizes: readonly number[];
  readonly limit: number;
}

export async function thumb(
  root: string,
  args: ThumbArgs,
  out: (line: string) => void,
  progress: (line: string) => void,
): Promise<void> {
  const library = await Library.open(root);
  try {
    let lastShown = 0;
    const report = await generateMissing(library, args.sizes, args.limit, (running) => {
      const done = running.generated + running.unsupported + running.missing;
      if (done - lastShown < 100) return;
      lastShown = done;
      progress(`  generated ${running.generated}`);
    });

    out(`Generated ${report.generated} thumbnail(s) at ${args.sizes.join(", ")} px`);
    if (report.unsupported > 0) {
      // Expected, not a fault: a PDF, a video, and a font all import normally
      // and have no thumbnail until the backend that draws them arrives.
      out(row("", `${report.unsupported} asset(s) this build cannot draw`, 1, 0));
    }
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
      out(`  failed ${failure.path}: ${failure.reason}`);
    }
  } finally {
    await library.close();
  }
}
