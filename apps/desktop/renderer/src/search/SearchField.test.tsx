import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeEngine, install } from "../testing/fake-engine.js";
import { IDLE_MS, SearchField } from "./SearchField.js";

/**
 * The field validates before it applies (`UI_SPEC.md` §5), so what is asserted
 * here is mostly what does *not* happen: a half-typed query never reaches the
 * grid.
 */

const BAD = "ext:png rating:9";
const REASON = "Ratings run from 1 to 5, not 9";

describe("the search field", () => {
  let applied: string[];
  let engine: FakeEngine;

  const show = (query = "", matches: number | undefined = 12) => {
    engine = new FakeEngine({
      existing: [{ root: "/x.roost", name: "X" }],
      invalid: { [BAD]: { message: REASON, at: 8 } },
    });
    install(engine);
    render(<SearchField query={query} onApply={(q) => applied.push(q)} matches={matches} />);
    return userEvent.setup();
  };

  beforeEach(() => {
    applied = [];
  });

  it("applies on Enter, without waiting for the idle", async () => {
    const user = show();
    await user.type(screen.getByRole("searchbox"), "tag:wood{Enter}");
    await waitFor(() => expect(applied).toEqual(["tag:wood"]));
  });

  it("applies once the typing stops", async () => {
    const user = show();
    await user.type(screen.getByRole("searchbox"), "tag:wood");
    // Not per keystroke: eight characters would be eight round trips, and a
    // query is not finished until the typing is.
    expect(applied).toEqual([]);
    await waitFor(() => expect(applied).toEqual(["tag:wood"]), { timeout: 2000 });
    expect(engine.seen.filter((r) => r.type === "query:check")).toHaveLength(1);
  });

  it("leaves the grid alone when the query does not parse", async () => {
    const user = show();
    await user.type(screen.getByRole("searchbox"), `${BAD}{Enter}`);

    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.getByText(REASON)).toBeDefined();
    // The whole point: an invalid query is not sent anywhere.
    expect(applied).toEqual([]);
    expect(screen.getByRole("searchbox").getAttribute("aria-invalid")).toBe("true");
  });

  it("puts the caret where the parser stopped", async () => {
    const user = show();
    await user.type(screen.getByRole("searchbox"), `${BAD}{Enter}`);
    await screen.findByRole("alert");

    // Eight spaces then a caret: under the `r` of `rating`, counted in
    // characters because the field is monospace.
    const caret = document.querySelector(".search-caret");
    expect(caret?.textContent).toBe(`${" ".repeat(8)}^`);
  });

  it("clears the error once the query parses again", async () => {
    const user = show();
    const field = screen.getByRole("searchbox");
    await user.type(field, `${BAD}{Enter}`);
    await screen.findByRole("alert");

    await user.clear(field);
    await user.type(field, "rating:4{Enter}");
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(applied).toEqual(["rating:4"]);
  });

  it("shows the match count when there is nothing to complain about", () => {
    show("", 1234);
    expect(screen.getByText("1,234 matches")).toBeDefined();
  });

  it("follows the query when a sidebar row replaces it", async () => {
    const { rerender } = render(
      <SearchField query="" onApply={(q) => applied.push(q)} matches={0} />,
    );
    // The field shows what is actually being asked (`UI_SPEC.md` §4.1), so a
    // click in the sidebar has to reach it.
    rerender(
      <SearchField query='tag:"brand assets"' onApply={(q) => applied.push(q)} matches={2} />,
    );
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe('tag:"brand assets"');
  });

  it("puts the applied query back on Escape", async () => {
    const user = show("tag:wood");
    const field = screen.getByRole("searchbox") as HTMLInputElement;
    await user.clear(field);
    await user.type(field, "half-typed{Escape}");
    expect(field.value).toBe("tag:wood");
  });

  const LONG = 'folder:"SMA NUSANTARA INDAH SINTANG/IG smanusantaraindah_sintang/post"';

  it("leaves the caret where the click put it", async () => {
    const user = show(LONG);
    const field = screen.getByRole("searchbox") as HTMLInputElement;
    await user.pointer({ target: field, offset: 9, keys: "[MouseLeft]" });

    // The field used to run the caret to the end of the query when it was
    // first clicked, and the user asked for that gone on 2026-09-08: a text
    // field puts the caret where the pointer landed, and this one is no
    // different.
    expect(field.selectionStart).toBe(9);
    expect(field.selectionEnd).toBe(9);
  });

  it("does not touch the query when it is clicked", async () => {
    const user = show(LONG);
    const field = screen.getByRole("searchbox") as HTMLInputElement;
    await user.click(field);

    // No trailing space, and so nothing to ask the engine about: a click is
    // not an edit.
    expect(field.value).toBe(LONG);
    await new Promise((settle) => setTimeout(settle, IDLE_MS * 2));
    expect(applied).toEqual([]);
    expect(engine.seen.filter((r) => r.type === "query:check")).toHaveLength(0);
  });

  it("takes the focus on Ctrl+F from anywhere in the window", async () => {
    const user = show(LONG);
    const field = screen.getByRole("searchbox") as HTMLInputElement;
    await user.keyboard("{Control>}f{/Control}");

    // The focus and nothing else — no selection, and no caret moved.
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe(LONG);
  });

  it("takes the focus on a bare slash, unless a slash is what is being typed", async () => {
    render(
      <>
        <input aria-label="Elsewhere" />
        <SearchField query={LONG} onApply={(q) => applied.push(q)} matches={1} />
      </>,
    );
    const user = userEvent.setup();
    const field = screen.getByRole("searchbox") as HTMLInputElement;
    const elsewhere = screen.getByLabelText("Elsewhere") as HTMLInputElement;

    await user.keyboard("/");
    expect(document.activeElement).toBe(field);

    field.blur();
    await user.type(elsewhere, "and/or");
    // A field prefix is a shortcut in a window and a character in a text field.
    expect(elsewhere.value).toBe("and/or");
    expect(document.activeElement).toBe(elsewhere);
  });
});
