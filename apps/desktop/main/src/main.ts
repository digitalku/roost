import type { Event, Request, RequestType } from "@roost/contract";
import { checkRequest } from "@roost/contract";
import {
  type ClosableSink,
  fileSink,
  filterSink,
  isContentHash,
  isLogLevel,
  type LogLevel,
  logger,
  setLogLevel,
  setSink,
  stderrSink,
  teeSink,
} from "@roost/core";
import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from "electron";
import { AssetServer } from "./assets.js";
import { Engine, EngineGoneError, EngineProblem } from "./engine.js";
import { ROOST_SCHEME, ROOST_SCHEME_PRIVILEGES } from "./security.js";
import { createWindow } from "./window.js";

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
      return { ok: true, value: await answerHere(request) };
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
  "asset:openExternally",
]);

async function answerHere(request: Request): Promise<string | boolean | null> {
  if (request.type === "asset:openExternally") return openExternally(request.hash);

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
async function openExternally(hash: string): Promise<boolean> {
  // Checked again here even though the contract already did: this is the value
  // that becomes a filesystem lookup, and it is one line.
  if (!isContentHash(hash)) return false;
  const path = await assets.locate(hash);
  if (path === undefined) return false;

  // `shell.openPath` resolves to "" on success and to a message on failure.
  const failure = await shell.openPath(path);
  if (failure !== "") log.warn("the desktop could not open an asset", { reason: failure });
  return failure === "";
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
