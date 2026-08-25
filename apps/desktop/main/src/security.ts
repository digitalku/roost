/**
 * The sandbox, as values rather than as a review comment.
 *
 * `ARCHITECTURE.md` invariant 11 is a list of settings, and settings drift.
 * Everything here is a constant or a pure function so that the policy can be
 * asserted by a test instead of read in a diff — `TODO.md` §M3 asks for exactly
 * that, and `roost-old` shipped a window whose hardening nobody had exercised.
 */

/** Where the renderer's own pages come from in a packaged build. */
export const APP_ORIGIN = "file://";

/**
 * The renderer's privileges, in full.
 *
 * Spelled out rather than left to Electron's defaults, including the ones that
 * are already the default: a default that changes in a major version is a
 * silent loss of hardening, and this file is where that would be caught.
 */
export interface RendererPrivileges {
  readonly contextIsolation: boolean;
  readonly nodeIntegration: boolean;
  readonly nodeIntegrationInWorker: boolean;
  readonly nodeIntegrationInSubFrames: boolean;
  readonly sandbox: boolean;
  readonly webSecurity: boolean;
  readonly allowRunningInsecureContent: boolean;
  readonly experimentalFeatures: boolean;
  readonly webviewTag: boolean;
}

export const RENDERER_PRIVILEGES: RendererPrivileges = {
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
};

/**
 * The Content-Security-Policy header served to the renderer.
 *
 * `roost:` appears in `img-src` and `media-src` and nowhere else, which is
 * ADR-0008's rule: the protocol serves bytes to `<img>` and `<video>`, and a
 * script or a stylesheet arriving over it would be a different feature nobody
 * asked for.
 *
 * There is no `connect-src` beyond `'self'` and no `font-src` beyond `'self'`,
 * because invariant 7 says there is no network at run time — no fonts, no
 * analytics, no CDN. A page that tries is a bug, and this is what makes it a
 * visible one.
 *
 * In development the Vite dev server needs to be reachable and its HMR client
 * needs a WebSocket, so `devServer` widens exactly those two directives and
 * nothing else. It is never passed in a packaged build.
 */
export function contentSecurityPolicy(devServer?: string): string {
  const dev = devServer === undefined ? "" : ` ${devServer}`;
  const socket = devServer === undefined ? "" : ` ${devServer.replace(/^http/, "ws")}`;

  return [
    "default-src 'none'",
    `script-src 'self'${dev}`,
    // `'unsafe-inline'` for styles only, and only because a React app sets
    // inline styles for virtualization geometry. Scripts get no such allowance.
    `style-src 'self' 'unsafe-inline'${dev}`,
    "img-src 'self' roost: data: blob:",
    "media-src 'self' roost: blob:",
    "font-src 'self'",
    `connect-src 'self'${dev}${socket}`,
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'self' blob:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/**
 * Whether the window may navigate to `url`.
 *
 * Only the app's own pages. A link to anywhere else opens in the user's browser
 * or not at all, and in-page navigation to a remote origin is how a renderer
 * compromise becomes a persistent one.
 */
export function isAllowedNavigation(url: string, rendererUrl: string): boolean {
  let target: URL;
  let allowed: URL;
  try {
    target = new URL(url);
    allowed = new URL(rendererUrl);
  } catch {
    return false;
  }

  if (target.protocol === "file:" && allowed.protocol === "file:") {
    // A packaged build serves one directory. Anything reachable by climbing out
    // of it — `../../etc/passwd` — is not a page of this app.
    return target.pathname.startsWith(dirOf(allowed.pathname));
  }

  return target.origin === allowed.origin;
}

function dirOf(pathname: string): string {
  const cut = pathname.lastIndexOf("/");
  return cut <= 0 ? "/" : pathname.slice(0, cut + 1);
}
