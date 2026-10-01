import type {
  Outcome,
  RequestOf,
  RequestType,
  ResponseOf,
  SidebarFolderRow,
  WireAssetDetail,
  WireSidebar,
} from "@roost/contract";
import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ASSET_DRAG_TYPE } from "../dnd.js";
import type { ConfirmRequest } from "../grid/trash-actions.js";
import { FakeEngine, fakeDetail, install } from "../testing/fake-engine.js";
import { Inspector } from "./Inspector.js";

/**
 * The panel, driven the way a person drives it.
 *
 * The claim under test throughout is the one `UI_SPEC.md` makes: every edit
 * reads the record back. The fake engine normalises the same things the real
 * one does — a trimmed name, a dropped whitespace note, deduplicated tags — so
 * a component that displayed what it typed would show something the fake does
 * not hold, and these would fail.
 */

const HASH = fakeDetail(1).id;

/**
 * A library that already has tags, for the field to suggest from.
 *
 * The counts decide the order within a half of the list, and the group is a
 * label rather than part of the name — tags here are flat and unique.
 */
const VOCABULARY = [
  { name: "olahraga", group: "Topik", count: 412, query: 'tag:"olahraga"' },
  { name: "olahan-video", group: null, count: 37, query: 'tag:"olahan-video"' },
  { name: "sepakbola-olahraga", group: null, count: 9, query: 'tag:"sepakbola-olahraga"' },
  { name: "oke", group: null, count: 3, query: 'tag:"oke"' },
];

/**
 * A folder tree with a nested branch in it.
 *
 * Two folders whose paths differ and whose names might not is the case the
 * control has to draw honestly: the menu shows the tree, and the chip shows the
 * path.
 */
const FOLDERS: readonly SidebarFolderRow[] = [
  folderRow(1, "Design", "Design", 0),
  folderRow(2, "Icons", "Design/Icons", 1),
  folderRow(3, "Notes", "Notes", 0),
];

function folderRow(folder: number, name: string, path: string, depth: number): SidebarFolderRow {
  return {
    id: `folder:${folder}`,
    name,
    query: `folder:"${path}"`,
    count: null,
    descendants: 0,
    depth,
    group: null,
    stars: null,
    folder,
    path,
  };
}

/**
 * Where a chip's query lands.
 *
 * The window hands the panel the same callback it hands the navigation pane, so
 * what these tests assert is the **query that was sent** — a chip that filtered
 * by assembling `tag:olahraga` itself would pass a test that only asked whether
 * something was picked.
 */
const picked: string[] = [];

const remember = (query: string): void => {
  picked.push(query);
};

beforeEach(() => {
  picked.length = 0;
});

/** What the engine answers `library:sidebar` with, so the fake can resolve one. */
const SIDEBAR: WireSidebar = {
  places: [],
  ratings: [],
  folders: FOLDERS,
  smartFolders: [],
  tags: [],
  types: [],
};

describe("the inspector", () => {
  let engine: FakeEngine;

  const show = (over: Parameters<typeof fakeDetail>[1] = {}, id: string | undefined = HASH) => {
    engine = new FakeEngine({ details: [fakeDetail(1, over)], sidebar: SIDEBAR });
    install(engine);
    const view = render(
      <Inspector
        ids={id === undefined ? [] : [id]}
        generation={0}
        vocabulary={VOCABULARY}
        folders={FOLDERS}
        onPick={remember}
      />,
    );
    return { user: userEvent.setup(), ...view };
  };

  beforeEach(() => {
    vi.useRealTimers();
  });

  it("lists the caption tracks, and detaching does not delete one", async () => {
    // Here rather than in the sidebar: a sidebar row is a query, and a query
    // cannot mean "the tracks of whatever is selected" (ADR-0025).
    const { user } = show({
      subtitles: [
        { id: "f".repeat(64), lang: "id", label: null, name: "holiday.id.srt", servable: true },
      ],
    });

    const block = await screen.findByRole("region", { name: "Subtitles" });
    expect(block.textContent).toContain("holiday.id.srt");
    expect(block.textContent).toContain("id");

    // Opening and revealing act on the **track**, not on the asset it captions.
    await user.click(within(block).getByRole("button", { name: "Open" }));
    await user.click(within(block).getByRole("button", { name: "Show in file manager" }));
    await waitFor(() =>
      expect(engine.seen.filter((request) => request.type === "asset:openExternally")).toEqual([
        { type: "asset:openExternally", id: "f".repeat(64) },
      ]),
    );
    expect(engine.seen.filter((request) => request.type === "asset:reveal")).toEqual([
      { type: "asset:reveal", id: "f".repeat(64) },
    ]);

    // One gesture, one request: detach *and* trash, because somebody finished
    // with a track is finished with the file (ADR-0025, ADR-0022).
    await user.click(within(block).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(engine.seen.filter((request) => request.type === "asset:subtitleDelete")).toEqual([
        { type: "asset:subtitleDelete", id: HASH, track: "f".repeat(64) },
      ]),
    );
    // The trash, not a permanent removal — `Delete` means the same thing here
    // as everywhere else, and asks nothing because it is reversible.
    expect(engine.seen.some((request) => request.type === "assets:remove")).toBe(false);
  });

  it("draws no subtitle block where nothing is attached", async () => {
    show();
    await screen.findByRole("region", { name: "Metadata" }).catch(() => undefined);
    expect(screen.queryByRole("region", { name: "Subtitles" })).toBeNull();
  });

  it("keeps its place when nothing is selected, and says why it is empty", () => {
    // It used to render nothing at all, which took the grid from four columns
    // to two and back on every click on the background — measured in a real
    // window, 1040px against 760px. The panel stays; what changes is what is
    // in it, and an empty *state* is not the shell of disabled controls the
    // old rule was avoiding (`UI_SPEC.md` §8).
    //
    // **Rendered directly rather than through `show`.** Its `id` parameter
    // has a default, so `show({}, undefined)` selects the default rather than
    // an empty selection — which is why the test this replaces passed while
    // asserting something else entirely: it was reading the first render,
    // before the detail arrived, and would have passed with no selection logic
    // in the component at all (`TODO.md` §4, lesson 9).
    engine = new FakeEngine({});
    install(engine);
    render(
      <Inspector
        ids={[]}
        generation={0}
        vocabulary={VOCABULARY}
        folders={FOLDERS}
        onPick={remember}
      />,
    );
    expect(screen.getByRole("complementary", { name: "Inspector" })).toBeDefined();
    expect(screen.getByText("Nothing selected")).toBeDefined();
    // Nothing editable: a control here would act on no asset at all.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("empties itself for an asset the library no longer holds, without vanishing", async () => {
    // A selection can outlive the asset it points at. An empty panel is the
    // answer to that, not an error — and not a missing panel either, or the
    // grid reflows behind a selection that is still there.
    engine = new FakeEngine({ details: [] });
    install(engine);
    render(
      <Inspector
        ids={[HASH]}
        generation={0}
        vocabulary={VOCABULARY}
        folders={FOLDERS}
        onPick={remember}
      />,
    );
    await waitFor(() => expect(engine.seen.some((r) => r.type === "asset:detail")).toBe(true));
    expect(screen.getByRole("complementary", { name: "Inspector" })).toBeDefined();
    // Not the empty-selection wording: something *is* selected.
    expect(screen.queryByText("Nothing selected")).toBeNull();
  });

  it("shows what the library knows", async () => {
    show({ name: "photo.png", size: 2048, width: 800, height: 600, tags: ["wood"] });
    expect(await screen.findByRole("complementary", { name: "Inspector" })).toBeDefined();
    // The stem alone: the extension is not editable, so it is not in the field.
    expect((screen.getByLabelText("Name") as HTMLTextAreaElement).value).toBe("photo");
    expect(screen.getByText("2.0 KiB")).toBeDefined();
    expect(screen.getByText("800 × 600")).toBeDefined();
    expect(screen.getByText("wood")).toBeDefined();
    expect(screen.getByText(HASH)).toBeDefined();
  });

  it("tells a video's codec apart from its audio's", async () => {
    // Both rows said "Codec" — reported from a real library on 2026-09-01,
    // where a webm showed `av1` over `opus` with nothing to say which was
    // which. Qualifying only the audio one would have moved the ambiguity to
    // a file with a single track rather than removed it.
    show({
      props: {
        "video.codec": "av1",
        "video.fps": "29.97",
        "audio.codec": "opus",
        "audio.channels": "2",
      },
    });
    expect(await screen.findByText("Video codec")).toBeDefined();
    expect(screen.getByText("Audio codec")).toBeDefined();
    expect(screen.queryByText("Codec")).toBeNull();
    expect(screen.getByText("av1")).toBeDefined();
    expect(screen.getByText("opus")).toBeDefined();
  });

  it("shows the 512px preview, served over roost://", async () => {
    // Invariant 12 and ADR-0008. The 512 is generated on first use, so an
    // asset nobody has opened has none and the extension shows through — the
    // same placeholder the grid draws, for the same reason.
    show({ ext: "png" });
    await screen.findByRole("complementary");
    const image = document.querySelector<HTMLImageElement>(".inspector-preview .cell-image");
    expect(image?.getAttribute("src")).toBe(`roost://thumb/${HASH}@512`);
    expect(document.querySelector(".inspector-preview .cell-kind")?.textContent).toBe("png");
  });

  /** A drag started from the picture, with `onDragOut` answering `goes`. */
  const dragPicture = async (goes: boolean | undefined) => {
    engine = new FakeEngine({ details: [fakeDetail(1)], sidebar: SIDEBAR });
    install(engine);
    const asked: (readonly string[])[] = [];
    render(
      <Inspector
        ids={[HASH]}
        generation={0}
        vocabulary={VOCABULARY}
        folders={FOLDERS}
        onPick={remember}
        {...(goes === undefined
          ? {}
          : {
              onDragOut: (ids: readonly string[]) => {
                asked.push(ids);
                return goes;
              },
            })}
      />,
    );
    await waitFor(() => expect(document.querySelector(".inspector-preview")).not.toBeNull());
    const picture = document.querySelector(".inspector-preview") as HTMLElement;
    const set = new Map<string, string>();
    const dataTransfer = {
      types: [],
      setData: (type: string, value: string) => set.set(type, value),
      getData: (type: string) => set.get(type) ?? "",
      setDragImage: () => {},
      effectAllowed: "none",
    } as unknown as DataTransfer;
    const event = createEvent.dragStart(picture, { dataTransfer });
    fireEvent(picture, event);
    return { asked, set, event, picture };
  };

  it("drags the asset out of the window from its picture", async () => {
    // ADR-0034 §7: the same native drag a cell starts, and the window's own
    // drag cancelled in its place.
    const { asked, set, event, picture } = await dragPicture(true);
    expect(picture.getAttribute("draggable")).toBe("true");
    expect(asked).toEqual([[HASH]]);
    expect(event.defaultPrevented).toBe(true);
    expect(set.size).toBe(0);
  });

  it("drags inside the window from its picture when the drag cannot go out", async () => {
    // So a folder in the sidebar still takes it, as it takes a cell's.
    for (const goes of [false, undefined]) {
      const { set, event } = await dragPicture(goes);
      expect(event.defaultPrevented).toBe(false);
      expect(JSON.parse(set.get(ASSET_DRAG_TYPE) ?? "[]")).toEqual([HASH]);
      document.body.innerHTML = "";
    }
  });

  it("says why a selected file has no preview, and what to do, the moment it is selected", async () => {
    // ADR-0050: the problem is told on the file, not counted in the status bar.
    const { user } = show({
      ext: "png",
      undrawn: "Input file has corrupt header: VipsJpeg: premature end of JPEG image",
    });
    expect(await screen.findByText("The file is damaged or incomplete")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(engine.seen).toContainEqual({ type: "derive:retryAsset", id: HASH });
  });

  it("says nothing of the kind for a file that has its picture", async () => {
    show({ ext: "png" });
    await screen.findByRole("complementary");
    expect(screen.queryByRole("region", { name: "Why there is no preview" })).toBeNull();
  });

  it("draws the next asset's preview after one that had none", async () => {
    // The panel keeps one `<img>` for whatever is selected, and the fallback
    // hides that element by writing to the node — which React does not undo.
    // So a `.txt`, which has no thumbnail at any size, used to blank the
    // preview for **every asset selected afterwards**. Reported from a real
    // window on 2026-09-05, reproduced there, and fixed by showing the element
    // again when bytes arrive.
    engine = new FakeEngine({
      details: [fakeDetail(1, { ext: "txt" }), fakeDetail(2, { ext: "png" })],
    });
    install(engine);
    const view = render(
      <Inspector
        ids={[fakeDetail(1).id]}
        generation={0}
        vocabulary={VOCABULARY}
        folders={FOLDERS}
        onPick={remember}
      />,
    );
    await screen.findByRole("complementary");
    const image = (): HTMLImageElement => {
      const found = document.querySelector<HTMLImageElement>(".inspector-preview .cell-image");
      if (found === null) throw new Error("no preview image");
      return found;
    };

    // Twice: the 512 that is not there, then the 256 it falls back to.
    await waitFor(() => expect(image().getAttribute("src")).toContain("@512"));
    fireEvent.error(image());
    expect(image().src).toContain("@256");
    fireEvent.error(image());
    expect(image().hidden).toBe(true);

    view.rerender(
      <Inspector
        ids={[fakeDetail(2).id]}
        generation={0}
        vocabulary={VOCABULARY}
        folders={FOLDERS}
        onPick={remember}
      />,
    );
    await waitFor(() => expect(image().getAttribute("src")).toContain(fakeDetail(2).id));
    fireEvent.load(image());
    expect(image().hidden).toBe(false);
  });

  it("rates, and clears by clicking the star already set", async () => {
    const { user } = show();
    await screen.findByRole("button", { name: "4 stars" });

    await user.click(screen.getByRole("button", { name: "4 stars" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "4 stars" }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );

    // `null` is unrated and is not zero (`DATA_MODEL.md`), and this gesture is
    // the only one that can say so without a second control.
    await user.click(screen.getByRole("button", { name: "4 stars" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "4 stars" }).getAttribute("aria-pressed")).toBe(
        "false",
      ),
    );
    const rates = engine.seen.filter((r) => r.type === "asset:rate");
    expect(rates.map((r) => (r as { rating: number | null }).rating)).toEqual([4, null]);
  });

  it("adds a tag on Enter and shows the tag the engine kept", async () => {
    const { user } = show({ tags: ["wood"] });
    await screen.findByLabelText("Add a tag");

    // The fake deduplicates the way the engine does, so what comes back is one
    // tag rather than two — which is the whole reason for the re-read.
    await user.type(screen.getByLabelText("Add a tag"), "  wood  {Enter}");
    await waitFor(() => expect(screen.getAllByText("wood")).toHaveLength(1));
    expect((screen.getByLabelText("Add a tag") as HTMLInputElement).value).toBe("");
  });

  it("suggests the library's own tags, and sends the one that was picked", async () => {
    // The vocabulary is the sidebar's, so this costs no request: what the
    // window already draws in the navigation pane is what it offers here.
    const { user } = show({ tags: ["oke"] });
    const field = await screen.findByLabelText("Add a tag");

    await user.type(field, "ola");
    const options = screen.getAllByRole("option").map((option) => option.textContent);
    // "oke" is on the asset already and is not offered back; the match in the
    // middle of a name comes after both matches on the beginning of one.
    expect(options).toEqual(["olahragaTopik412", "olahan-video37", "sepakbola-olahraga9"]);

    await user.click(screen.getByRole("option", { name: /olahan-video/ }));
    await waitFor(() =>
      expect(engine.seen.filter((request) => request.type === "asset:tagAdd")).toEqual([
        { type: "asset:tagAdd", ids: [HASH], tags: ["olahan-video"] },
      ]),
    );
    expect((field as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("removes a tag", async () => {
    const { user } = show({ tags: ["wood", "metal"] });
    await user.click(await screen.findByRole("button", { name: "Remove wood" }));
    await waitFor(() => expect(screen.queryByText("wood")).toBeNull());
    expect(screen.getByText("metal")).toBeDefined();
  });

  it("filters by a tag when its chip is clicked, with the query the engine wrote", async () => {
    // One click since 2026-09-24, as a folder chip is; a right-click menu first.
    // The query is the sidebar row's own — the quoting belongs to
    // `@roost/library`, not to a chip.
    const { user } = show({ tags: ["olahraga"] });

    await user.click(await screen.findByRole("button", { name: "olahraga" }));
    expect(picked).toEqual(['tag:"olahraga"']);
  });

  it("opens no menu on a tag chip, now that the click does what the menu did", async () => {
    show({ tags: ["olahraga"] });
    const chip = await screen.findByRole("button", { name: "olahraga" });

    chip.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("offers no filter for a tag the sidebar has not caught up with", async () => {
    // The moment after a tag is made: the chip is drawn from the asset's record
    // and the query comes from the sidebar, which the window re-reads on its
    // own schedule.
    const { user } = show({ tags: ["wood"] });

    const name = await screen.findByRole("button", { name: "wood" });
    expect((name as HTMLButtonElement).disabled).toBe(true);
    await user.click(name);
    expect(picked).toEqual([]);
  });

  it("renames on blur, keeps the extension, and shows the name the engine stored", async () => {
    const { user } = show({ name: "one.png", ext: "png" });
    const field = await screen.findByLabelText("Name");

    await user.clear(field);
    await user.type(field, "  two  ");
    await user.tab();

    // The extension goes back on, and the typed spaces do not: a trailing space
    // would land in the middle of the name, where `cleanName` cannot reach it.
    await waitFor(() =>
      expect(engine.seen.find((r) => r.type === "asset:rename")).toMatchObject({ name: "two.png" }),
    );
    await waitFor(() => expect((field as HTMLTextAreaElement).value).toBe("two"));
  });

  // `ext` is decided at import and `asset_rename` never touches it, so a field
  // holding `.txt` offered an edit that changed nothing anywhere.
  it("does not offer the extension for editing", async () => {
    const { user } = show({ name: "notes.txt", ext: "txt" });
    const field = (await screen.findByLabelText("Name")) as HTMLTextAreaElement;
    expect(field.value).toBe("notes");

    await user.clear(field);
    await user.type(field, "notes.jpg");
    await user.tab();

    await waitFor(() =>
      expect(engine.seen.find((r) => r.type === "asset:rename")).toMatchObject({
        name: "notes.jpg.txt",
      }),
    );
  });

  // A rename made before this rule existed, or by the CLI, can leave a name that
  // does not end in the file's extension. There is nothing to hide then, and
  // appending one anyway would rename the asset on a click into the field.
  it("shows the whole name when it does not end in the extension", async () => {
    const { user } = show({ name: "notes", ext: "txt" });
    const field = (await screen.findByLabelText("Name")) as HTMLTextAreaElement;
    expect(field.value).toBe("notes");

    await user.click(field);
    await user.tab();
    expect(engine.seen.some((r) => r.type === "asset:rename")).toBe(false);
  });

  // The column is lowercased at import; the name is not.
  it("keeps the extension spelled the way the name spells it", async () => {
    const { user } = show({ name: "Holiday.JPG", ext: "jpg" });
    const field = (await screen.findByLabelText("Name")) as HTMLTextAreaElement;
    expect(field.value).toBe("Holiday");

    await user.clear(field);
    await user.type(field, "Trip");
    await user.tab();

    await waitFor(() =>
      expect(engine.seen.find((r) => r.type === "asset:rename")).toMatchObject({
        name: "Trip.JPG",
      }),
    );
  });

  it("puts the stored name back on Escape", async () => {
    const { user } = show({ name: "one.png" });
    const field = (await screen.findByLabelText("Name")) as HTMLTextAreaElement;
    await user.clear(field);
    await user.type(field, "typo{Escape}");
    expect(field.value).toBe("one");
    expect(engine.seen.some((r) => r.type === "asset:rename")).toBe(false);
  });

  // The field wraps so that a long name can be read, which means it is a
  // textarea, which means `Enter` and a pasted newline both have a way into a
  // name for the first time. `cleanName` only trims the ends, so a newline that
  // got this far would reach the journal.
  it("keeps a name to one line", async () => {
    const { user } = show({ name: "one.png" });
    const field = (await screen.findByLabelText("Name")) as HTMLTextAreaElement;

    await user.clear(field);
    await user.paste("two\nlines");
    expect(field.value).toBe("two lines");

    await user.type(field, "{Enter}");
    expect(field.value).toBe("two lines");
    await waitFor(() =>
      expect(engine.seen.find((request) => request.type === "asset:rename")).toMatchObject({
        name: "two lines.png",
      }),
    );
  });

  it("saves a note on blur, and drops one that is only whitespace", async () => {
    const { user } = show();
    const note = await screen.findByLabelText("Note");

    await user.type(note, "   ");
    await user.tab();
    await waitFor(() => expect(engine.seen.some((r) => r.type === "asset:note")).toBe(true));
    // An empty note badge that is on forever and says nothing is worse than no
    // badge, so the engine stores `null` — and the panel shows what it stored.
    await waitFor(() => expect((note as HTMLTextAreaElement).value).toBe(""));
  });

  /**
   * Where the file came from (ADR-0030).
   *
   * Three claims in one test, because they are one behaviour: the value is
   * stored as typed, the open button appears only for what the desktop should
   * be handed, and clicking it asks main rather than fetching anything.
   */
  it("saves a source and offers to open it only when it is an http(s) link", async () => {
    const { user } = show();
    const field = await screen.findByLabelText("Source");

    // A bare hostname is a perfectly good answer to "where did this come from",
    // so it is stored — and it is *not* offered as a link, because handing an
    // arbitrary string to the desktop's URL handler on a click is not a thing
    // to do. A control that cannot be operated is worse than an absent one.
    await user.type(field, "instagram.com/p/xyz");
    await user.tab();
    await waitFor(() =>
      expect(engine.seen.filter((r) => r.type === "asset:source")[0]).toMatchObject({
        url: "instagram.com/p/xyz",
      }),
    );
    expect(screen.queryByRole("button", { name: "Open source in browser" })).toBeNull();

    await user.clear(field);
    await user.type(field, "https://example.com/a{Enter}");
    // Enter is the save: one value and no paragraphs, so there is no second
    // line for it to make.
    const open = await screen.findByRole("button", { name: "Open source in browser" });

    await user.click(open);
    expect(engine.seen.filter((r) => r.type === "link:open")).toEqual([
      { type: "link:open", url: "https://example.com/a" },
    ]);
  });

  it("hands the file to the desktop when asked", async () => {
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: "Open externally" }));
    // `CONCEPT.md` §5: a format Roost cannot draw must not be a dead end.
    expect(engine.seen.filter((r) => r.type === "asset:openExternally")).toHaveLength(1);
  });

  it("re-reads when something outside it changed the library", async () => {
    engine = new FakeEngine({ details: [fakeDetail(1, { rating: 2 })] });
    install(engine);
    const { rerender } = render(
      <Inspector
        ids={[HASH]}
        generation={0}
        vocabulary={VOCABULARY}
        folders={FOLDERS}
        onPick={remember}
      />,
    );
    await screen.findByRole("button", { name: "4 stars" });
    const before = engine.seen.filter((r) => r.type === "asset:detail").length;

    rerender(
      <Inspector
        ids={[HASH]}
        generation={1}
        vocabulary={VOCABULARY}
        folders={FOLDERS}
        onPick={remember}
      />,
    );
    await waitFor(() =>
      expect(engine.seen.filter((r) => r.type === "asset:detail").length).toBeGreaterThan(before),
    );
  });
});

describe("the folders an asset is in", () => {
  let engine: FakeEngine;

  const show = (folders: WireAssetDetail["folders"]) => {
    engine = new FakeEngine({ details: [fakeDetail(1, { folders })], sidebar: SIDEBAR });
    install(engine);
    const view = render(
      <Inspector
        ids={[HASH]}
        generation={0}
        vocabulary={VOCABULARY}
        folders={FOLDERS}
        onPick={remember}
      />,
    );
    return { user: userEvent.setup(), ...view };
  };

  /** The last request of `type`, whatever shape it has. */
  const last = (type: string): Record<string, unknown> | undefined =>
    [...engine.seen].reverse().find((request) => request.type === type) as never;

  it("names a folder by its whole path, because a name does not name it", async () => {
    // Two folders can be called `Icons`. The chip is what somebody reads before
    // pressing the `×` beside it, so it has to say which one.
    show([{ id: 2, path: "Design/Icons" }]);
    expect(await screen.findByText("Design/Icons")).toBeDefined();
  });

  it("shows the folder when its chip is clicked, no menu in between", async () => {
    // Not the tag chip's gesture, and deliberately (2026-09-07): a folder chip
    // says one thing, so there is nothing to choose between and a menu would be
    // a click in the way. The query is the tree row's, quoted by the engine.
    const { user } = show([{ id: 2, path: "Design/Icons" }]);

    await user.click(await screen.findByRole("button", { name: "Design/Icons" }));
    expect(picked).toEqual(['folder:"Design/Icons"']);
  });

  it("does not offer to show a folder the tree does not know yet", async () => {
    const { user } = show([{ id: 9, path: "Elsewhere" }]);

    const chip = await screen.findByRole("button", { name: "Elsewhere" });
    expect((chip as HTMLButtonElement).disabled).toBe(true);
    await user.click(chip);
    expect(picked).toEqual([]);
  });

  it("detaches by id, and detaching is not a delete", async () => {
    const { user } = show([{ id: 2, path: "Design/Icons" }]);
    await screen.findByText("Design/Icons");

    await user.click(screen.getByRole("button", { name: "Remove from Design/Icons" }));

    await waitFor(() => expect(last("asset:folderRemove")).toBeDefined());
    expect(last("asset:folderRemove")).toMatchObject({ ids: [HASH], folder: 2 });
    // A folder is a collection, so leaving one touches nothing else: no trash,
    // no removal, and no dialog in between.
    expect(engine.seen.some((request) => request.type === "assets:trash")).toBe(false);
    expect(engine.seen.some((request) => request.type === "assets:remove")).toBe(false);
  });

  it("offers the whole tree, and refuses the folder it is already in", async () => {
    const { user } = show([{ id: 1, path: "Design" }]);
    await screen.findByText("Design");

    await user.click(screen.getByRole("button", { name: "Add to folder" }));
    await screen.findByRole("menu");

    expect(screen.getByRole("menuitem", { name: "Icons" })).toBeDefined();
    // Disabled rather than absent: a menu that changes shape between two
    // openings is one nobody learns.
    expect(screen.getByRole("menuitem", { name: "Design" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  });

  it("adds the asset to the folder that was chosen", async () => {
    const { user } = show([]);
    await screen.findByLabelText("Name");

    await user.click(screen.getByRole("button", { name: "Add to folder" }));
    await user.click(await screen.findByRole("menuitem", { name: "Icons" }));

    await waitFor(() => expect(last("asset:folderAdd")).toBeDefined());
    expect(last("asset:folderAdd")).toMatchObject({ ids: [HASH], folder: 2 });
    // The panel reads the record back rather than drawing what it sent.
    expect(await screen.findByText("Design/Icons")).toBeDefined();
  });

  it("says so when the library has no folders to offer", async () => {
    engine = new FakeEngine({ details: [fakeDetail(1)] });
    install(engine);
    render(
      <Inspector
        ids={[HASH]}
        generation={0}
        vocabulary={VOCABULARY}
        folders={[]}
        onPick={remember}
      />,
    );

    const trigger = await screen.findByRole("button", { name: "Add to folder" });
    expect(trigger.hasAttribute("disabled")).toBe(true);
  });
});

describe("what a re-read must and must not overwrite", () => {
  it("does not leave the field showing a name the library does not hold", async () => {
    // The subtle half of "every edit reads the record back". Typing two spaces
    // onto `one` names the same asset `one.png` again — nothing to send, and
    // nothing for a re-read to adopt — so the field has to be put back from the
    // record here, or it goes on showing a trailing space that exists nowhere
    // else and vanishes only on the next reload.
    const engine = new FakeEngine({ details: [fakeDetail(1, { name: "one.png" })] });
    install(engine);
    render(
      <Inspector
        ids={[HASH]}
        generation={0}
        vocabulary={VOCABULARY}
        folders={FOLDERS}
        onPick={remember}
      />,
    );
    const user = userEvent.setup();

    const field = (await screen.findByLabelText("Name")) as HTMLTextAreaElement;
    await user.type(field, "  ");
    expect(field.value).toBe("one  ");
    await user.tab();

    await waitFor(() => expect(field.value).toBe("one"));
  });

  it("does not stomp a half-typed note when something else changed the library", async () => {
    const engine = new FakeEngine({ details: [fakeDetail(1)] });
    install(engine);
    const { rerender } = render(
      <Inspector
        ids={[HASH]}
        generation={0}
        vocabulary={VOCABULARY}
        folders={FOLDERS}
        onPick={remember}
      />,
    );
    const user = userEvent.setup();

    const note = (await screen.findByLabelText("Note")) as HTMLTextAreaElement;
    await user.type(note, "half a th");

    // An edit elsewhere re-reads this asset too. Losing what is being typed
    // because an unrelated asset was tagged is the bug this guards.
    rerender(
      <Inspector
        ids={[HASH]}
        generation={1}
        vocabulary={VOCABULARY}
        folders={FOLDERS}
        onPick={remember}
      />,
    );
    await waitFor(() =>
      expect(engine.seen.filter((r) => r.type === "asset:detail").length).toBe(2),
    );
    expect(note.value).toBe("half a th");
  });
});

/**
 * A selection of several assets.
 *
 * The bug this covers was reported from real use on 2026-08-30: selecting five
 * assets and adding a tag tagged one of them. **Every assertion here counts the
 * ids that were sent**, because the broken version would have passed any
 * test that only asked whether the tag arrived.
 */
describe("the inspector over several assets", () => {
  let engine: FakeEngine;

  const THREE = [0, 1, 2].map((index) => fakeDetail(index).id);

  const show = (
    details: readonly Partial<WireAssetDetail>[],
    onConfirm?: (request: ConfirmRequest) => void,
  ) => {
    engine = new FakeEngine({
      details: details.map((over, index) => fakeDetail(index, over)),
      sidebar: SIDEBAR,
    });
    install(engine);
    const view = render(
      <Inspector
        ids={THREE}
        generation={0}
        vocabulary={VOCABULARY}
        folders={FOLDERS}
        onPick={remember}
        {...(onConfirm === undefined ? {} : { onConfirm })}
      />,
    );
    return { user: userEvent.setup(), ...view };
  };

  /** The ids the last request of `type` carried. */
  const sentTo = (type: string): readonly string[] => {
    const last = [...engine.seen].reverse().find((request) => request.type === type);
    return (last as { ids?: readonly string[] } | undefined)?.ids ?? [];
  };

  it("adds a tag to every selected asset, not to one of them", async () => {
    const { user } = show([{}, {}, {}]);
    await screen.findByText("3 assets");

    await user.type(screen.getByLabelText("Add a tag"), "wood{Enter}");

    await waitFor(() => expect(sentTo("asset:tagAdd")).toHaveLength(3));
    expect(sentTo("asset:tagAdd")).toEqual(THREE);
  });

  it("rates every selected asset", async () => {
    const { user } = show([{}, {}, {}]);
    await screen.findByText("3 assets");

    await user.click(screen.getByRole("button", { name: "4 stars" }));

    await waitFor(() => expect(sentTo("asset:rate")).toEqual(THREE));
  });

  it("says the rating is mixed, and a click sets rather than clears", async () => {
    // Clicking the star they already share clears it — but a selection that
    // disagrees has no shared rating to clear, so the same click must set.
    const { user } = show([{ rating: 4 }, { rating: 2 }, { rating: 4 }]);
    expect(await screen.findByText("mixed")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "4 stars" }));

    await waitFor(() => expect(engine.seen.some((r) => r.type === "asset:rate")).toBe(true));
    const request = [...engine.seen].reverse().find((r) => r.type === "asset:rate");
    expect((request as { rating: number | null }).rating).toBe(4);
  });

  it("clears the rating they all share, the way one asset does", async () => {
    const { user } = show([{ rating: 3 }, { rating: 3 }, { rating: 3 }]);
    await screen.findByText("3 assets");
    expect(screen.queryByText("mixed")).toBeNull();

    await user.click(screen.getByRole("button", { name: "3 stars" }));

    await waitFor(() => expect(engine.seen.some((r) => r.type === "asset:rate")).toBe(true));
    const request = [...engine.seen].reverse().find((r) => r.type === "asset:rate");
    expect((request as { rating: number | null }).rating).toBeNull();
  });

  it("draws a tag some of them carry apart from one they all carry", async () => {
    show([{ tags: ["wood", "wip"] }, { tags: ["wood"] }, { tags: ["wood"] }]);
    await screen.findByText("3 assets");

    const shared = screen.getByText("wood").closest("li");
    const partial = screen.getByText("wip").closest("li");
    expect(shared?.hasAttribute("data-partial")).toBe(false);
    expect(partial?.hasAttribute("data-partial")).toBe(true);
  });

  it("removes a tag from the whole selection", async () => {
    const { user } = show([{ tags: ["wood"] }, { tags: ["wood"] }, { tags: ["wood"] }]);
    await screen.findByText("3 assets");

    await user.click(screen.getByRole("button", { name: "Remove wood" }));

    await waitFor(() => expect(sentTo("asset:tagRemove")).toEqual(THREE));
  });

  it("draws a folder some of them are in apart from one they are all in", async () => {
    show([
      {
        folders: [
          { id: 1, path: "Design" },
          { id: 3, path: "Notes" },
        ],
      },
      { folders: [{ id: 1, path: "Design" }] },
      { folders: [{ id: 1, path: "Design" }] },
    ]);
    await screen.findByText("3 assets");

    expect(screen.getByText("Design").closest("li")?.hasAttribute("data-partial")).toBe(false);
    expect(screen.getByText("Notes").closest("li")?.hasAttribute("data-partial")).toBe(true);
  });

  it("takes the whole selection out of a folder, not one asset of it", async () => {
    const folders = [{ id: 1, path: "Design" }];
    const { user } = show([{ folders }, { folders }, { folders }]);
    await screen.findByText("3 assets");

    await user.click(screen.getByRole("button", { name: "Remove from Design" }));

    await waitFor(() => expect(sentTo("asset:folderRemove")).toEqual(THREE));
  });

  it("offers no name and no preview", async () => {
    // A name is unique to one asset, and one asset's picture over controls that
    // edit all of them is the misreading this whole panel exists to correct.
    // The note and the source used to be on this list (ADR-0048).
    show([{}, {}, {}]);
    await screen.findByText("3 assets");

    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(document.querySelector(".inspector-preview")).toBeNull();
  });

  describe("the note and the source (ADR-0048)", () => {
    it("writes a note to every asset when none of them has one, without asking", async () => {
      const asked: ConfirmRequest[] = [];
      const { user } = show([{}, {}, {}], (request) => asked.push(request));
      const field = await screen.findByLabelText("Note");

      await user.type(field, "for the client");
      await user.tab();

      await waitFor(() => expect(sentTo("asset:note")).toEqual(THREE));
      expect(asked).toEqual([]);
    });

    it("shows the note they share, and replaces it everywhere without asking", async () => {
      // Agreement is the single-asset case twelve times over: what is replaced
      // is what is on screen.
      const asked: ConfirmRequest[] = [];
      const shared = { note: "draft" };
      const { user } = show([shared, shared, shared], (request) => asked.push(request));
      const field = (await screen.findByLabelText("Note")) as HTMLTextAreaElement;
      await waitFor(() => expect(field.value).toBe("draft"));

      await user.clear(field);
      await user.type(field, "final");
      await user.tab();

      await waitFor(() => expect(sentTo("asset:note")).toEqual(THREE));
      expect(asked).toEqual([]);
    });

    it("says how a mixed selection disagrees, rather than showing an empty note", async () => {
      show([{ note: "one" }, { note: "two" }, {}]);
      const field = (await screen.findByLabelText("Note")) as HTMLTextAreaElement;
      await waitFor(() => expect(field.placeholder).toBe("Mixed — 2 different notes"));
      expect(field.value).toBe("");
    });

    it("counts the assets lacking the one value some of them hold", async () => {
      show([{ sourceUrl: "https://example.com/post" }, {}, {}]);
      const field = (await screen.findByLabelText("Source")) as HTMLInputElement;
      await waitFor(() => expect(field.placeholder).toBe("Mixed — 1 of 3 have a source"));
      // No one address to open while they disagree.
      expect(screen.queryByRole("button", { name: "Open source in browser" })).toBeNull();
    });

    it("asks before replacing notes that differ, and writes all of them on Replace", async () => {
      const asked: ConfirmRequest[] = [];
      const { user } = show([{ note: "one" }, { note: "two" }, {}], (request) =>
        asked.push(request),
      );
      const field = await screen.findByLabelText("Note");

      await user.type(field, "approved");
      await user.tab();

      await waitFor(() => expect(asked).toHaveLength(1));
      expect(asked[0]?.body).toBe("Replace the note on 3 assets? 2 of them already have one.");
      expect(asked[0]?.confirmLabel).toBe("Replace");
      expect(sentTo("asset:note")).toEqual([]);

      asked[0]?.run(false);
      await waitFor(() => expect(sentTo("asset:note")).toEqual(THREE));
      const request = [...engine.seen].reverse().find((r) => r.type === "asset:note");
      expect((request as { note: string | null }).note).toBe("approved");
    });

    it("puts the field back and writes nothing when the question is declined", async () => {
      const asked: ConfirmRequest[] = [];
      const { user } = show([{ note: "one" }, { note: "two" }, {}], (request) =>
        asked.push(request),
      );
      const field = (await screen.findByLabelText("Note")) as HTMLTextAreaElement;

      await user.type(field, "approved");
      await user.tab();
      await waitFor(() => expect(asked).toHaveLength(1));

      act(() => asked[0]?.onCancel?.());
      expect(field.value).toBe("");
      expect(sentTo("asset:note")).toEqual([]);
    });

    it("writes nothing mixed at all when there is no way to ask", async () => {
      const { user } = show([{ note: "one" }, { note: "two" }, {}]);
      const field = await screen.findByLabelText("Note");

      await user.type(field, "approved");
      await user.tab();
      await new Promise((resume) => setTimeout(resume, 50));

      expect(sentTo("asset:note")).toEqual([]);
    });

    it("writes one source to every asset, which is what a set saved from one post wants", async () => {
      const { user } = show([{}, {}, {}]);
      const field = await screen.findByLabelText("Source");

      await user.type(field, "https://example.com/post{Enter}");

      await waitFor(() => expect(sentTo("asset:source")).toEqual(THREE));
      // Read back as shared, so the one address is offered.
      expect(await screen.findByRole("button", { name: "Open source in browser" })).toBeDefined();
    });
  });

  it("asks once for the whole selection rather than once per asset", async () => {
    // A selection is routinely hundreds of rows. One detail request each would
    // be hundreds of round trips for a panel showing a summary.
    show([{}, {}, {}]);
    await screen.findByText("3 assets");

    expect(engine.seen.filter((r) => r.type === "asset:summary")).toHaveLength(1);
    expect(engine.seen.filter((r) => r.type === "asset:detail")).toHaveLength(0);
  });

  it("ignores an answer the selection has already moved past", async () => {
    // A marquee sweep changes the selection on every frame it crosses a cell,
    // so several reads are in flight at once and they resolve in whatever
    // order they finish. Without a guard the panel settles on the summary of a
    // selection the drag left behind — which reads as the count sticking.
    const engine = new FakeEngine({ details: [0, 1, 2].map((index) => fakeDetail(index)) });
    const real = engine.bridge();
    const held: (() => void)[] = [];
    install(engine);
    Object.defineProperty(window, "roost", {
      configurable: true,
      writable: true,
      value: {
        ...real,
        invoke: function invoke<T extends RequestType>(
          request: RequestOf<T>,
        ): Promise<Outcome<ResponseOf<T>>> {
          const answer = real.invoke(request);
          if (request.type !== "asset:summary") return answer;
          return new Promise((resolve) => {
            held.push(() => void answer.then(resolve));
          });
        },
      },
    });

    const view = render(
      <Inspector
        ids={THREE.slice(0, 2)}
        generation={0}
        vocabulary={VOCABULARY}
        folders={FOLDERS}
        onPick={remember}
      />,
    );
    await waitFor(() => expect(held).toHaveLength(1));
    view.rerender(
      <Inspector
        ids={THREE}
        generation={0}
        vocabulary={VOCABULARY}
        folders={FOLDERS}
        onPick={remember}
      />,
    );
    await waitFor(() => expect(held).toHaveLength(2));

    // The newer read answers first, the older one after it.
    await act(async () => {
      held[1]?.();
    });
    expect(screen.getByText("3 assets")).toBeDefined();

    await act(async () => {
      held[0]?.();
    });
    expect(screen.getByText("3 assets")).toBeDefined();
  });
});
