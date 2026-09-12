import { describe, expect, it } from "vitest";
import { isHttpUrl, pastedName, pathsFromUriList } from "./clipboard.js";

describe("reading file paths off the clipboard", () => {
  // What a URI list holds is a *path*, and the spelling of one is the
  // platform's: `file:///home/one/a.png` names nothing Windows can open, and
  // `fileURLToPath` refuses it rather than inventing a drive. None of the rules
  // under test are the platform's — comments, GNOME's operation line, the
  // percent-decoding, the root — so the data moves and the assertions do not.
  const onWindows = process.platform === "win32";
  const dir = onWindows ? "file:///C:/one" : "file:///home/one";
  const at = (name: string) => (onWindows ? `C:\\one\\${name}` : `/home/one/${name}`);

  it("reads the standard list, comments and all", () => {
    const list = `# from a file manager\n${dir}/a.png\n${dir}/b.png\n`;
    expect(pathsFromUriList(list)).toEqual([at("a.png"), at("b.png")]);
  });

  it("skips GNOME's operation line, which is not a file", () => {
    // `x-special/gnome-copied-files` starts with `copy` or `cut`. A parser that
    // took every line would import a file called "copy".
    expect(pathsFromUriList(`copy\n${dir}/a.png`)).toEqual([at("a.png")]);
    expect(pathsFromUriList(`cut\n${dir}/a.png`)).toEqual([at("a.png")]);
  });

  it("decodes what a URI escaped", () => {
    expect(pathsFromUriList(`${dir}/two%20words.png`)).toEqual([at("two words.png")]);
  });

  it("drops anything that is not a file, rather than guessing", () => {
    // A link on the clipboard is a link. Nothing here fetches one (invariant 7).
    expect(pathsFromUriList("https://example.com/a.png")).toEqual([]);
    expect(pathsFromUriList("")).toEqual([]);
    expect(pathsFromUriList("/home/one/a.png")).toEqual([]);
  });

  it("skips one unreadable URI rather than failing the paste", () => {
    expect(pathsFromUriList(`file:\n${dir}/a.png`)).toEqual([at("a.png")]);
  });

  it("refuses the root, which an empty file URI resolves to", () => {
    // `file://` parses cleanly and yields `/`. Importing it is a walk of the
    // whole filesystem — never what a paste meant, and far too expensive to
    // find out by trying. Found by a test rather than by a user.
    //
    // Refused by two different routes, which is worth knowing: the check in the
    // parser answers for a POSIX root, and on Windows the same input never
    // reaches it because a rootless `file:` URL has no drive to name.
    expect(pathsFromUriList(`file://\n${dir}/a.png`)).toEqual([at("a.png")]);
    expect(pathsFromUriList("file:///")).toEqual([]);
  });
});

describe("telling a link from words", () => {
  it("recognises the two schemes an import could ever fetch", () => {
    expect(isHttpUrl("https://example.com/a.png")).toBe(true);
    expect(isHttpUrl("http://example.com")).toBe(true);
  });

  it("treats a sentence with a URL in it as a sentence", () => {
    expect(isHttpUrl("see https://example.com for more")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
    expect(isHttpUrl("notes about the release")).toBe(false);
  });

  it("does not treat every scheme as fetchable", () => {
    // `file:` is a path, and pasting one is the other branch entirely.
    expect(isHttpUrl("file:///home/one/a.png")).toBe(false);
    expect(isHttpUrl("mailto:someone@example.com")).toBe(false);
  });
});

describe("naming what the clipboard had no name for", () => {
  it("sorts, and holds nothing a filesystem minds", () => {
    const name = pastedName(new Date(2026, 8, 4, 14, 22, 8), "png");
    expect(name).toBe("Pasted 2026-09-04 14.22.08.png");
    expect(name).not.toMatch(/[/\\:*?"<>|]/);
  });
});
