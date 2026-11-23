import { EditorView } from "@codemirror/view";
import { render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SourceEditor } from "./SourceEditor.js";

/**
 * Markdown that edits as it looks (ADR-0070 §8), through the editor's own state:
 * happy-dom has no layout, so what is asserted is the document and the classes
 * and widgets the editor puts on it, which is what draws a heading large and a
 * dash as a bullet in a real window (`check-text.mjs`).
 */

const mount = (initial: string, markdown = true) => {
  const changed = vi.fn();
  const saved = vi.fn();
  const done = vi.fn();
  render(
    <SourceEditor
      initial={initial}
      markdown={markdown}
      label="Edit notes.md"
      caret={initial.length}
      onChange={changed}
      onSave={saved}
      onDone={done}
    />,
  );
  const dom = document.querySelector(".cm-editor");
  const view = dom instanceof HTMLElement ? EditorView.findFromDOM(dom) : null;
  if (view === null) throw new Error("no editor");
  return { view, changed, saved, done, user: userEvent.setup() };
};

describe("the text editor", () => {
  it("draws a heading's line large the moment it is one", async () => {
    const { view } = mount("title");
    expect(document.querySelector(".cm-md-h2")).toBeNull();
    view.dispatch({ changes: { from: 0, insert: "## " } });
    await waitFor(() => expect(document.querySelector(".cm-line.cm-md-h2")).not.toBeNull());
    // The marks stay in the text: what is drawn is what is saved.
    expect(view.state.doc.toString()).toBe("## title");
    expect(document.querySelector(".cm-md-mark")?.textContent).toBe("##");
  });

  it("draws a list's dash as a bullet, and keeps the dash in the file", async () => {
    const { view } = mount("- milk");
    await waitFor(() => expect(document.querySelector(".cm-md-bullet")?.textContent).toBe("•"));
    expect(view.state.doc.toString()).toBe("- milk");
  });

  it("continues a list on Enter, and ends it on Enter in an empty item", async () => {
    const { view, user, changed } = mount("- milk");
    await waitFor(() => expect(document.activeElement).toBe(view.contentDOM));

    await user.keyboard("{Enter}");
    expect(view.state.doc.toString()).toBe("- milk\n- ");
    await user.keyboard("{Enter}");
    expect(view.state.doc.toString()).toBe("- milk\n");
    expect(changed).toHaveBeenLastCalledWith("- milk\n");
  });

  it("counts an ordered list on", async () => {
    const { view, user } = mount("1. one");
    await waitFor(() => expect(document.activeElement).toBe(view.contentDOM));
    await user.keyboard("{Enter}");
    expect(view.state.doc.toString()).toBe("1. one\n2. ");
  });

  it("saves on Ctrl+S and goes back to reading on Escape", async () => {
    const { view, user, saved, done } = mount("text", false);
    await waitFor(() => expect(document.activeElement).toBe(view.contentDOM));
    await user.keyboard("{Control>}s{/Control}");
    expect(saved).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("styles nothing in a plain text file", async () => {
    mount("## not a heading\n- not a list", false);
    expect(document.querySelector(".cm-md-h2, .cm-md-bullet")).toBeNull();
  });
});
