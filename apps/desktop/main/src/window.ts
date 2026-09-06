import { fileURLToPath } from "node:url";
import { logger } from "@roost/core";
import { app, BrowserWindow, Menu, shell } from "electron";
import { contentSecurityPolicy, isAllowedNavigation, RENDERER_PRIVILEGES } from "./security.js";

/**
 * The window, and every privilege it is denied.
 *
 * The settings live in `security.ts` as values so that a test can assert them;
 * this file is what applies them, and it must not restate any of them inline.
 */

const log = logger("main");

const PRELOAD = fileURLToPath(new URL("../../preload/dist/preload.js", import.meta.url));

/**
 * What the desktop draws for this window (`assets/brand/`).
 *
 * A PNG, because that is what Linux and Windows take here; macOS ignores it and
 * uses the bundle's own icon. Drawn from `roost-icon.svg` by
 * `scripts/build-brand.mjs` and committed, because the window opens before any
 * build step could produce one. **Packaging has to carry `assets/brand/`** —
 * this path is relative to the built `main/dist`, and a packaged app that left
 * the directory behind would open with Electron's default icon (M6).
 */
const ICON = fileURLToPath(new URL("../../../../assets/brand/icon-512.png", import.meta.url));

/** Where the renderer's pages come from: the dev server, or the built bundle. */
export function rendererUrl(): string {
  const devServer = process.env["ROOST_DEV_SERVER"];
  if (devServer !== undefined && devServer !== "") return new URL("/", devServer).href;
  return new URL("../../renderer/dist/index.html", import.meta.url).href;
}

/**
 * Removes Electron's default menu bar (ADR-0028).
 *
 * Nothing here ever set one, so Electron installed its own: File · Edit · View
 * · Window, carrying a Reload that throws away the window's state, a devtools
 * toggle, and a Paste that means something else than Roost's does (ADR-0026
 * §5). The application's own commands live in a button in the toolbar instead.
 *
 * **macOS keeps it**, because there the menu bar belongs to the system rather
 * than to the window: an application without one is a bug on that platform, and
 * `Cmd+C`, `Cmd+V` and `Cmd+Q` come from those roles rather than from Chromium.
 * This condition is the whole of the split.
 */
export function installApplicationMenu(): void {
  if (process.platform === "darwin") return;
  Menu.setApplicationMenu(null);
}

export function createWindow(): BrowserWindow {
  const url = rendererUrl();

  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    // The window is shown once the renderer has painted, so start-up is a blank
    // moment rather than a white flash followed by a layout.
    show: false,
    backgroundColor: "#14110f",
    icon: ICON,
    webPreferences: { ...RENDERER_PRIVILEGES, preload: PRELOAD },
  });

  window.once("ready-to-show", () => window.show());
  harden(window, url);
  quitOn(window);
  void window.loadURL(url);
  return window;
}

/**
 * `Ctrl+Q`, which left with the menu that used to carry it (ADR-0028).
 *
 * A menu item is not an accelerator: without this, Quit would be a command only
 * the mouse could reach, on a platform where `Ctrl+Q` is what people press. It
 * is bound to the window rather than registered with `globalShortcut`, which
 * would take the combination away from every other application for as long as
 * Roost is running.
 *
 * Not on macOS, where `Cmd+Q` is the system's and comes from the menu bar.
 */
function quitOn(window: BrowserWindow): void {
  if (process.platform === "darwin") return;

  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key.toLowerCase() !== "q") return;
    if (!input.control || input.alt || input.meta || input.shift) return;
    event.preventDefault();
    app.quit();
  });
}

/**
 * Applies the parts of the policy that are behaviour rather than configuration.
 *
 * `webPreferences` covers what the renderer *is*; this covers what it may *do*:
 * where it may navigate, what it may open, and which headers it is served.
 */
function harden(window: BrowserWindow, url: string): void {
  const policy = contentSecurityPolicy(process.env["ROOST_DEV_SERVER"]);

  window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        // Set here rather than in a meta tag, so it also covers the dev server
        // and cannot be edited out of a page.
        "Content-Security-Policy": [policy],
      },
    });
  });

  window.webContents.on("will-navigate", (event, target) => {
    if (isAllowedNavigation(target, url)) return;
    event.preventDefault();
    log.warn("navigation denied", { target });
  });

  // A link to anywhere else opens in the user's own browser, which is the one
  // place a remote page is allowed to be. Never a second Electron window.
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith("https://")) void shell.openExternal(target);
    else log.warn("window.open denied", { target });
    return { action: "deny" };
  });

  window.webContents.on("will-attach-webview", (event) => {
    // `webviewTag` is already false. This is the second lock on the same door,
    // because the first one is a setting and settings drift.
    event.preventDefault();
  });
}
