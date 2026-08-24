import { constants } from "node:fs";
import { copyFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * What the filesystem under a given path can actually do.
 *
 * Probed, never guessed from a filesystem name. `/proc/mounts` would say
 * "btrfs" for a subvolume that cannot reflink to the source anyway, and would
 * say nothing useful about an overlay, a bind mount, or a network filesystem
 * that supports server-side copy. Trying it is the only honest answer, and it
 * costs two empty files.
 */

export const REFLINK_SUPPORT = ["yes", "no", "unknown"] as const;

/**
 * Whether copy-on-write cloning works in a directory.
 *
 * `unknown` is not a soft `no`. It means the probe itself could not run — no
 * write permission, no space — which says nothing about reflink either way, and
 * a caller must not report it as "importing here will copy bytes".
 */
export type ReflinkSupport = (typeof REFLINK_SUPPORT)[number];

const PROBE_SOURCE = ".roost-reflink-probe-src";
const PROBE_DESTINATION = ".roost-reflink-probe-dst";

/**
 * Probes whether `directory` supports reflinks.
 *
 * Cheap enough to run when a library opens, which is where the answer is worth
 * showing: "importing here copies bytes" is something a user should learn
 * before importing 200 GB, not after.
 *
 * Uses `COPYFILE_FICLONE_FORCE`, which **refuses** rather than falling back —
 * the whole basis of ADR-0012. The plain `COPYFILE_FICLONE` hint would report
 * success on a filesystem that quietly copied, and this probe would then
 * promise a speed the importer cannot deliver.
 */
export async function reflinkSupported(directory: string): Promise<ReflinkSupport> {
  const source = join(directory, PROBE_SOURCE);
  const destination = join(directory, PROBE_DESTINATION);
  const cleanup = async (): Promise<void> => {
    await rm(source, { force: true });
    await rm(destination, { force: true });
  };

  try {
    await writeFile(source, "");
  } catch {
    await cleanup();
    return "unknown";
  }

  // A leftover destination from an interrupted probe would fail the clone for
  // the wrong reason.
  await rm(destination, { force: true });

  try {
    await copyFile(source, destination, constants.COPYFILE_FICLONE_FORCE);
    return "yes";
  } catch {
    return "no";
  } finally {
    await cleanup();
  }
}
