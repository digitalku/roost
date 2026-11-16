import { mkdtemp, readFile, realpath } from "node:fs/promises";
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

/**
 * The type of the filesystem `path` sits on, as the mount table names it: the
 * longest mount point that contains it.
 *
 * For deciding whether a check can run here at all, never for what the code
 * under test should conclude — `caps.ts` probes rather than trusting a name.
 */
export async function filesystemOf(path: string): Promise<string | undefined> {
  const target = await realpath(path);
  const mounts = await readFile("/proc/mounts", "utf8");
  let best: { point: string; type: string } | undefined;
  for (const line of mounts.split("\n")) {
    const [, escaped, type] = line.split(" ");
    if (escaped === undefined || type === undefined) continue;
    // The table writes a space, a tab, a newline and a backslash as octal.
    const point = escaped.replace(/\\([0-7]{3})/g, (_, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    );
    const contains =
      point === "/" ||
      target === point ||
      target.startsWith(point.endsWith("/") ? point : `${point}/`);
    if (contains && (best === undefined || point.length >= best.point.length)) {
      best = { point, type };
    }
  }
  return best?.type;
}
