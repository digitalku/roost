import { afterEach, describe, expect, it, vi } from "vitest";

const setApplicationMenu = vi.fn();

vi.mock("electron", () => ({
  app: { quit: vi.fn() },
  BrowserWindow: class {},
  Menu: { setApplicationMenu },
  shell: { openExternal: vi.fn() },
}));

const { installApplicationMenu } = await import("./window.js");

/** `process.platform` is read-only, and this is the only way to be two of them. */
function pretend(platform: string): () => void {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  return () => {
    if (original !== undefined) Object.defineProperty(process, "platform", original);
  };
}

describe("the application menu", () => {
  afterEach(() => setApplicationMenu.mockClear());

  it("is removed where the window owns its own chrome", () => {
    // ADR-0028. Electron's default menu carried a Reload that throws away the
    // query and the selection, a devtools toggle, and a Paste that means
    // something other than Roost's.
    const restore = pretend("linux");
    try {
      installApplicationMenu();
      expect(setApplicationMenu).toHaveBeenCalledWith(null);
    } finally {
      restore();
    }
  });

  it("is left alone on macOS, where the menu bar is the system's", () => {
    // An application with no menu bar is a bug on that platform, and Cmd+C,
    // Cmd+V and Cmd+Q come from those roles rather than from Chromium. This
    // condition is the whole of the split, which is why it has a test.
    const restore = pretend("darwin");
    try {
      installApplicationMenu();
      expect(setApplicationMenu).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
