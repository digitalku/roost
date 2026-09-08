import { describe, expect, it } from "vitest";
import {
  contentSecurityPolicy,
  isAllowedNavigation,
  RENDERER_PRIVILEGES,
  ROOST_SCHEME,
  ROOST_SCHEME_PRIVILEGES,
} from "./security.js";

describe("the renderer's privileges", () => {
  it("grants none of them", () => {
    // Invariant 11, as an assertion rather than as a setting somebody reviewed
    // once. Every field is listed, including the ones that are already
    // Electron's default: a default that changes in a major version is a silent
    // loss of hardening, and this is where that gets caught.
    expect(RENDERER_PRIVILEGES).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
    });
  });
});

describe("the content security policy", () => {
  const directives = (policy: string): Map<string, string> =>
    new Map(
      policy.split("; ").map((directive) => {
        const cut = directive.indexOf(" ");
        return cut === -1 ? [directive, ""] : [directive.slice(0, cut), directive.slice(cut + 1)];
      }),
    );

  it("serves bytes over roost: to images and media, and to nothing else", () => {
    // ADR-0008's rule. A script or a stylesheet arriving over the protocol
    // would be a different feature, and one nobody asked for.
    const found = directives(contentSecurityPolicy());
    expect(found.get("img-src")).toContain("roost:");
    expect(found.get("media-src")).toContain("roost:");

    for (const [name, value] of found) {
      if (name === "img-src" || name === "media-src") continue;
      expect({ name, value }).toEqual({ name, value: expect.not.stringContaining("roost:") });
    }
  });

  it("allows no network at all in a packaged build", () => {
    // Invariant 7: no fonts, no analytics, no update check, no CDN. A page that
    // tries is a bug, and a policy that permitted it would hide one.
    const policy = contentSecurityPolicy();
    expect(policy).not.toMatch(/https?:/);
    expect(directives(policy).get("connect-src")).toBe("'self'");
    expect(directives(policy).get("font-src")).toBe("'self'");
    expect(directives(policy).get("default-src")).toBe("'none'");
  });

  it("never allows evaluated script, and never allows inline script in a packaged build", () => {
    // `'unsafe-eval'` is refused in both builds: nothing here needs it, and a
    // policy that permits it is not a policy.
    for (const policy of [
      contentSecurityPolicy(),
      contentSecurityPolicy("http://localhost:5173"),
    ]) {
      expect(directives(policy).get("script-src")).not.toContain("unsafe-eval");
    }

    // Inline script is a development-only concession to React Fast Refresh's
    // preamble, which Vite has no way to serve as a file. The build a user runs
    // does not get it, so that is the assertion which has to hold.
    expect(directives(contentSecurityPolicy()).get("script-src")).toBe("'self'");
    expect(directives(contentSecurityPolicy("http://x")).get("script-src")).toContain(
      "'unsafe-inline'",
    );
  });

  it("widens exactly three directives for the dev server", () => {
    const packaged = directives(contentSecurityPolicy());
    const dev = directives(contentSecurityPolicy("http://localhost:5173"));

    const widened = [...dev].filter(([name, value]) => packaged.get(name) !== value);
    expect(widened.map(([name]) => name).sort()).toEqual([
      "connect-src",
      "script-src",
      "style-src",
    ]);
    // HMR is a WebSocket, and it is the only reason the socket origin appears.
    expect(dev.get("connect-src")).toContain("ws://localhost:5173");
  });
});

describe("navigation", () => {
  it("allows the app's own pages and nothing else", () => {
    const dev = "http://localhost:5173/";
    expect(isAllowedNavigation("http://localhost:5173/index.html", dev)).toBe(true);
    expect(isAllowedNavigation("http://localhost:5174/index.html", dev)).toBe(false);
    expect(isAllowedNavigation("https://example.com/", dev)).toBe(false);
    expect(isAllowedNavigation("javascript:alert(1)", dev)).toBe(false);
  });

  it("refuses to climb out of a packaged build's directory", () => {
    const app = "file:///opt/roost/renderer/index.html";
    expect(isAllowedNavigation("file:///opt/roost/renderer/index.html", app)).toBe(true);
    expect(isAllowedNavigation("file:///opt/roost/renderer/about.html", app)).toBe(true);
    expect(isAllowedNavigation("file:///etc/passwd", app)).toBe(false);
    expect(isAllowedNavigation("file:///opt/roost/secrets.env", app)).toBe(false);
  });

  it("refuses anything that is not a URL at all", () => {
    expect(isAllowedNavigation("", "http://localhost:5173/")).toBe(false);
    expect(isAllowedNavigation("not a url", "http://localhost:5173/")).toBe(false);
  });
});

describe("how roost: is registered", () => {
  it("is standard, secure, streamed and CORS-enabled, and nothing more", () => {
    // `stream` is the one that carries ADR-0008's argument: without it a
    // `<video>` asks for the whole file and the streaming is wasted. `standard`
    // is what makes `thumb` and `original` parse as hosts and what CSP's
    // `roost:` source matches. `corsEnabled` is what lets a `<track>` load at
    // all (ADR-0025): a caption track is fetched with CORS or not at all, and
    // this scheme's origin is its host, so a subtitle is cross-origin to the
    // window however the window was loaded.
    expect(ROOST_SCHEME).toBe("roost");
    expect(ROOST_SCHEME_PRIVILEGES).toEqual({
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: false,
      corsEnabled: true,
      bypassCSP: false,
      allowServiceWorkers: false,
    });
  });

  it("is allowed by the policy exactly where the ADR says it is", () => {
    const policy = contentSecurityPolicy();
    const directives = policy.split("; ").filter((d) => d.includes("roost:"));
    // Bytes go to <img> and <video>. A script or a stylesheet arriving over
    // this scheme would be a feature nobody asked for, and `supportFetchAPI`
    // being off is the other half of the same statement.
    expect(directives.map((d) => d.split(" ")[0])).toEqual(["img-src", "media-src"]);
  });
});
