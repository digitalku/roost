import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { IoError, UnsupportedPlatformError } from "../model/index.js";

/**
 * Handing a file to the desktop — to the file manager, or to whatever
 * application owns it.
 *
 * Two mechanisms, in order. The freedesktop `FileManager1` D-Bus interface
 * **selects** the file, which is what "reveal" means; `xdg-open` on the parent
 * directory only opens the folder and leaves the user to find it again. The
 * second is a fallback, not an equivalent.
 */

const run = promisify(execFile);

/** Opens the user's file manager with `path` selected. */
export async function revealInFileManager(path: string): Promise<void> {
  requireLinux("revealing a file in the file manager");
  const canonical = await canonicalize(path);

  try {
    await showItemsOverDbus(canonical);
    return;
  } catch {
    // No file manager on the bus, or no bus at all — a headless session, a
    // container, a minimal desktop. Opening the folder is worse than selecting
    // the file, and much better than doing nothing.
  }

  await spawn("xdg-open", [dirname(canonical)]);
}

async function showItemsOverDbus(path: string): Promise<void> {
  await spawn("dbus-send", [
    "--session",
    "--dest=org.freedesktop.FileManager1",
    "--type=method_call",
    "/org/freedesktop/FileManager1",
    "org.freedesktop.FileManager1.ShowItems",
    `array:string:file://${path}`,
    "string:",
  ]);
}

/**
 * Opens `path` in whatever application the desktop associates with it.
 *
 * The escape hatch for everything Roost cannot render itself. A library is not
 * only a media collection — a `.psd`, a `.blend`, a spreadsheet all belong in
 * one, and none of them will ever open inside a webview. Rather than showing
 * the user a dead end, hand the file to the tool that owns it.
 *
 * The application it hands the file to may well write to it, and under version
 * 2 that is the point rather than a hazard (RL-20): the asset keeps its id, and
 * the watcher notices the save and derives it again (ADR-0047).
 */
export async function openExternally(path: string): Promise<void> {
  requireLinux("opening a file with its default application");
  await spawn("xdg-open", [await canonicalize(path)]);
}

function requireLinux(operation: string): void {
  if (process.platform !== "linux") throw new UnsupportedPlatformError(operation);
}

async function canonicalize(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (cause) {
    throw new IoError("canonicalize", path, cause);
  }
}

/**
 * Runs a command and waits for it.
 *
 * Waits rather than detaching: a file manager that is not installed has to be
 * reported so the caller can fall back, and a spawned-and-forgotten process
 * cannot tell anyone it failed. Both commands here return as soon as they have
 * handed off to an already-running desktop process.
 */
async function spawn(program: string, args: readonly string[]): Promise<void> {
  try {
    await run(program, [...args]);
  } catch {
    throw new UnsupportedPlatformError(`launching ${program}`);
  }
}
