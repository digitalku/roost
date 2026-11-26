import type { JournalNotice, OpenOptions } from "@roost/library";
import { Library, libraryNameFromPath, PasswordRequiredError, readManifest } from "@roost/library";

/**
 * Where a library's journal notice goes.
 *
 * Installed once by `run`, the way the log sink is, rather than threaded
 * through forty call sites of {@link withLibrary}. RL-28 requires the **person**
 * be told when a journal holds operations this build cannot apply, and every
 * command that opens a library is a place that has to say it — so the saying
 * belongs at the open rather than in each command.
 */
let announce: ((line: string) => void) | undefined;

export function setNoticeSink(warn: (line: string) => void): void {
  announce = warn;
}

/**
 * Opens a library, runs `body`, and closes it however that ends.
 *
 * Closing is not optional: the journal buffers, and a library dropped without
 * closing loses whatever had not been flushed. Every command that touches one
 * goes through here rather than remembering to write the `finally` itself.
 */
export async function withLibrary<T>(
  root: string,
  body: (library: Library) => Promise<T>,
): Promise<T> {
  const library = await openLibrary(root);
  try {
    if (announce !== undefined) for (const line of noticeLines(library.notice)) announce(line);
    return await body(library);
  } finally {
    await library.close();
  }
}

/**
 * What to say about what the journal held and this build could not use.
 *
 * Empty when there is nothing to say, which is the ordinary case: a notice
 * printed before every command would be a notice nobody reads.
 *
 * The two halves are deliberately different in weight. An unrecognised
 * operation means **another build holds meaning this one cannot show**, and the
 * person can act on that by opening the library there — RL-28 requires it be
 * said. A dangling reference is the ordinary result of editing one library from
 * two builds, so it is one line and no advice (RL-26a).
 */
export function noticeLines(notice: JournalNotice): string[] {
  const lines: string[] = [];

  for (const skipped of notice.skipped) {
    const whose =
      skipped.platformLabel === null
        ? "a later revision of the library format"
        : skipped.platformLabel;
    lines.push(`Skipped ${skipped.count} × ${skipped.op} — ${whose} wrote it.`);
  }
  if (notice.skipped.length > 0) {
    lines.push("Those records are still in the journal, and are not lost. Open the library in");
    lines.push("the build that wrote them to see what they say.");
  }

  if (notice.dangling > 0) {
    lines.push(
      `${notice.dangling} record(s) named something that is not in the library, and were skipped.`,
    );
  }

  return lines;
}

/**
 * What a password is wanted for (ADR-0071 §3.4): the library a command works
 * on, the library `move` and `copy` write into, or the new password of
 * `roost password`.
 */
export type PasswordRole = "library" | "target" | "new" | "again";

/** Asked once per password the command needs; `undefined` is "none to give". */
export type PasswordSource = (role: PasswordRole, root: string) => Promise<string | undefined>;

/**
 * Where each role's password comes from when nothing is typed.
 *
 * An environment variable rather than an argument, because an argument shows
 * up in `ps` and in the shell's history, and a password in either is a
 * password somebody else can read.
 */
export const PASSWORD_VARIABLES: Readonly<Record<Exclude<PasswordRole, "again">, string>> = {
  library: "ROOST_PASSWORD",
  target: "ROOST_TARGET_PASSWORD",
  new: "ROOST_NEW_PASSWORD",
};

let passwords: PasswordSource = fromEnvironmentOrTerminal;

/** Replaces where passwords come from. Tests install one; nothing else should. */
export function setPasswordSource(source: PasswordSource): void {
  passwords = source;
}

/** The password `role` needs, or `undefined` when there is none to give. */
export function askPassword(role: PasswordRole, root: string): Promise<string | undefined> {
  return passwords(role, root);
}

/**
 * Opens a library, asking for its password only when it has one (RL-5c).
 *
 * The manifest is read first so that a library without a password never makes
 * anybody type one, and a library with one opens for what the source gives or
 * is refused by the engine exactly as the window is (RL-5d).
 */
export async function openLibrary(
  root: string,
  options: OpenOptions = {},
  role: "library" | "target" = "library",
): Promise<Library> {
  const password = await passwordToOpen(root, role);
  return Library.open(root, { ...options, ...(password === undefined ? {} : { password }) });
}

/**
 * The password `root` needs to open, read from the source, or `undefined` for
 * a library without one. A library with one and nothing to give is refused
 * here, before the engine is asked.
 */
export async function passwordToOpen(
  root: string,
  role: "library" | "target",
): Promise<string | undefined> {
  if ((await readManifest(root)).password === null) return undefined;
  const password = await askPassword(role, root);
  if (password === undefined) throw new PasswordRequiredError(root);
  return password;
}

async function fromEnvironmentOrTerminal(
  role: PasswordRole,
  root: string,
): Promise<string | undefined> {
  // "Type it again" reads the same variable as the new password: a script that
  // set it has no second hand to slip with, so the two always agree.
  const given = process.env[PASSWORD_VARIABLES[role === "again" ? "new" : role]];
  if (given !== undefined && given !== "") return given;
  if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) return undefined;
  const name = libraryNameFromPath(root);
  const question =
    role === "new"
      ? "New password: "
      : role === "again"
        ? "Type it again: "
        : `Password for ${name}: `;
  return promptHidden(question);
}

/**
 * Reads a line from the terminal without echoing it.
 *
 * Raw mode and a few control characters by hand, because `readline` echoes and
 * muting its output is reaching into a private method. Ctrl+C and an empty
 * Ctrl+D give nothing, which the caller reports as a password not given.
 */
function promptHidden(question: string): Promise<string | undefined> {
  const input = process.stdin;
  process.stderr.write(question);
  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();
  return new Promise((resolve) => {
    let typed = "";
    const finish = (value: string | undefined): void => {
      input.removeListener("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stderr.write("\n");
      resolve(value);
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          finish(typed);
          return;
        }
        if (character === "\u0003" || character === "\u0004") {
          finish(character === "\u0004" && typed !== "" ? typed : undefined);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          typed = [...typed].slice(0, -1).join("");
          continue;
        }
        typed += character;
      }
    };
    input.on("data", onData);
  });
}
