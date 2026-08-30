# Roost — UI Specification

Status: **Draft v1** · Last updated: 2026-08-24

The interface is being designed from scratch for this stack. The Rust implementation's React
code is **not** ported; what carries over is what it learned. This document is the design of
record: if a component is not described here, it does not exist yet, and adding it means
editing this file in the same change that writes it.

---

## 0. What the interface is for

Someone opens Roost with one of three intentions, and the layout should make all three cheap:

1. **Dump.** Drag a folder in and get back to work. Import must never demand attention.
2. **Graze.** Scroll a wall of images with no goal, and stop when something catches the eye.
   This is the mode the product lives or dies in, and it is the one that needs 60fps.
3. **Find.** "The blue poster, 2023, for the pitch." Search, filter, narrow, open.

Everything below is subordinate to those. Chrome that helps mode 3 must not slow mode 2.

### Design principles

1. **The images are the interface.** Chrome is achromatic and quiet; the only saturated colour
   on screen at rest belongs to content. A UI that competes with a photograph loses.
2. **Nothing moves that was not asked to move.** No layout animation on scroll, no reflow when a
   thumbnail arrives, no hover effect that changes an element's size.
3. **One primary surface at a time.** Grid or preview, never a modal over a modal. The sidebar
   and inspector stay put and stay usable while the middle changes.
4. **Every action has a keyboard path.** The mouse is the discovery mechanism; the keyboard is
   how the interface is actually used after a week.
5. **State is legible.** A filtered view says what filtered it. An empty grid says why it is
   empty. A running job says what it is doing and how far along it is.
6. **Never lie about progress.** No indeterminate spinner where a count is available; no
   progress bar that reaches 100% and then waits.

## 1. Layout

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Toolbar   [☰] [ search — RQL ................ ]        [view ▾]     [+]    │
├──────────────┬──────────────────────────────────────────┬──────────────────┤
│              │                                          │                  │
│   Sidebar    │              Content                     │    Inspector     │
│              │   icons · compact · details · preview    │                  │
│  ┌────────┐  │                                          │   selection      │
│  │library │  │                                          │   details and    │
│  └────────┘  │                                          │   edits          │
│  Places      │                                          │                  │
│  Folders     │                                          │                  │
│  Smart       │                                          │                  │
│  Tags        │                                          │                  │
│              │                                          │                  │
├──────────────┴──────────────────────────────────────────┴──────────────────┤
│  Status bar   96,666 assets · 3 selected     ▸ thumbnails 41,208 / 96,666  │
└────────────────────────────────────────────────────────────────────────────┘
```

**Regions and their rules**

| Region | Width | Collapsible | Notes |
| --- | --- | --- | --- |
| Toolbar | full | no | Fixed height. Search is the widest thing in it. |
| Sidebar | 220–420px, drag to resize | yes, `F9` | Remembers width and collapsed state per library. |
| Content | fills | no | Hosts exactly one of: icons, compact, details, preview. |
| Inspector | 280–480px, drag to resize | yes, `F4` | Renders nothing when the selection is empty — not an empty shell. |
| Status bar | full | no | Counts on the left, background jobs on the right. |

**The preview is a pane, not a lightbox.** It replaces the content region, leaving the sidebar
and inspector in place and usable — a note can be written while looking at the thing it is
about. The grid stays mounted underneath rather than unmounted and rebuilt, so closing the
preview returns to the exact row, with its loaded pages and its measurements intact. This is
carried over as a decision, not rediscovered: `roost-old` shipped it as an overlay first and
changed it for these reasons.

**Window chrome.** The system frame is used in v1 — no client-side decorations. Frameless
Electron windows are the usual look, and they are also the usual way to break tiling window
managers, HiDPI scaling, and every GTK theme that draws its own shadows. Revisit only with a
Linux-desktop argument, not an aesthetic one.

## 2. Design tokens

All tokens are CSS custom properties declared in **one** file. `pnpm build` fails on any
`var(--token)` that nothing declares. There is no undefined-variable error in CSS — the
declaration is silently dropped — and in `roost-old` exactly one such typo made the preview
pane fully transparent while it was still covering the grid: every thumbnail behind it showed
through the picture that had been opened. TypeScript could not see it and no test touched it.
**Write the check before the first component.**

### 2.1 Colour

Neutral-first, defined as a ramp so that both themes are the same design with the ramp
reversed. Dark is the default; light is a first-class alternative, not an afterthought.

```
--gray-{0…12}     achromatic ramp, 0 = page background in dark, 12 = page background in light
--accent-{…}      exactly one hue, used for focus, selection, and primary actions — nothing else
--danger-{…}      destructive confirmation only
--warning-{…}     capability-missing and degraded states
```

Semantic tokens are what components use. A component that references `--gray-4` directly is a
review failure; it references `--surface-raised`.

```
--bg                  --surface              --surface-raised      --surface-overlay
--border              --border-strong        --border-focus
--text                --text-muted           --text-subtle         --text-inverse
--select-bg           --select-border        --select-text
--accent              --accent-hover         --accent-text
--shadow-1            --shadow-2
```

Theme is applied as `data-theme="dark" | "light"` on the root, defaulting to the system
preference and overridable in preferences. **No component may hard-code a colour**, including
`#fff`, `black`, and `rgba(0,0,0,.5)`.

Contrast floors: body text 4.5:1, muted text 4.5:1 (muted is a *hue* choice, not an excuse to
go below the floor), non-text UI boundaries 3:1.

### 2.2 Space, size, radius

A 4px base. `--space-1` through `--space-12` map to 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80,
96. Nothing uses a raw pixel value except a 1px border and an optical nudge, and an optical
nudge gets a comment.

Radius: `--radius-sm` 4px (inputs, chips), `--radius-md` 8px (cards, panels), `--radius-lg`
12px (dialogs), `--radius-full`.

Two densities, `comfortable` (default) and `compact`, applied as `data-density` on the root and
implemented by re-declaring a handful of tokens — row heights, control heights, gutters — never
by conditional class names in components.

### 2.3 Type

One family for UI, the system UI stack, no webfont — invariant 7 forbids a network request and
bundling a font for chrome is weight for nothing. One monospace stack for hashes, dimensions,
byte counts, and RQL.

```
--font-ui            --font-mono
--text-xs   11px/16    labels, metadata keys
--text-sm   12px/18    secondary, status bar
--text-base 13px/20    body — this is a desktop app, not a webpage
--text-md   15px/22    panel headings
--text-lg   18px/26    empty-state headings
```

Numbers that are compared vertically — sizes, dimensions, dates in the list view — use
tabular figures.

### 2.4 Motion

`--ease-out` for entrances, `--ease-in-out` for state changes, and two durations: `--dur-fast`
120ms for anything under the cursor, `--dur-base` 200ms for panels. Nothing exceeds 200ms.

**Never animate:** grid cell position, cell size, image opacity on load, scroll position, or
anything during an active scroll. `prefers-reduced-motion: reduce` collapses every duration to
0ms through the token, so no component needs to know about it.

## 3. Components

The inventory, with what each one owes. "Owns state" means it holds state no parent needs.

| Component | Region | Owns state | Notes |
| --- | --- | --- | --- |
| `AppShell` | — | panel sizes, theme | Grid template, resize handles, keyboard scope root |
| `LibraryPicker` | full screen | — | First run and library switching. Recent list, create, open |
| `RecentList` | picker | — | The libraries this machine has opened. Pin, forget; §3.1 |
| `Toolbar` | toolbar | — | Composes the four below |
| `SearchField` | toolbar | draft text | RQL input; §5 |
| `ViewMenu` | toolbar | — | One button, one menu: the views, the proportion checkbox, zoom, sort, grouping. ADR-0018 |
| `AssetContextMenu` | content | — | Right-click on the selection; §3.3. Native menus were considered and rejected; ADR-0021 |
| `NavTree` | sidebar | expansion | One component for folders and smart folders; §4.2 |
| `TagList` | sidebar | expansion | Grouped, with counts |
| `AssetGrid` | content | scroll, pages | Virtualized; §6. Icons and compact are one component |
| `AssetCell` | content | — | `memo`, primitive props only |
| `AssetList` | content | scroll, pages | Details view; same paging hook |
| `PreviewPane` | content | — | Image, video, audio, PDF, fallback; §7 |
| `Inspector` | inspector | field drafts | Renders nothing on empty selection |
| `RatingControl` | inspector | — | 0–5, `null` is not 0 |
| `TagEditor` | inspector | draft | Typeahead over existing tags, creates on Enter |
| `NoteField` | inspector | draft | Autosaves on blur and after 1s idle |
| `MetadataTable` | inspector | — | Key/value, monospace values, copy on click. Since M4 it also carries duration, page count, and whatever the format's own backend reported — a font's family and style, a video's codec — labelled where the label is known and under the property's own name where it is not, so a new backend is visible before any interface code is written for it |
| `StatusBar` | status | — | Counts, and one row per running job |
| `ImportDropZone` | overlay | — | Whole-window drop target; appears only while dragging |
| `ContextMenu` | overlay | — | One implementation, driven by a descriptor |
| `Dialog` | overlay | — | Focus trap, Escape, one at a time |
| `Toast` | overlay | — | Non-blocking results and failures; never for progress |
| `EmptyState` | any | — | Heading, one sentence, at most one action; §8 |

Everything above is built in-repo on top of unstyled primitives (menus, dialogs, tooltips,
sliders) rather than a component kit with its own design opinions. The primitives are Radix,
chosen in ADR-0021 after measuring four candidates and investigating the native-menu path the
user asked for first.

### 3.1 The recent list

The picker's way back in. Application state rather than library state, for the reason ADR-0019
gives: this list is what *finds* a library, so it cannot live inside one.

- **Pinned first, then most recently opened.** Twelve unpinned entries are kept; a pinned entry is
  never evicted, which is how somebody says "this one always".
- **A library that has gone is shown and marked, not hidden.** Struck through, unopenable, with
  its own way to be forgotten. A list that quietly shrinks reads as the application having
  forgotten, and leaves the reader unsure whether they imagined the library or lost it.
- **Nothing at all on a first run.** No heading, no empty box (§8) — the picker is then exactly
  what it was before this existed.
- Relative times are coarse on purpose: "Yesterday", "3 days ago", and a date past a week. The
  question is which library, not how many hours.

### 3.2 The inspector over several assets

**The inspector edits the selection, not the focused asset.** Until 2026-08-30 it took one hash
and every edit sent it alone, so selecting five assets and adding a tag tagged one — reported
from real use, and invisible to any test that only asked whether the tag arrived.

One asset and several are the **same components** given different data. `Rating`, the favourite
button and `TagEditor` all take a list of hashes and never learn how long it is, which is what
stops the bug returning for one path and not the other.

**What a multi-selection shows**

| Control | Over several assets |
| --- | --- |
| Heading | `3 assets` in place of the name field |
| Rating | The rating they share; `mixed` beside empty stars when they disagree. Clicking the shared rating clears it, as for one asset; a mixed selection has nothing to clear, so a click always sets |
| Favourite | Filled when all are, empty otherwise. Clicking a `none` or `mixed` state favourites everything — the destructive reading needs the explicit `all` state to reach |
| Tags | Tags **all** of them carry, then tags **some** carry, drawn apart and labelled. Adding applies to everything; removing a partial tag is the same call, since the engine ignores an asset that does not carry it |
| Metadata | Total size and the commonest kinds. Nothing per-asset |

**What it deliberately does not show**, each for its own reason:

- **No name field.** A name belongs to one asset.
- **No note.** A note is a paragraph about one thing; writing one across twelve would silently
  destroy eleven.
- **No preview.** One asset's picture above controls that edit all of them is exactly the
  misreading this panel exists to correct.
- **No "Open externally".** Handing twenty files to the desktop is more than a click's worth of
  consequence.

**One request, not one per asset.** `asset:summary` takes the whole selection and answers with
the aggregate. A selection is routinely hundreds of rows, and a detail each would be hundreds of
round trips for a panel that shows a summary of them.

### 3.3 The asset context menu

Right-click on the grid, or on an open preview. Over the grid it acts on the **selection**,
never on the asset the pointer is over —
right-clicking an asset that is not selected selects it first, and right-clicking one that is
leaves the selection alone, which is what every file manager does and what makes "select twelve,
export twelve" one gesture. `Grid` does the selecting, because it is the component that knows
what is under the pointer; the menu only ever receives a list of hashes.

**In the preview the menu is over the asset on screen**, whatever else is selected. There is
nothing else to point at, and "export…" while looking at one picture cannot sensibly mean the
other eleven. Selecting three and pressing `Enter` is the case that makes the two rules
distinguishable, and it is the one the regression test drives.

**Closing the menu gives focus back to what it was opened over.** Radix returns focus to its
trigger, which here is a plain wrapper with no `tabindex`, so focus would land on the body — with
the grid's roving ring and the preview's stepping both dead until something is clicked.

| Item | Over one | Over several |
| --- | --- | --- |
| **Open** | hands the file to the desktop's own handler | disabled — three files is three applications opening |
| **Show in file manager** | reveals it, selected | disabled, same reason |
| **Copy path** | one path | `Copy N paths`, one per line |
| **Export…** | a directory chooser, then a copy out | `Export N assets…` |
| **Move to trash** | disabled pending ADR-0022 | disabled |

**Nothing here hands a path to the renderer.** Open, reveal, and copy are all answered by main,
which resolves the hash, acts, and returns a boolean. Copying is the one case where a path
reaches a person — they asked for it, and it goes to the clipboard rather than into the sandbox.

**Export is the only place Roost writes into a user's directory**, and it does so under two
conditions that make it the opposite of the pattern `STORAGE_SPEC.md` forbids: the user picked
the directory in a dialog, and nothing inside the library is moved, modified, or removed. Files
land under the name the library shows, not the content-addressed one — a folder of hashes is not
an export anyone wanted — and a name the destination already holds gets a numbered suffix. The
status bar says how many were renamed, because a silent rename means the file they go looking
for afterwards is not called what they expect.

**Results go to the status bar, not to a dialog.** An export that worked is not worth
interrupting anyone for, and one that partly did not is not worth losing. The line clears when
the selection changes, which is the next thing a person does after acting on one — so it needs no
timer, and nothing vanishes while it is still being read.

## 4. Navigation

### 4.1 What the sidebar contains

```
Library ▾                        library switcher, and where "Open library…" lives

PLACES
  All assets                     everything, newest first
  Recent                         imported in the last 7 days
  Favorites
  Untagged                       the pile that needs work — the reason this is here
  Trash                          ADR-0022, and the count is what makes it worth a row

FOLDERS                          user tree, drag to reorder and re-parent
  ▸ Clients
    ▾ Acme
        Logos              412
SMART FOLDERS                    saved RQL
  Recent PNGs               1.2k
TAGS                             grouped, groups collapsible
  ▾ Materials
      wood                   88
      metal                  41
  (ungrouped)
      wip                    12
```

Counts are subtree counts for folders and match counts for smart folders, computed by the
engine — the renderer never counts anything it did not receive.

**Every row carries the RQL that selects it**, built in `@roost/library`. The renderer never
assembles a query string; clicking `Logos` sends the row's query to the search field, which is
why the search field always shows what is actually being asked. This is carried over from
`roost-old` and it is the single decision that keeps the search bar honest.

### 4.2 Selection versus filtering

Clicking a sidebar row **replaces** the query. Ctrl-clicking a second row **adds** its term
with an implicit `AND`, and the search field shows the compound query. There is no separate
filter state that the search field does not know about — one source of truth for "what is on
screen", and it is a string the user can read and edit.

## 5. Search

The field takes RQL (`DATA_MODEL.md` §3). It is the primary control in the toolbar and the
widest.

- **Validates before it applies.** A half-typed query leaves the grid alone. The parse error
  appears under the field with a caret at the byte offset the parser reported — not a red
  border and not a toast.
- **Applies on a 250ms idle**, and immediately on Enter.
- **Autocomplete** for field names, then for values once a field is typed: `tag:` offers tags,
  `folder:` offers folders, `ext:` offers the extensions actually present in this library.
- **Chips, optionally.** A toggle renders the parsed query as removable chips above the grid
  for people who do not want to edit a string. The string stays the source of truth; the chips
  are a view of the AST.
- **Save as smart folder** from the field, which is where a saved query naturally comes from.
- The match count for the current query appears in the status bar, estimated above 10,000 and
  exact on click.

## 6. The grid

This is the performance-critical surface. `ARCHITECTURE.md` §4.6 and `CLAUDE.md` §8 carry the
rules; this section is the component contract that implements them.

**Three views and a modifier, one paging hook.** The view control is a menu in the file
manager idiom rather than a row of layout buttons — ADR-0018 carries the reasoning and the
menu's exact shape. Every view shares the keyset paging described in `DATA_MODEL.md` and
differs only in layout.

| View | `Ctrl+1..3` | Layout |
| --- | --- | --- |
| **Icons** (default) | `Ctrl+1` | Square cells, filled row-major so result order reads left to right |
| **Compact** | `Ctrl+2` | A small thumbnail with the name beside it, in short rows across several columns |
| **Details** | `Ctrl+3` | A table with a header row: name, size, kind, dimensions, imported |

**Match image proportions**, a checkbox under Icons, is the masonry layout. It is a property of
how an icon is shaped rather than a fourth view, because that is what it always was — and it is
the only layout here that does not crop, which matters in an application for looking at
pictures. Cells take their height from the asset's own aspect ratio and pack into the shortest
column.

**Every view scrolls vertically, including Compact.** A file manager's compact view flows *down*
a column and wraps to the next, which means scrolling sideways. Here it wraps the other way.
Two scroll axes in one window is jarring, and the culling, the prefetch, and the roving ring are
all written against `y` — a horizontal view would be a second virtualisation, not a second
layout. Decided when Compact was built, on 2026-08-30.

**Details has a header row**, and it sits **outside** the scroller rather than sticking to the
top of it. Cells are absolutely positioned from `y = 0`, so a sticky row inside would cover the
first one, and offsetting every tile to make room would put a view's decoration into the layout
arithmetic. Its columns use the same track template as a details cell, so the labels sit over
the columns they name — which costs two things, both found by measuring a real window on
2026-08-30 and neither visible to a test:

- The track list is in `px`, not `em`. The header draws at `--text-sm` and a row at
  `--text-base`, so the same `em` track is two different widths in the two places that have to
  line up, and the drift accumulates left to right.
- The header is as wide as the frame; the rows are as wide as the scroller's content, which is
  narrower by the strip `scrollbar-gutter: stable` reserves. The header gives that strip back as
  right padding, from a width the grid measures and writes as a custom property — CSS cannot
  name it, and it is a platform constant rather than a state to track.

**Zoom** is the cell target, 120–400px, snapped to seven steps. `layout()` has taken it as a
parameter since M3; the menu is the first thing to pass anything but a constant. The three
controls are one row on one menu line, and **selecting one does not close the menu** — zooming
twice should not cost two trips. Each is a real menu item underneath, because a bare button
inside the content would be reachable by pointer and by nothing else (§10).

**Sort By** and **Group By** are in the menu, disabled, because that is where a person looks for
them and an absent item teaches nothing. Neither is a renderer change: the application has exactly one order — `imported_at DESC, hash` —
and keyset paging plus every composite index in migration 0005 is built on it. Each sort key
needs its own index per filter and its own cursor. See ADR-0018.

**Common to every view.** Column count derives from the scroller's **content** width — not
`clientWidth`, which includes the scroller's own padding and made every view one gutter too
wide, running the last column under the scrollbar with its edge cut off. The zoom target sets
how wide a column wants to be; the filename is a reserved band under the thumbnail, never an
overlay on it. An asset with no recorded dimensions is laid out at 1:1 and re-laid out once
metadata arrives — the only reflow the grid is permitted, and it happens off-screen when the
derive queue is keeping up.

**Cell contract, non-negotiable:**
- `AssetCell` is `memo`'d and receives only primitives: `hash`, `ext`, `width`, `height`,
  `name`, `isSelected`, `isFocused`. No objects, no closures, no callbacks constructed inline.
- Callbacks come from a stable module-level dispatcher keyed by hash, not from props.
- Selection and hover live in a store outside the cell tree with per-cell subscriptions.
  Selecting one item must not re-render ten thousand cells.
- No context provider whose value changes on scroll wraps the grid.
- Scroll and resize handlers are throttled to animation frames and never `setState` per event.
- The thumbnail is `<img loading="lazy" decoding="async" src="roost://thumb/…@256">`. Image
  bytes never pass through React state, and the placeholder is drawn **underneath** the image
  rather than swapped in from `onError` — a handler would need a piece of state per cell, and
  the state would have to be reset every time the cell is recycled to a different asset. Drawn
  underneath, a thumbnail that has not arrived and one that never will look the same, and
  neither costs a render.
- **The placeholder is a first-class cell, not a broken one.** A library is not only media
  (`CONCEPT.md` §5), so a `.blend` or a `.zip` is an ordinary member of the grid: the extension
  set in the monospace stack, legible at the smallest zoom, over the surface colour — never a
  broken-image glyph and never an empty box.

**Selection model.** Click selects; `Ctrl`-click toggles; `Shift`-click extends from the anchor;
drag on the background marquee-selects; `Ctrl+A` selects the loaded set and says so, because
"select all" over 900,000 unloaded rows is a promise the grid cannot keep.

**Focus.** The grid is one tab stop with a roving focus ring. Arrow keys move focus; `Space`
toggles selection; `Enter` opens the preview. Focus and selection are separate — moving focus
with `Ctrl` held does not change the selection.

**The frame budget is an acceptance criterion, not a later optimisation.** A scroll benchmark
mode drives the grid and prints frame percentiles, and refuses to print a number when the
window was not being composited. `roost-old` measured no dropped frames at reading speed and
0.25% while flinging through 79,800 assets, on a weaker webview than Chromium. That is the bar.

## 7. Preview

Opens on `Enter` or double-click, into the content region. Arrow keys step through the loaded
list, and **stepping changes the selection**, so the inspector follows what is on screen — in
`roost-old` it did not, and a note could be written onto the wrong asset.

| Kind | Renders as |
| --- | --- |
| Image | `<img src="roost://original/<hash>">`, fit to pane, click to toggle 1:1, drag to pan |
| SVG | Same, sandboxed — scripts in an SVG do not run |
| Video / audio | `<video>` / `<audio>` over `roost://original/`, which answers range requests |
| PDF | Page-through: `PageUp` / `PageDown` and two buttons, each page an `<img>` over `roost://page/<hash>/<n>@1024`. Arrow keys keep stepping between assets, so a document does not trap the keyboard |
| Font | The specimen sheet the derive pass drew, with the family and style under it |
| Anything else | The thumbnail, the metadata, and **Open externally** |

**Open externally** hands the file to the desktop's own handler. A Roost library is not only a
media collection, and a format Roost cannot draw should not be a dead end.

## 8. States

Every surface owes four states, and the empty one is where most applications get lazy.

**A cell with no thumbnail is a state too.** Three things look identical in a grid — work that
has not been done yet, a format nothing in this build draws, and a video waiting for an ffmpeg
nobody installed — so the status bar names which one it is: *"Deriving… 42 to go"*, *"3 without a
preview"*, or the capability's own line with a **Try again** beside it. Only the third has a
button, because it is the only one a person can act on.

**Empty.** Heading, one sentence explaining *why it is empty*, at most one action.
- No library open → the picker, with "Create library" and "Open library".
- New library, nothing imported → "Drop files here, or import a folder."
- A folder with no assets → "Nothing in Logos yet." Drop target stays live.
- A query with no matches → "No assets match `tag:blue rating:>=4`." with the offending
  query rendered in monospace and a "clear filter" action. Never a generic "no results".
- A parse error → handled at the field (§5), never as an empty grid.

**Loading.** Skeleton cells at the right sizes, not a spinner, and only after 150ms — anything
faster reads as a flash. The first page target is under 450ms on 100k assets.

**Error.** Inline where the thing failed, with the operation named. A failed import shows which
files failed and why, in a list that can be copied. Errors carry the `code` from `RoostError`
so a bug report has something to grep for.

**Degraded.** A missing optional capability is a state, not an error: "Install ffmpeg for video
thumbnails" in the status bar, once, dismissible, and the assets still import.

## 9. Keyboard map

Modifier is `Ctrl` on Linux and Windows, `⌘` on macOS. This is the map the app ships with; it
becomes a preference in M6.

| Key | Action |
| --- | --- |
| `Ctrl+F` / `/` | Focus search |
| `Escape` | Clear search focus · close preview · close menu · clear selection, in that order |
| `Ctrl+1` / `Ctrl+2` / `Ctrl+3` | Icons · Compact · Details (ADR-0018) |
| `F9` / `F4` | Toggle sidebar · inspector |
| `Ctrl+N` | New window onto the same library (ADR-0020) |
| `Ctrl+O` | Open library |
| `Ctrl+I` | Import files… |
| `Ctrl+Shift+I` | Import folder… |
| `Arrows` | Move focus in the grid |
| `Space` | Toggle selection of the focused cell |
| `Enter` | Open preview |
| `Ctrl+A` | Select all loaded |
| `Ctrl+D` | Deselect all |
| `0`–`5` | Set rating on the selection (`0` clears to unrated) |
| `F` | Toggle favourite |
| `T` | Focus the tag editor for the selection |
| `Delete` | Move to trash (ADR-0022). Until that lands, the menu item is present and disabled |
| `Ctrl+Delete` | Remove from the current folder only |
| `[` / `]` | Zoom cells down · up |
| `Ctrl+K` | Command palette (**M6**) |

## 10. Accessibility

Not a milestone; a constraint on every component.

- The grid uses `role="grid"` with `aria-rowcount`/`aria-colcount` reflecting the *total*, not
  the rendered window, so a screen reader is not told the library holds forty items.
- One tab stop per region, roving focus inside. Tab order follows the visual order.
- Focus is always visible, uses `--border-focus`, and is never removed — `:focus-visible` may
  narrow *when* it shows, never *whether*.
- Every icon-only control has an accessible name and a tooltip with the same text.
- Colour never carries meaning alone: selection has a border as well as a fill, ratings are
  countable, capability warnings carry an icon.
- Dialogs trap focus, restore it on close, and close on `Escape`.
- `prefers-reduced-motion` and `prefers-contrast` are honoured through tokens.
- Text scales to 200% without clipping. The grid may show fewer columns; nothing may overlap.

## 11. What is deliberately not here yet

Named so that their absence is a decision rather than an oversight: command palette (M6),
timeline view (M5), duplicate review (M5), colour picker filter (M5), on-image annotation
(not scheduled), multi-window (not scheduled), and a plugin surface (not scheduled).
