import { fileURLToPath } from "node:url";
import { logger } from "@roost/core";
import { BrowserWindow, shell } from "electron";
import { contentSecurityPolicy, isAllowedNavigation, RENDERER_PRIVILEGES } from "./security.js";

/**
 * The window, and every privilege it is denied.
 *
 * The settings live in `security.ts` as values so that a test can assert them;
 * this file is what applies them, and it must not restate any of them inline.
 */

const log = logger("main");

const PRELOAD = fileURLToPath(new URL("../../preload/dist/preload.js", import.meta.url));

/** Where the renderer's pages come from: the dev server, or the built bundle. */
export function rendererUrl(): string {
  const devServer = process.env["ROOST_DEV_SERVER"];
  if (devServer !== undefined && devServer !== "") return new URL("/", devServer).href;
  return new URL("../../renderer/dist/index.html", import.meta.url).href;
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
    webPreferences: { ...RENDERER_PRIVILEGES, preload: PRELOAD },
  });

  window.once("ready-to-show", () => window.show());
  harden(window, url);
  void window.loadURL(url);
  return window;
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
