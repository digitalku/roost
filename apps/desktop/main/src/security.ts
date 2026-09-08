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

/** The scheme that serves asset bytes (ADR-0008). */
export const ROOST_SCHEME = "roost";

/**
 * How `roost:` is registered, spelled out for the same reason the renderer's
 * privileges are.
 *
 * `standard` gives the scheme an origin, which is what lets `thumb` and
 * `original` parse as hosts and what CSP's `roost:` source matches. `stream` is
 * what makes a `<video>` issue range requests instead of asking for the whole
 * file — without it, ADR-0008's reason for streaming originals does not apply.
 * `secure` keeps the renderer from treating asset bytes as mixed content.
 *
 * `supportFetchAPI` stays **off**. The CSP lists `roost:` in `img-src` and
 * `media-src` and nowhere else, so a page fetching asset bytes as data is a
 * feature nobody asked for; leaving it off means the two documents agree rather
 * than merely not contradicting each other.
 *
 * `corsEnabled` is **on**, and it is on for one reason: a `<track>` is fetched
 * with CORS or not at all (ADR-0025). Every other consumer of this scheme is a
 * no-cors load, but a caption track's cues are read by the page, so the media
 * element carries `crossorigin` and the response carries
 * `access-control-allow-origin` — and a scheme that is not CORS-enabled fails
 * that check before the header is ever looked at. It was off until 2026-09-08,
 * when a chosen `.srt` turned out never to reach the element: the track ends at
 * `readyState 3` with no cues and no error anywhere. Same-origin was never an
 * option — the window is `file://` packaged and `http://localhost` in dev, and
 * this scheme's origin is its host.
 */
export interface SchemePrivileges {
  readonly standard: boolean;
  readonly secure: boolean;
  readonly stream: boolean;
  readonly supportFetchAPI: boolean;
  readonly corsEnabled: boolean;
  readonly bypassCSP: boolean;
  readonly allowServiceWorkers: boolean;
}

export const ROOST_SCHEME_PRIVILEGES: SchemePrivileges = {
  standard: true,
  secure: true,
  stream: true,
  supportFetchAPI: false,
  corsEnabled: true,
  bypassCSP: false,
  allowServiceWorkers: false,
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
 * In development the Vite dev server needs to be reachable, its HMR client needs
 * a WebSocket, and React Fast Refresh injects an inline preamble — so
 * `devServer` widens `script-src`, `style-src`, and `connect-src`, and nothing
 * else. It is never passed in a packaged build.
 *
 * **`'unsafe-eval'` is never allowed, in either build.** `'unsafe-inline'` for
 * scripts is a development-only concession to the preamble, and the price is
 * that an inline script would work in `pnpm dev` and fail in the packaged app.
 * React emits none, so the risk is theoretical — but `TODO.md` records it,
 * because "works in dev" is exactly the shape of bug this project keeps finding.
 */
export function contentSecurityPolicy(devServer?: string): string {
  const dev = devServer === undefined ? "" : ` ${devServer}`;
  const socket = devServer === undefined ? "" : ` ${devServer.replace(/^http/, "ws")}`;

  // Fast Refresh's preamble is an inline module script, and Vite has no way to
  // serve it as a file. Development only, and never `'unsafe-eval'`.
  const inlineScript = devServer === undefined ? "" : " 'unsafe-inline'";

  return [
    "default-src 'none'",
    `script-src 'self'${inlineScript}${dev}`,
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
