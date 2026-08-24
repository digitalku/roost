import { resolve } from "node:path";
import { type FixtureOptions, generateFixture } from "@roost/library";
import { bytes, row, seconds } from "../format.js";

export async function fixture(
  out: string,
  options: FixtureOptions,
  print: (line: string) => void,
): Promise<void> {
  const root = resolve(out);
  const started = performance.now();
  const report = await generateFixture(root, options);
  const elapsed = performance.now() - started;

  print(
    `Generated ${report.files} files (${report.duplicates} duplicates) ` +
      `across ${report.directories} directories in ${seconds(elapsed)}`,
  );
  print(row("", `${bytes(report.bytes)} written to ${root}`, 1, 0));
}
