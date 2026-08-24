import { describe, expect, it } from "vitest";
import { collectTokens, findUndeclaredTokens, stripComments } from "./check-css-tokens.mjs";

describe("findUndeclaredTokens", () => {
  it("passes when every token used is declared", () => {
    const css = ":root { --surface: #111; } .pane { background: var(--surface); }";
    expect(findUndeclaredTokens(css)).toEqual([]);
  });

  it("catches the bug this check exists for", () => {
    // The real one: the palette declares --surface, the pane asked for --bg,
    // and the pane rendered with no background at all while covering the grid.
    const css = ":root { --surface: #111; } .preview { background: var(--bg); }";
    expect(findUndeclaredTokens(css)).toEqual(["--bg"]);
  });

  it("reports a token used with a fallback, which hides the symptom", () => {
    expect(findUndeclaredTokens(".x { gap: var(--space-3, 12px); }")).toEqual(["--space-3"]);
  });

  it("tolerates whitespace inside var()", () => {
    const css = ":root{--a:1px}.x{margin:var( --a )}";
    expect(findUndeclaredTokens(css)).toEqual([]);
  });

  it("reports each undeclared token once, sorted", () => {
    const css = ".x { color: var(--z); border-color: var(--z); outline-color: var(--a); }";
    expect(findUndeclaredTokens(css)).toEqual(["--a", "--z"]);
  });
});

describe("stripComments", () => {
  it("removes comments before anything is scanned", () => {
    // Without this, the comment explaining a token bug reports itself.
    const css = "/* --bg was a typo for --surface */ :root { --surface: #111; }";
    expect(findUndeclaredTokens(`${css} .x { background: var(--surface); }`)).toEqual([]);
    expect(stripComments(css)).not.toContain("--bg");
  });

  it("does not let a commented-out declaration satisfy a real usage", () => {
    const css = "/* --surface: #111; */ .x { background: var(--surface); }";
    expect(findUndeclaredTokens(css)).toEqual(["--surface"]);
  });

  it("handles a multi-line comment containing a closing brace", () => {
    const css = "/*\n .old { color: var(--gone); }\n*/ :root { --a: 1px; } .x { top: var(--a); }";
    expect(collectTokens(css).used).toEqual(new Set(["--a"]));
  });
});
