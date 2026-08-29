import { execFile, spawn } from "node:child_process";
import { isAbsolute } from "node:path";

/**
 * Running a tool Roost does not ship.
 *
 * ADR-0017 makes the rules here part of the decision rather than of its
 * implementation, because "shell out to ffmpeg" is where a project usually
 * acquires a command injection. They are enforced in this one module so that no
 * caller has to remember them:
 *
 * - `spawn` and `execFile` with an argument array. Never a shell, never
 *   `shell: true`, never a command assembled by concatenation. A filename
 *   containing `;` or `$(…)` is an ordinary filename in a real library.
 * - Every run is bounded by a timeout and by a cap on what it may return.
 * - Bytes come back through a pipe. Nothing is written to a temporary file, so
 *   a crash leaves nothing behind and no bytes touch a user's directory.
 */

/** How long any single external run may take before it is killed. */
export const RUN_TIMEOUT_MS = 30_000;

/** The most a captured run may return. A 4K PNG frame is roughly 24 MiB. */
export const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

/** A tool exited non-zero, was killed, or could not be started. */
export class ExternalToolError extends Error {
  readonly tool: string;
  readonly detail: string;

  constructor(tool: string, detail: string) {
    super(`${tool}: ${detail}`);
    this.name = "ExternalToolError";
    this.tool = tool;
    this.detail = detail;
  }
}

/**
 * A path as an argument, never as an option.
 *
 * ffmpeg reads a leading `-` as an option, and quoting does not help: the
 * argument is passed to `execve` directly, so there is no shell to quote for.
 * Prefixing `./` makes it a path again. Absolute paths already are one.
 */
export function asPathArgument(path: string): string {
  return isAbsolute(path) || !path.startsWith("-") ? path : `./${path}`;
}

/**
 * Runs a tool and returns everything it wrote to stdout.
 *
 * Rejects with {@link ExternalToolError} on a non-zero exit, a timeout, or a
 * missing binary — the caller decides whether that is a blocked job or a failed
 * one, because only it knows whether the tool was expected to exist.
 */
export async function capture(
  tool: string,
  args: readonly string[],
  timeoutMs = RUN_TIMEOUT_MS,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      tool,
      [...args],
      {
        timeout: timeoutMs,
        maxBuffer: MAX_CAPTURE_BYTES,
        encoding: "buffer",
        // An inherited environment is what makes `ROOST_FFMPEG` and a user's
        // own PATH work; nothing here passes anything into it.
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        // `stderr` carries ffmpeg's own explanation, which is far more useful
        // in a job's `reason` than "exited with code 1". Trimmed to the last
        // line, since the banner above it is the same every time.
        const said = lastLine(stderr.toString("utf8"));
        reject(new ExternalToolError(tool, said === "" ? error.message : said));
      },
    );
  });
}

/**
 * Runs a tool and hands each chunk of stdout to `onChunk` as it arrives.
 *
 * For output that must not be held whole: an hour of PCM is tens of megabytes,
 * and a waveform only needs the peaks, which can be computed as the bytes go
 * past.
 */
export async function stream(
  tool: string,
  args: readonly string[],
  onChunk: (chunk: Buffer) => void,
  timeoutMs = RUN_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, [...args], { windowsHide: true });
    let errorOutput = "";
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(new ExternalToolError(tool, `timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    child.stdout.on("data", onChunk);
    // Bounded: a tool that fails on every frame of a long file would otherwise
    // grow this without limit while producing nothing.
    child.stderr.on("data", (chunk: Buffer) => {
      if (errorOutput.length < 8192) errorOutput += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ExternalToolError(tool, error.message));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        const said = lastLine(errorOutput);
        reject(new ExternalToolError(tool, said === "" ? `exited with ${code}` : said));
      }
    });
  });
}

function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.at(-1) ?? "";
}
