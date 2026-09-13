import { describe, expect, it } from "vitest";
import { adoptUserPath, installBackend } from "./installer.js";

/**
 * Running a package manager, at the one edge that can be asserted without one.
 *
 * Nothing here installs anything: a unit test that reached the network to prove
 * a button works would be a slow, flaky check script. What *can* be pinned down
 * is the refusal — the guard that keeps a platform without an argv from
 * spawning whatever happened to be first in the array — and that the `PATH`
 * step is a no-op where there is no registry to read. The rest is
 * `scripts/check-install.mjs`, against a real window.
 */

describe("installing a backend", () => {
  it("refuses a backend nothing may be run for", async () => {
    // HEIC has no command Roost may run on any platform: winget ships no
    // `heif-dec` and every Linux line begins with `sudo` (ADR-0042 §3).
    await expect(installBackend("heif")).rejects.toThrow(/nothing may be run/);
  });

  it("leaves the PATH alone where there is no user PATH to read", async () => {
    const before = process.env["PATH"];
    await adoptUserPath();
    if (process.platform === "win32") {
      // Additive, so the entries that were there are still there and in order.
      expect(process.env["PATH"]?.startsWith(before ?? "")).toBe(true);
    } else {
      expect(process.env["PATH"]).toBe(before);
    }
  });
});
