import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, isAllowedNavigation, RENDERER_PRIVILEGES } from "./security.js";

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

  it("never allows inline or evaluated script, dev server or not", () => {
    for (const policy of [
      contentSecurityPolicy(),
      contentSecurityPolicy("http://localhost:5173"),
    ]) {
      expect(directives(policy).get("script-src")).not.toContain("unsafe-inline");
      expect(directives(policy).get("script-src")).not.toContain("unsafe-eval");
    }
  });

  it("widens exactly two directives for the dev server", () => {
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
