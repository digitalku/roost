/**
 * The sandbox, asserted against a **running window** rather than against the
 * values that were passed in.
 *
 * `apps/desktop/main/src/security.test.ts` checks that the right settings are
 * spelled out. That is worth having and it is not the same claim: a setting
 * Electron renamed, a header a session dropped, a policy the page overrode —
 * all of those pass a value test and fail here. `ARCHITECTURE.md` invariant 11
 * is what this file is for, and `ROADMAP.md` M3 does not accept until it passes.
 *
 *   node scripts/check-sandbox.mjs
 *
 * Exits non-zero on the first failure, so it can be a CI step. It needs
 * Electron's binary, which `ELECTRON_SKIP_BINARY_DOWNLOAD` suppresses.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { ledger } from "./lib/checks.mjs";
import { launch } from "./lib/window.mjs";

// No library: the subject is the window itself, and the picker is as good a
// document to serve a policy with as a grid is.
const window = await launch({ open: false });
const { cdp } = window;
const { check, section, report } = ledger();

/**
 * Each check is a page expression returning `{ ok, saw }`.
 *
 * Written as expressions rather than as a helper injected into the page,
 * because a helper would itself be an inline script and the policy under test
 * is the one that decides whether inline scripts run.
 */

/**
 * Each check is a page expression returning `{ ok, saw }`.
 *
 * Written as expressions rather than as a helper injected into the page,
 * because a helper would itself be an inline script and the policy under test
 * is the one that decides whether inline scripts run.
 */
const CHECKS = [
  {
    name: "no Node globals in the renderer",
    why: "nodeIntegration: false and sandbox: true, observed rather than configured",
    expression: `(() => {
      const leaked = ["require", "process", "module", "exports", "global", "Buffer", "__dirname"]
        .filter((name) => typeof globalThis[name] !== "undefined");
      return { ok: leaked.length === 0, saw: leaked.join(", ") || "none" };
    })()`,
  },
  {
    name: "the bridge is the only door",
    why: "contextIsolation: true — the preload's surface and nothing beside it",
    expression: `(() => {
      const keys = Object.keys(window.roost ?? {}).sort();
      const expected = ["invoke", "onEvent", "pathForFile"];
      return { ok: JSON.stringify(keys) === JSON.stringify(expected), saw: keys.join(",") };
    })()`,
  },
  {
    name: "a remote script is refused by the policy",
    why: "the CSP header was applied by Electron, not merely computed by us",
    expression: violation(
      "script",
      `(() => {
      const script = document.createElement("script");
      script.src = "https://example.invalid/x.js";
      document.head.append(script);
    })()`,
    ),
  },
  {
    name: "a remote image is refused by the policy",
    why: "img-src allows 'self', roost:, data: and blob: — and nothing remote",
    expression: violation(
      "img",
      `(() => {
      const image = document.createElement("img");
      image.src = "https://example.invalid/x.png";
      document.body.append(image);
    })()`,
    ),
  },
  {
    name: "a remote stylesheet is refused by the policy",
    why: "no webfont, no CDN — invariant 7 says there is no network at run time",
    expression: violation(
      "style",
      `(() => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://example.invalid/x.css";
      document.head.append(link);
    })()`,
    ),
  },
  {
    name: "window.open answers with nothing",
    why: "setWindowOpenHandler denies every request (window.ts)",
    expression: `(() => {
      const opened = window.open("https://example.invalid/", "_blank");
      return { ok: opened === null, saw: opened === null ? "null" : "a window" };
    })()`,
  },
  {
    name: "navigating away does not navigate away",
    why: "will-navigate is denied for anything but the app's own origin",
    expression: `(async () => {
      const before = location.href;
      try {
        location.href = "https://example.invalid/";
      } catch {
        // A throw is also a refusal.
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { ok: location.href === before, saw: location.href.slice(0, 40) };
    })()`,
  },
  {
    name: "webview has no webview in it",
    why: "webviewTag: false — a webview would be a renderer with its own rules",
    /*
     * Not the constructor name. Chromium knows the tag — `createElement`
     * returns `HTMLElement` for it and `HTMLUnknownElement` for a name it has
     * never heard of — so a name check passes on a build where the tag works
     * and fails on one where it does not. What `webviewTag: false` actually
     * withholds is the API, so that is what is checked.
     */
    expression: `(() => {
      const element = document.createElement("webview");
      const present = ["getWebContentsId", "loadURL", "reload", "goBack", "executeJavaScript"]
        .filter((member) => member in element);
      return { ok: present.length === 0, saw: present.join(", ") || "no webview API" };
    })()`,
  },
];

/**
 * The policy Electron actually served, as opposed to the one we computed.
 *
 * `eval` cannot be tested from here: DevTools is exempt from the page's CSP, so
 * a `new Function` evaluated over CDP runs whatever the header says — the first
 * version of this file reported that as a hole and it was the measurement. The
 * header itself is not exempt from anything, and the violation checks above
 * prove it is being enforced.
 */
const HEADER_CHECKS = [
  { name: "no 'unsafe-eval', in either build", absent: "unsafe-eval" },
  { name: "no inline script in a packaged build", absent: "script-src 'self' 'unsafe-inline'" },
  { name: "nothing is allowed by default", present: "default-src 'none'" },
  { name: "roost: serves images", present: "img-src 'self' roost: data: blob:" },
  { name: "roost: serves media", present: "media-src 'self' roost: blob:" },
  { name: "no remote font, no CDN (invariant 7)", present: "font-src 'self'" },
  { name: "no plugin, no frame", present: "object-src 'none'" },
  { name: "no base tag rewriting the origin", present: "base-uri 'none'" },
];

/**
 * Attempts something the policy should refuse, and resolves with whether the
 * page reported a violation for `directive`.
 *
 * `securitypolicyviolation` is the browser saying it enforced a header it
 * received — which is the difference between this and reading the header back
 * out of our own code.
 */
function violation(directive, attempt) {
  return `(() => new Promise((resolve) => {
    const seen = [];
    const listener = (event) => seen.push(event.violatedDirective);
    document.addEventListener("securitypolicyviolation", listener);
    ${attempt};
    setTimeout(() => {
      document.removeEventListener("securitypolicyviolation", listener);
      const hit = seen.some((d) => d.startsWith(${JSON.stringify(directive)}));
      resolve({ ok: hit, saw: seen.join(", ") || "no violation reported" });
    }, 600);
  }))()`;
}

/**
 * The `Content-Security-Policy` on the document's own response.
 *
 * Read off the network event rather than out of our source, which is the whole
 * point: a header a session dropped, or one another handler overwrote, is
 * invisible to a test of the function that computes it.
 */
async function documentPolicy() {
  const arrived = cdp.once(
    "Network.responseReceived",
    (params) => params.type === "Document",
    8000,
  );
  await cdp.evaluate("location.reload()").catch(() => {});
  const event = await arrived;
  if (event === undefined) return undefined;
  const headers = event.response.headers ?? {};
  const name = Object.keys(headers).find((key) => key.toLowerCase() === "content-security-policy");
  return name === undefined ? undefined : headers[name];
}

try {
  section("The policy Electron served with the document");
  const policy = await documentPolicy();
  if (policy === undefined) {
    check("a Content-Security-Policy header on the document at all", false);
  } else {
    for (const header of HEADER_CHECKS) {
      check(
        header.name,
        header.present !== undefined
          ? policy.includes(header.present)
          : !policy.includes(header.absent),
      );
    }
  }

  section("Sandbox, as the window actually behaves");
  // The reload above is still settling; a page expression evaluated into a
  // document being replaced throws, and that reads as a sandbox failure.
  await cdp.settle("document.readyState", (state) => state === "complete");
  await sleep(200);

  for (const claim of CHECKS) {
    let result;
    try {
      result = await cdp.evaluate(claim.expression);
    } catch (error) {
      result = { ok: false, saw: String(error).slice(0, 80) };
    }
    check(claim.name, result?.ok === true, result?.saw);
    if (result?.ok !== true) console.log(`        expected: ${claim.why}`);
  }

  report();
} catch (error) {
  console.error(error);
  console.error(window.noise().slice(-4000));
  process.exitCode = 2;
} finally {
  await window.close();
}
