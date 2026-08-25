import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Finding a filesystem to test against, rather than assuming one.
 *
 * `os.tmpdir()` follows `$TMPDIR`, and pointing that somewhere other than
 * `/tmp` is an ordinary thing for a developer or a sandbox to do. Two checks
 * here depend on *which* filesystem they are running on — reflink support, and
 * whether a copy crosses a device — and both quietly stopped testing anything
 * when `$TMPDIR` moved onto the same Btrfs as the repository. The mount table
 * is what actually knows.
 *
 * Test-only, and deliberately not exported from the package.
 */

/**
 * A fresh directory on a tmpfs mount: no copy-on-write, and a different device
 * from anything on disk.
 *
 * Every Linux system has at least one writable tmpfs mount. A machine with none
 * fails here loudly rather than skipping quietly, which is the right way round
 * for a helper whose whole job is to make a check possible.
 */
export async function tmpfsDir(prefix: string): Promise<string> {
  const mounts = await readFile("/proc/mounts", "utf8");
  for (const line of mounts.split("\n")) {
    const [, point, type] = line.split(" ");
    if (type !== "tmpfs" || point === undefined) continue;
    try {
      return await mkdtemp(join(point, prefix));
    } catch {
      // Listed but not writable by this user, which several of them are not.
    }
  }
  throw new Error("no writable tmpfs mount to test against");
}
