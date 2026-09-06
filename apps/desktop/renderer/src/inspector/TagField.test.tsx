import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { rankTags, TagField } from "./TagField.js";

/**
 * The tag field, driven the way a person drives it.
 *
 * Two claims are under test and they pull against each other: the field must
 * offer what the library already says, and it must never stand between somebody
 * and a tag that does not exist yet. Everything here is one of the two.
 */

const VOCABULARY = [
  { name: "olahraga", group: "Topik", count: 412 },
  { name: "olahan-video", group: null, count: 37 },
  { name: "sepakbola-olahraga", group: null, count: 9 },
  { name: "oke", group: null, count: 3 },
  { name: "okelah", group: null, count: 1 },
];

const names = (): string[] =>
  screen.getAllByRole("option").map((option) => option.querySelector("span")?.textContent ?? "");

const show = (attached: readonly string[] = []) => {
  const onAdd = vi.fn();
  render(<TagField vocabulary={VOCABULARY} attached={attached} onAdd={onAdd} />);
  return { user: userEvent.setup(), onAdd, field: screen.getByLabelText("Add a tag") };
};

describe("the tag field", () => {
  it("offers nothing until something is typed", () => {
    show();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("puts the beginnings first and the most used first within them", async () => {
    const { user, field } = show();
    await user.type(field, "ola");
    expect(names()).toEqual(["olahraga", "olahan-video", "sepakbola-olahraga"]);
  });

  it("matches whatever the case", async () => {
    const { user, field } = show();
    await user.type(field, "OLAH");
    expect(names()).toEqual(["olahraga", "olahan-video", "sepakbola-olahraga"]);
  });

  it("does not offer a tag the selection already carries", async () => {
    const { user, field } = show(["olahraga"]);
    await user.type(field, "ola");
    expect(names()).toEqual(["olahan-video", "sepakbola-olahraga"]);
  });

  it("adds what was typed when nothing is highlighted, even with a longer tag on offer", async () => {
    // The reason nothing is highlighted by default. `okelah` is a suggestion
    // for `oke`, and `oke` still has to be addable.
    const { user, field, onAdd } = show();
    await user.type(field, "oke{Enter}");
    expect(onAdd).toHaveBeenCalledWith("oke");
  });

  it("adds a tag the library does not have yet", async () => {
    const { user, field, onAdd } = show();
    await user.type(field, "kucing{Enter}");
    expect(onAdd).toHaveBeenCalledWith("kucing");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("walks the list with the arrows, wrapping at both ends", async () => {
    const { user, field, onAdd } = show();
    await user.type(field, "ola");

    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(field.getAttribute("aria-activedescendant")).toBe(
      screen.getAllByRole("option")[1]?.id ?? "",
    );
    // Up from the first wraps to the last, which is how a short list is reached
    // from the end without counting it.
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(field.getAttribute("aria-activedescendant")).toBe(
      screen.getAllByRole("option")[2]?.id ?? "",
    );

    await user.keyboard("{Enter}");
    expect(onAdd).toHaveBeenCalledWith("sepakbola-olahraga");
    expect((field as HTMLInputElement).value).toBe("");
  });

  it("forgets the highlight when the text changes", async () => {
    // Otherwise the second character of a word adds whatever the first
    // character happened to highlight.
    const { user, field, onAdd } = show();
    await user.type(field, "ok{ArrowDown}");
    await user.type(field, "e{Enter}");
    expect(onAdd).toHaveBeenCalledWith("oke");
  });

  it("closes on Escape and keeps what was typed", async () => {
    const { user, field } = show();
    await user.type(field, "ola{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect((field as HTMLInputElement).value).toBe("ola");
  });

  it("lets Escape through once there is no list to close", async () => {
    // The window's Escape clears the selection; a panel that swallowed it would
    // take that key away wherever a tag field happens to have the focus.
    const escapes: string[] = [];
    const onAdd = vi.fn();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: the listener is the assertion
      <div
        onKeyDown={(event) => {
          if (event.key === "Escape")
            escapes.push(String((event.target as HTMLInputElement).value));
        }}
      >
        <TagField vocabulary={VOCABULARY} attached={[]} onAdd={onAdd} />
      </div>,
    );
    const user = userEvent.setup();
    const field = screen.getByLabelText("Add a tag");

    // The first Escape is spent closing the list and stops here.
    await user.type(field, "ola{Escape}");
    expect(escapes).toEqual([]);

    await user.keyboard("{Escape}");
    expect(escapes).toEqual(["ola"]);
  });
});

describe("ranking tags", () => {
  it("offers nothing for whitespace", () => {
    expect(rankTags(VOCABULARY, "   ", [])).toEqual([]);
  });

  it("stops at eight, and the eight are the best eight", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      name: `tag-${index}`,
      group: null,
      count: index,
    }));
    expect(rankTags(many, "tag", []).map((choice) => choice.count)).toEqual([
      19, 18, 17, 16, 15, 14, 13, 12,
    ]);
  });

  it("breaks a tie on the name, so the order does not wander between reads", () => {
    const tied = [
      { name: "beta", group: null, count: 2 },
      { name: "alpha", group: null, count: 2 },
    ];
    expect(rankTags(tied, "a", []).map((choice) => choice.name)).toEqual(["alpha", "beta"]);
  });
});
