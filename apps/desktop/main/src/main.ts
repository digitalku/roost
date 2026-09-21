import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  Event,
  ImportSubject,
  Request,
  RequestType,
  Take,
  WireAbout,
  WireImportReport,
  WirePasted,
} from "@roost/contract";
import { checkRequest } from "@roost/contract";
import {
  type ClosableSink,
  fileSink,
  filterSink,
  isAssetId,
  isLogLevel,
  type LogLevel,
  logger,
  setLogLevel,
  setSink,
  stderrSink,
  teeSink,
} from "@roost/core";
import { SUBTITLE_EXTENSIONS } from "@roost/media/serving";
import { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, shell } from "electron";
import { AssetServer } from "./assets.js";
import { isHttpUrl, pastedName, pathsFromUriList } from "./clipboard.js";
import { Engine, EngineGoneError, EngineProblem } from "./engine.js";
import { ROOST_SCHEME, ROOST_SCHEME_PRIVILEGES } from "./security.js";
import { createWindow, installApplicationMenu } from "./window.js";

/**
 * Electron main: the window, the route to the engine, and nothing else.
 *
 * `ARCHITECTURE.md` invariant 4 applies here as much as to the CLI — a handler
 * is validate → call service → return. Anything longer belongs in the engine,
 * which is where `@roost/library` lives.
 */

/**
 * The file gets everything; the terminal gets what someone watching it wants.
 *
 * One threshold decides what is formatted at all, and a filter per destination
 * decides where it goes. `ROOST_LOG` raises the terminal's level; the file is
 * always at debug, because it is read *after* the thing it would explain. The
 * engine installs the same pair for itself — it is a separate process, and a
 * sink is a binary's job.
 */
const requested = process.env["ROOST_LOG"] ?? "";
const terminalLevel: LogLevel = isLogLevel(requested) ? requested : "warn";
const logFile: ClosableSink = fileSink();
setLogLevel("debug");
setSink(teeSink(logFile, filterSink(terminalLevel, stderrSink())));

const log = logger("main");

/** Channel names. One for calls, one for what the engine says unprompted. */
const REQUEST_CHANNEL = "roost:request";
const EVENT_CHANNEL = "roost:event";

/**
 * Serves `roost://`, and must be told which library to serve.
 *
 * The scheme has to be declared before the app is ready — after that, Chromium
 * has already decided what `roost:` is — so this happens at module scope rather
 * than inside `whenReady`.
 */
const assets = new AssetServer();
protocol.registerSchemesAsPrivileged([
  { scheme: ROOST_SCHEME, privileges: { ...ROOST_SCHEME_PRIVILEGES } },
]);

/**
 * A second launch raises the first window rather than opening a second one.
 *
 * Two windows would each mint folder ids from their own view of the index, and
 * the journal — the source of truth — would carry both (`library.ts`). The
 * engine's exclusive lock would refuse the second one anyway; this makes the
 * refusal a raised window instead of an error dialog.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const engine = new Engine(broadcast);

  app.on("second-instance", () => {
    const [existing] = BrowserWindow.getAllWindows();
    if (existing === undefined) return;
    if (existing.isMinimized()) existing.restore();
    existing.focus();
  });

  app.whenReady().then(() => {
    // Started before the window rather than after: its cost then overlaps
    // Chromium's, which is the only part of cold start this can influence
    // (ADR-0006).
    engine.start();
    protocol.handle(ROOST_SCHEME, (request) => assets.handle(request));
    ipcMain.handle(REQUEST_CHANNEL, (_source, payload: unknown) => route(engine, payload));
    // Before the first window: Electron installs its default menu when one is
    // created, and replacing it afterwards would flash the menu it replaces.
    installApplicationMenu();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }, fatal);

  app.on("window-all-closed", () => {
    // The engine holds the library's lock and its buffered journal, so it is
    // stopped before the process leaves — not left to be killed.
    engine.stop();
    // The read-only connection is main's, not the engine's, so stopping the
    // engine does not close it.
    assets.detach();
    if (process.platform !== "darwin") app.quit();
  });

  // The log file holds a descriptor, and JavaScript has no destructor — the
  // fourth place in this codebase where that becomes part of an API.
  app.on("will-quit", () => logFile.close());
}

/**
 * Validates one request from the renderer, then forwards it.
 *
 * The renderer is the process this build assumes may be compromised, so what
 * arrives here is checked before it goes anywhere near the engine — and checked
 * again by the engine, which is the boundary that matters.
 */
async function route(engine: Engine, payload: unknown): Promise<unknown> {
  const checked = checkRequest(payload);
  if (!checked.ok) {
    log.warn("rejected a request from the renderer", { reason: checked.reason });
    // The renderer gets a code and nothing else. A validation reason names
    // engine internals, and that is the half of this it must not learn.
    return { ok: false, problem: { code: "remote", message: "invalid request", detail: {} } };
  }

  const request: Request = checked.value;
  // Which requests a window made, and in what order, is the first thing anyone
  // debugging this path wants. The payload is not logged: it holds paths.
  log.debug("request", { type: request.type });
  try {
    if (ANSWERED_HERE.has(request.type)) {
      return { ok: true, value: await answerHere(engine, request) };
    }
    const value = await engine.request(request);
    followLibrary(request, value);
    return { ok: true, value };
  } catch (error) {
    if (error instanceof EngineProblem || error instanceof EngineGoneError) {
      return { ok: false, problem: error.problem };
    }
    log.error("request failed in main", { request: request.type });
    return { ok: false, problem: { code: "remote", message: "request failed", detail: {} } };
  }
}

/**
 * Keeps the byte server pointed at whichever library the engine just opened.
 *
 * Main learns this from the engine's *reply* rather than from an event, because
 * the reply is what carries the root and because the ordering then needs no
 * thought: the renderer cannot have asked for a thumbnail before it knows a
 * library is open, and it knows that from this same reply.
 */
function followLibrary(request: Request, value: unknown): void {
  if (request.type === "library:close") {
    assets.detach();
    return;
  }
  if (request.type !== "library:open" && request.type !== "library:create") return;

  const root = isSummary(value) ? value.root : undefined;
  if (root === undefined) return;
  try {
    assets.attach(root);
  } catch (error) {
    // A library the engine opened but whose index main cannot read is a broken
    // library, not a broken request. The window works; thumbnails 404.
    log.error("could not open the index for serving bytes", {
      message: error instanceof Error ? error.message : "unknown",
    });
  }
}

function isSummary(value: unknown): value is { root: string } {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "root") === "string"
  );
}

/**
 * The requests main answers itself.
 *
 * A dialog belongs to a window and the engine has none, so these cannot be
 * forwarded. They are still requests rather than a second channel, because the
 * renderer having exactly one way to ask for anything is worth more than the
 * tidiness of main holding no handlers at all.
 */
const ANSWERED_HERE: ReadonlySet<RequestType> = new Set([
  "dialog:openLibrary",
  "dialog:chooseLocation",
  "dialog:chooseImport",
  "dialog:chooseSubtitle",
  "dialog:chooseEagle",
  "asset:openExternally",
  "asset:reveal",
  "asset:copyPath",
  "asset:copyFiles",
  "clipboard:paste",
  "clipboard:copyText",
  "link:open",
  // The window has no menu bar on Linux or Windows (ADR-0028), so Quit arrives
  // as a request like everything else the renderer can ask for.
  "app:quit",
  "app:about",
]);

async function answerHere(
  engine: Engine,
  request: Request,
): Promise<string | number | boolean | readonly string[] | WirePasted | WireAbout | null> {
  if (request.type === "asset:openExternally") return openExternally(request.id);
  if (request.type === "asset:reveal") return reveal(request.id);
  if (request.type === "asset:copyPath") return copyPaths(request.ids);
  if (request.type === "asset:copyFiles") return copyFiles(request.ids);
  if (request.type === "clipboard:paste") return paste(engine, request.take);
  if (request.type === "clipboard:copyText") {
    clipboard.writeText(request.text);
    return true;
  }
  if (request.type === "link:open") return openLink(request.url);
  if (request.type === "app:about") return about();
  if (request.type === "app:quit") {
    // `quit` rather than `exit`: it closes the window, and closing the window is
    // what stops the engine, flushes the journal, and releases the lock.
    app.quit();
    return null;
  }
  if (request.type === "dialog:chooseImport") return chooseImport(request.what);
  if (request.type === "dialog:chooseSubtitle") return chooseSubtitle();
  if (request.type === "dialog:chooseEagle") return chooseEagle();

  const forOpening = request.type === "dialog:openLibrary";

  const options = {
    title: forOpening ? "Open library" : "Choose a location",
    buttonLabel: forOpening ? "Open" : "Choose",
    // `createDirectory` only where a new library is going: on the open side it
    // offers to make a folder that could not be a library yet.
    properties: forOpening
      ? (["openDirectory"] as const)
      : (["openDirectory", "createDirectory"] as const),
    defaultPath: app.getPath("pictures"),
  };

  // Attached to the window, so it is modal to Roost rather than to the desktop.
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const chosen =
    parent === undefined
      ? await dialog.showOpenDialog({ ...options, properties: [...options.properties] })
      : await dialog.showOpenDialog(parent, { ...options, properties: [...options.properties] });

  // Cancelling is an outcome, not a failure: the renderer shows what it had.
  if (chosen.canceled) return null;
  return chosen.filePaths[0] ?? null;
}

/**
 * What to import: either files or folders, never one dialog offering both.
 *
 * It was both at once — `openFile` and `openDirectory` together — on the
 * reasoning that "import this folder and those three loose files" is one
 * gesture. It is not one *dialog*: given both properties, GTK, macOS and
 * Windows all draw the file chooser and merely permit a directory to be
 * selected in it, so picking a folder meant navigating to its **parent** and
 * clicking it there — the one view that does not show what is inside it. The
 * `Add` menu asks which was meant first (`UI_SPEC.md` §1), which costs a menu
 * item and buys a chooser that behaves.
 *
 * Multi-selection either way: three folders is as ordinary as three files.
 */
async function chooseImport(what: ImportSubject): Promise<readonly string[] | null> {
  const folders = what === "folders";
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const options = {
    title: folders ? "Import folder" : "Import files",
    buttonLabel: "Import",
    properties: folders
      ? (["openDirectory", "multiSelections"] as const)
      : (["openFile", "multiSelections"] as const),
    defaultPath: app.getPath("pictures"),
  };

  const chosen =
    parent === undefined
      ? await dialog.showOpenDialog({ ...options, properties: [...options.properties] })
      : await dialog.showOpenDialog(parent, { ...options, properties: [...options.properties] });

  // Cancelling is an outcome, not a failure.
  return chosen.canceled || chosen.filePaths.length === 0 ? null : chosen.filePaths;
}

/**
 * The chooser for **Add subtitle…** (ADR-0025).
 *
 * Files only, and filtered. {@link chooseImport} offers folders because
 * importing a folder is the ordinary gesture; attaching a caption track is not,
 * and a chooser that lets somebody pick a directory for it is offering
 * something the caller has no use for.
 *
 * The filter is the same list the import heuristic looks for, from
 * `@roost/media` — two copies would eventually disagree about `.ssa`. "All
 * files" stays available underneath it, because a filter is a convenience and
 * refusing a correctly-named file nobody expected would not be.
 *
 * Opens in Downloads rather than Pictures: a subtitle almost always arrives
 * that way, and Pictures is where a library's assets come from.
 */
/**
 * The chooser for **Import from Eagle…** (ADR-0032).
 *
 * One directory, and only one: an Eagle library is a whole thing with a folder
 * tree and a tag vocabulary of its own, so two of them at once would raise
 * which tree the folders belong to. {@link chooseImport} takes several because
 * three folders of pictures is as ordinary as three pictures.
 *
 * `openDirectory` without `createDirectory`, since the answer has to be a
 * library that already exists, and no filter: `.library` is a directory rather
 * than an extension, and a chooser cannot filter on one.
 */
async function chooseEagle(): Promise<string | null> {
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const options = {
    title: "Choose an Eagle library",
    buttonLabel: "Choose",
    properties: ["openDirectory"] as const,
    defaultPath: app.getPath("pictures"),
  };

  const chosen =
    parent === undefined
      ? await dialog.showOpenDialog({ ...options, properties: [...options.properties] })
      : await dialog.showOpenDialog(parent, { ...options, properties: [...options.properties] });

  const [first] = chosen.filePaths;
  return chosen.canceled || first === undefined ? null : first;
}

async function chooseSubtitle(): Promise<readonly string[] | null> {
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const options = {
    title: "Add subtitle",
    buttonLabel: "Add",
    properties: ["openFile", "multiSelections"] as const,
    filters: [
      { name: "Subtitles", extensions: [...SUBTITLE_EXTENSIONS] },
      { name: "All files", extensions: ["*"] },
    ],
    defaultPath: app.getPath("downloads"),
  };

  const chosen =
    parent === undefined
      ? await dialog.showOpenDialog({ ...options, properties: [...options.properties] })
      : await dialog.showOpenDialog(parent, { ...options, properties: [...options.properties] });

  return chosen.canceled || chosen.filePaths.length === 0 ? null : chosen.filePaths;
}

/**
 * Hands an asset to whatever application the desktop associates with it.
 *
 * `shell.openPath` rather than `@roost/core`'s `openExternally`: that one
 * shells out to `xdg-open` and refuses on anything but Linux, which is right
 * for the CLI and wrong here — Electron already knows how to do this on three
 * platforms, and main is the process that has it.
 *
 * The path never reaches the renderer. It asks by hash and learns only whether
 * something opened.
 */
async function openExternally(id: string): Promise<boolean> {
  // Checked again here even though the contract already did: this is the value
  // that becomes a filesystem lookup, and it is one line.
  if (!isAssetId(id)) return false;
  const path = await assets.locate(id);
  if (path === undefined) return false;

  // `shell.openPath` resolves to "" on success and to a message on failure.
  const failure = await shell.openPath(path);
  if (failure !== "") log.warn("the desktop could not open an asset", { reason: failure });
  return failure === "";
}

/**
 * Hands a stored source URL to the desktop's browser (ADR-0030 §5).
 *
 * **`http:` and `https:` only.** The stored value is whatever the user typed
 * and Roost never argued with it, so it may be a bare hostname, a `file:` path,
 * or something that is not an address at all — and handing an arbitrary scheme
 * to the desktop's URL handler on a click is a way to run something the user
 * did not mean to run. `isHttpUrl` is the same test the clipboard uses, so the
 * two cannot drift apart about what a link is.
 *
 * **Nothing is fetched here**, which is why this does not touch invariant 7.
 * The browser that opens is the user's, with their session and their
 * extensions, and Roost learns nothing about what it found.
 */
async function openLink(url: string): Promise<boolean> {
  if (!isHttpUrl(url)) {
    log.warn("refused to open a source that is not an http(s) link", { url });
    return false;
  }
  await shell.openExternal(url);
  return true;
}

/**
 * What build this is (ADR-0038 §5.1).
 *
 * All four values are the shell's own: the two runtime versions come from
 * `process.versions`, which exists in main and deliberately does not in a
 * sandboxed renderer.
 *
 * **`isPackaged` guards the version, and it is not a nicety.** Run unpackaged,
 * `app.getVersion()` falls back to *Electron's* version — so the dialog said
 * "Version 43.4.1" the first time it was opened in a real window. An unpackaged
 * build has no version, and reporting none is what keeps a support email from
 * naming a release that was never cut.
 *
 * **The commit is only as good as what set it.** `ROOST_COMMIT` is handed in by
 * `scripts/dev.mjs` and by packaging; `electron .` by hand sets nothing, and a
 * made-up commit identifies the wrong build.
 */
function about(): WireAbout {
  const commit = process.env.ROOST_COMMIT?.trim();
  return {
    version: app.isPackaged ? app.getVersion() : null,
    commit: commit === undefined || commit === "" ? null : commit,
    electron: process.versions.electron,
    chromium: process.versions.chrome,
  };
}

/**
 * Shows an asset in the desktop's own file manager, selected.
 *
 * `shell.showItemInFolder` returns nothing and reports nothing, so the answer
 * is whether there was a file to show rather than whether a file manager
 * opened. Being honest about that is better than inventing a success.
 */
async function reveal(id: string): Promise<boolean> {
  if (!isAssetId(id)) return false;
  const path = await assets.locate(id);
  if (path === undefined) return false;
  shell.showItemInFolder(path);
  return true;
}

/**
 * Puts the selection's paths on the clipboard, one per line.
 *
 * The renderer never sees them. It asks by hash, main resolves each one, and
 * what comes back is a count-free boolean — so a path reaches the person who
 * asked for it without passing through the sandbox on the way (ADR-0008).
 *
 * Assets whose bytes are not on this machine are skipped rather than written as
 * a blank line: a clipboard with a hole in it is worse than a shorter one.
 */
async function copyPaths(idList: readonly string[]): Promise<boolean> {
  const paths: string[] = [];
  for (const id of idList) {
    if (!isAssetId(id)) continue;
    const path = await assets.locate(id);
    if (path !== undefined) paths.push(path);
  }
  if (paths.length === 0) return false;
  clipboard.writeText(paths.join("\n"));
  return true;
}

/**
 * Puts the selection on the clipboard as files (ADR-0034).
 *
 * **One format, chosen by the desktop that will read it.** Electron's clipboard
 * takes exactly one custom format at a time — `writeBuffer` clears what was
 * there, which was measured rather than assumed — and the two Linux desktops
 * disagree: GNOME's file managers paste from `x-special/gnome-copied-files`
 * and everything else reads `text/uri-list`. Roost's own paste handler below
 * reads both, which is the same disagreement seen from the other side.
 *
 * `XDG_CURRENT_DESKTOP` is the signal, and where it says nothing the
 * standard format wins.
 */
async function copyFiles(idList: readonly string[]): Promise<number> {
  const ids = idList.filter(isAssetId);
  const files = await assets.stage(ids);
  if (files.length === 0) return 0;

  const uris = files.map((file) => pathToFileURL(file).href);
  if (GNOME_DESKTOPS.test(process.env["XDG_CURRENT_DESKTOP"] ?? "")) {
    // `copy` rather than `cut`: nothing here moves the library's own files.
    clipboard.writeBuffer("x-special/gnome-copied-files", Buffer.from(`copy\n${uris.join("\n")}`));
  } else {
    // CRLF, which is what the `text/uri-list` registration asks for.
    clipboard.writeBuffer("text/uri-list", Buffer.from(`${uris.join("\r\n")}\r\n`));
  }
  return files.length;
}

/** The desktops whose file managers paste from GNOME's own format. */
const GNOME_DESKTOPS = /gnome|cinnamon|mate|unity|budgie|pantheon/i;

/**
 * What the clipboard holds, and what that deserves (ADR-0026 §5).
 *
 * Four shapes wearing one name, and main is where they are told apart: the
 * clipboard is the desktop's, the renderer has no ambient authority
 * (invariant 11), and the engine has no shell.
 *
 * **A link is not fetched.** Invariant 7 permits exactly one network
 * operation — an explicit, user-initiated import from a URL — and a fetch
 * triggered by `Ctrl+V` is what that rule exists to forbid. It comes back as a
 * URL and the window says so.
 *
 * An image is written to a temp file and imported from there, because an
 * import takes a path and because bytes do not travel to the engine either
 * (invariant 12). The temp file is ours and is removed once the import has read
 * it — originals are never moved or deleted, and this was never one.
 */
async function paste(engine: Engine, take: Take): Promise<WirePasted> {
  const paths = pathsFromUriList(
    clipboard.read("text/uri-list") || clipboard.read("x-special/gnome-copied-files"),
  );
  if (paths.length > 0) return importVia(engine, paths, take);

  const image = clipboard.readImage();
  if (!image.isEmpty()) {
    // PNG, because it is lossless and because the clipboard's own bitmap has no
    // format to preserve. The name is invented — `assets.name` is NOT NULL and
    // there is no name to be had — and it sorts, which a random one would not.
    const temp = join(tmpdir(), pastedName(new Date(), "png"));
    await writeFile(temp, image.toPNG());
    try {
      // Copied rather than moved: the temporary file is this function's own
      // and is deleted below either way, so the distinction is about what the
      // importer reports (RL-26) rather than about the file.
      return await importVia(engine, [temp], "copy");
    } finally {
      await rm(temp, { force: true });
    }
  }

  const text = clipboard.readText().trim();
  if (text === "") return { kind: "empty" };
  return isHttpUrl(text)
    ? { kind: "url", url: text }
    : { kind: "text", text: clipboard.readText() };
}

async function importVia(
  engine: Engine,
  paths: readonly string[],
  take: Take,
): Promise<WirePasted> {
  // No folder: a paste is ADR-0026's gesture rather than ADR-0037's, and half
  // of what it can carry — text, a URL — is not a file at all.
  const report = await engine.request({
    type: "import:paths",
    paths,
    take,
    tags: [],
    folder: null,
  });
  return { kind: "imported", report: report as WireImportReport };
}

/** Re-emits an engine event to every open window. */
function broadcast(event: Event): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(EVENT_CHANNEL, { event });
  }
}

function fatal(error: unknown): void {
  log.error("main failed to start", {
    message: error instanceof Error ? error.message : "unknown",
  });
  app.quit();
}
