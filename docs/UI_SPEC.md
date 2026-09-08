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
┌──────────────┬──────────────────────────────────────────┬──────────────────┐
│ [☰] library  │ [ search — RQL ....... ] [view ▾] [+ Add ▾] │              │
│              ├──────────────────────────────────────────┤                  │
│   Sidebar    │              Content                     │    Inspector     │
│              │   icons · compact · details · preview    │                  │
│  Places      │                                          │   selection      │
│  Rating      │                                          │   details and    │
│  Folders     │                                          │   edits          │
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
| Sidebar head | with the sidebar | with it | Fixed height. The `☰` (ADR-0028) and the library's name. |
| Content head | with the content | no | Fixed height. Search is the widest thing in it, then the view control and **Add**. |
| Sidebar | 220–420px, drag to resize | yes, `F9` | Remembers width and collapsed state per library. |
| Content | fills | no | Hosts exactly one of: icons, compact, details, preview. |
| Inspector | 280–480px, drag to resize | yes, `F4` | **Always drawn.** An empty selection gets the empty state from §8, never a shell of disabled controls. Reserves a scrollbar gutter, as the grid does: how tall its content is depends on the asset, so without one the panel's fields shift sideways as the selection moves. |
| Status bar | full | no | Counts on the left, background jobs on the right. |

**There is no toolbar across the window: the three columns run from the top down.** The head of
each column belongs to that column — the menu and the library's name sit above the sidebar because
they are the library's, the search field and the view control sit above the content because they
are the grid's, and the inspector has no head at all and starts at the top. A bar spanning
everything makes the panels look like drawers under a chrome that owns them; they are not, and
the arrangement Eagle uses is the one that says so. The status bar does still span the window,
because what it says — the library's counts, the running jobs — is about all three.

**A drop while a film is open is offered to the film first** (ADR-0025): subtitle files attach to
it as caption tracks and everything else imports. The overlay says so, because it cannot say what
the drag holds — Chromium reports no filename until the drop lands, so the sentence describes what
is on screen rather than what is in the hand.

**The preview is a pane, not a lightbox.** It replaces the content region, leaving the sidebar
and inspector in place and usable — a note can be written while looking at the thing it is
about. The grid stays mounted underneath rather than unmounted and rebuilt, so closing the
preview returns to the exact row, with its loaded pages and its measurements intact. This is
carried over as a decision, not rediscovered: `roost-old` shipped it as an overlay first and
changed it for these reasons.

**There is no menu bar** (ADR-0028). Electron installs one by default — File · Edit · View ·
Window — and it carried a Reload that throws away the query and the selection, a devtools toggle,
and a Paste meaning something other than Roost's (§3.3). It is removed on Linux and Windows, and
the commands that belong to the application live in the toolbar's `☰` instead: **Reclaim space…**,
**Close library** and **Quit**, and nothing that already has a home. Reclaiming is there because it
acts on the whole library rather than on anything selected (ADR-0031); it is not in the Trash
place, because a permanent delete takes its own bytes with it and the trash is therefore not where
an orphaned object comes from. It shows three different things: nothing to reclaim, a refusal with
the reason the index cannot be trusted, or a confirmation naming the size — and it re-checks before
deleting anything, because the numbers on screen are a screenful old and this deletes files. **Add** stays on the bar because bringing
something in is the primary action of an empty library, the view control stays on the bar because
it is ADR-0018's, and per-asset commands stay in the context menu — a menu that repeats the toolbar
teaches people to look in two places and to trust neither. macOS keeps a menu bar, because there it
belongs to the system rather than to the window.

**Add is the one control that brings an asset in**, and it names the four ways rather than one of
them. It was a bare **Import…** button, which is the door somebody arriving with a folder wants and
hides the other three entirely: making a file and pasting lived only in the context menu over the
grid's empty space — a place nobody right-clicks in an application they have just opened, and one
that is not reachable at all while a file is on screen.

| Item | Behaviour |
| --- | --- |
| **New file…** | The dialog of §3.4, with an empty name |
| **New text document…** | The same dialog, with `.txt` already typed and the caret in front of it |
| **Import files…** | A file chooser. `Ctrl+I` |
| **Import folder…** | A directory chooser. `Ctrl+Shift+I` |
| **Import from Eagle…** | A directory chooser for one Eagle library, then §3.8 |

**The two import items are two dialogs, not one dialog filtered.** A chooser given both `openFile`
and `openDirectory` is drawn as a *file* chooser on GTK, macOS and Windows alike, and merely permits
a directory to be selected in it — so importing a folder meant navigating to that folder's **parent**
and clicking it there, which is the one view that does not show what is inside it. Asking which was
meant costs a menu item and buys a chooser that behaves. Both take a multiple selection.

**Import from Eagle… sits in the same group and carries no accelerator.** It is an import, and the
group is where the bytes come from; a third keystroke would be an arbitrary one for something
somebody does once. Its chooser takes exactly **one** directory where the other two take several,
because an Eagle library is a whole thing with a folder tree and a tag vocabulary of its own — two
at once would raise which tree the folders belong to.

**Add is not a File menu.** ADR-0028 removed the menu bar and put the application's own commands in
the `☰`; this is not that returning under another name. Nothing joins this menu that acts on an
asset, because an asset that exists has a context menu, and nothing joins it that has a home
elsewhere.

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
--marquee-bg          --marquee-border
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

### 2.5 Scrollbars

The scrollbar is drawn, not inherited. Unstyled, Chromium gives Linux a 15px bar with a stepper
at each end and a thumb brighter than anything in the grid it is scrolling — the one widget in
the window that ignored `data-theme` entirely, so the dark library and the light one had the
same grey column down the right edge.

```
--scrollbar-size     12px, 10px in compact — the strip a scroller reserves
--scrollbar-inset    the transparent border that makes the thumb a pill inside that strip
--scrollbar-thumb    --scrollbar-thumb-hover     --scrollbar-thumb-active
```

- **The track is transparent**, so a bar shows the surface it rides on rather than adding a
  column of its own to the sidebar, the grid, and the inspector alike.
- **The thumb is a pill**, inset from the strip by a transparent border with the background
  clipped to the padding box — a thumb takes no margin, and the strip has to stay wide enough
  to grab even when what is drawn in it is narrow.
- **No steppers.** Two targets for one line of travel.
- **Under the hand it brightens and thickens**, by shrinking that border. The strip does not
  change width, so nothing reflows — which is the rule from §2.4 applied to the one control
  that lives on a scroll.

Written as `::-webkit-scrollbar`, not `scrollbar-color`. The two are exclusive — a
`scrollbar-width` other than `auto` makes Chromium drop the pseudo-elements — and the standard
properties can neither round the thumb nor inset it. The renderer is Chromium by construction
(ADR-0001), so no portability is spent.

`--scrollbar-size` is what the strip is *asked* to be. `grid.css` also carries a `--scrollbar`,
which is what it *measured* on a live element (§6); they are different facts and keep different
names.

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
| `AddMenu` | toolbar | — | One button, one menu: the four ways an asset comes into being. §1 |
| `AssetContextMenu` | content | — | Right-click on the selection; §3.3. Native menus were considered and rejected; ADR-0021 |
| `NavTree` | sidebar | — | Smart folders and the flat sections; §4.2 |
| `Folders` | sidebar | — | The one section that is a tree: disclosure arrows, a `+` in its heading, and a right-click menu. Expansion is the window's, so a new subfolder can be revealed; ADR-0033 |
| `FolderDialog` | overlay | draft | Naming a folder, for both **New folder** and **Rename**. The engine refuses a bad name; the dialog draws its message and stays open |
| `TagList` | sidebar | expansion | Grouped, with counts |
| `AssetGrid` | content | scroll, pages | Virtualized; §6. Icons and compact are one component |
| `AssetCell` | content | — | `memo`, primitive props only |
| `AssetList` | content | scroll, pages | Details view; same paging hook |
| `PreviewPane` | content | — | Image, video, audio, PDF, fallback; §7 |
| `Transport` | content | position, loop | The player's own controls, over a `<video controls={false}>`. Timeline, buffered ranges, volume, fullscreen, picture-in-picture, the comment marks, and what the native bar withholds — frame stepping, playback rate, an A-B loop; §7. ADR-0024 |
| `Inspector` | inspector | field drafts | Always drawn; empty selection gets §8's empty state |
| `FilterBar` | content | menu open, search draft | Tags, rating and file type over the grid, then **Show subfolder contents**. A **view of the query**: read with `query:split`, written with `query:join` and `query:subfolders`. Tags carry an Any/All rule the window remembers where the query cannot hold it; the depth falls back to the library's setting the same way. §4.4. ADR-0035, ADR-0036 |
| `NameField` | inspector | draft | The panel's heading, and the only editable name. Holds the **stem**: the extension is not editable and is not shown here. **Wraps over as many lines as the name takes**; `Enter` commits and a name never holds one. §3.10 |
| `RatingControl` | inspector | — | 0–5, `null` is not 0 |
| `TagEditor` | inspector | draft | Typeahead over the tags the library already has, creates on Enter. §3.7 |
| `FolderEditor` | inspector | — | The folders the selection is in, with an `×` each, and a menu of the whole tree to add one. Creates nothing. §3.9 |
| `NoteField` | inspector | draft | Autosaves on blur and after 1s idle |
| `SourceField` | inspector | draft | Where the file came from. One line, saves on blur, idle, and `Enter`; offers to open only an `http(s)` value. §3.6. ADR-0030 |
| `Comments` | inspector | drafts | Several comments where the note is one; each may carry a moment. §3.5 |
| `MetadataTable` | inspector | — | Key/value, monospace values, copy on click. Since M4 it also carries duration, page count, and whatever the format's own backend reported — a font's family and style, a video's codec — labelled where the label is known and under the property's own name where it is not, so a new backend is visible before any interface code is written for it. **Labels are qualified where two properties would otherwise share one**: `Video codec` and `Audio codec`, never two rows both saying `Codec` |
| `StatusBar` | status | — | Counts, and one row per running job |
| `ImportDropZone` | overlay | — | Whole-window drop target; appears only while dragging |
| `ContextMenu` | overlay | — | One implementation, driven by a descriptor |
| `Dialog` | overlay | — | Focus trap, Escape, one at a time |
| `ConfirmDialog` | overlay | — | An alert dialog, not a panel: no close button, no dismiss on an outside click, focus starts on Cancel. Irreversible actions only; §3.4 |
| `Toast` | overlay | — | Non-blocking results and failures; never for progress |
| `EmptyState` | any | — | Heading, one sentence, at most one action; §8 |

Everything above is built in-repo on top of unstyled primitives (menus, dialogs, tooltips,
sliders) rather than a component kit with its own design opinions. The primitives are Radix,
chosen in ADR-0021 after measuring four candidates and investigating the native-menu path the
user asked for first.

### 3.1 The recent list

**The picker carries the wordmark**, not the word: `assets/brand/roost-logo-dark.svg` in place of
an `<h1>` with "Roost" in it. The dark variant, because the window pins a dark theme
(`TODO.md` §3); when the theme follows the system, this becomes a pair. The heading keeps its
level and the name lives in the image's `alt`, so nothing is lost to a reader that does not draw
pictures. That directory's `README.md` says which file is for what.


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

One asset and several are the **same components** given different data. `Rating` and `TagEditor`
both take a list of hashes and never learn how long it is, which is what stops the bug returning
for one path and not the other.

**What a multi-selection shows**

| Control | Over several assets |
| --- | --- |
| Heading | `3 assets` in place of the name field |
| Rating | The rating they share; `mixed` beside empty stars when they disagree. Clicking the shared rating clears it, as for one asset; a mixed selection has nothing to clear, so a click always sets |
| Tags | Tags **all** of them carry, then tags **some** carry, drawn apart and labelled. Adding applies to everything; removing a partial tag is the same call, since the engine ignores an asset that does not carry it |
| Folders | The same rule, and the same two halves: folders all of them are in, then folders some are in. §3.9 |
| Metadata | Total size and the commonest kinds. Nothing per-asset |

**What it deliberately does not show**, each for its own reason:

- **No name field.** A name belongs to one asset.
- **No note, and no source.** A note is a paragraph about one thing and a source is one thing's
  answer to where it came from; writing either across twelve would silently destroy eleven.
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

**The first row is what a double-click does.** Both ways to open are always there, and their order
says which one the gesture takes: **Open** first for a file Roost can draw, **Open externally**
first for one it cannot (§6). One function decides both, because a menu whose first row disagrees
with the shortcut teaches the wrong thing. Over several assets there is no double-click to agree
with, so the rows keep their natural order and both are disabled.

**In the preview there is no Open row at all** — it is already open, and a row that did nothing
would be worse than a missing one.

**In the preview the menu is over the asset on screen**, whatever else is selected. There is
nothing else to point at, and "export…" while looking at one picture cannot sensibly mean the
other eleven. Selecting three and pressing `Enter` is the case that makes the two rules
distinguishable, and it is the one the regression test drives.

**Closing the menu gives focus back to what it was opened over.** Radix returns focus to its
trigger, which here is a plain wrapper with no `tabindex`, so focus would land on the body — with
the grid's roving ring and the preview's stepping both dead until something is clicked.

| Item | Over one | Over several |
| --- | --- | --- |
| **Open** | opens it here, in the preview. Disabled for a file Roost cannot draw — there is nothing to open | disabled — a preview shows one asset |
| **Open externally** | hands the file to the desktop's own handler | disabled — three files is three applications opening |
| **Show in file manager** | reveals it, selected | disabled, same reason |
| **Copy path** | one path | `Copy N paths`, one per line |
| **Export…** | a directory chooser, then a copy out | `Export N assets…` |
| **Move to trash** | reversible, so it asks nothing | `Move N assets to trash` |

**Two more rows over a video that is playing** (ADR-0024 stage 4): **Set this frame as the
thumbnail** takes the moment the transport is at, and **Use the default frame** puts it back. They
are drawn only when there is a video player on screen — over the grid there is no frame to point
at, and audio has none at all — and only over one asset, because one frame belongs to one video.
The test for "has frames" is the element's own `requestVideoFrameCallback`, not its tag name.

Neither draws a picture: the engine journals the moment, redraws both thumbnails from it, and the
status bar says what happened, because the cell changes a beat later and a gesture with no visible
result reads as a gesture that failed. **Use the default frame** is drawn beside the other whether
or not a moment is set — the engine writes nothing when the thumbnail is already on the default
frame, and a menu whose rows appear and vanish with state nothing on screen shows is a menu people
misread.

**Over the grid's empty space the menu is a different menu** (ADR-0026 §4, §5). Nothing is
selected, so nothing can be acted on — and the three things that make sense there are the three
ways to bring an asset into being:

| Item | Behaviour |
| --- | --- |
| **Paste** | Four gestures wearing one name. Files from a file manager are imported; image bytes are imported under a synthesised name (`Pasted 2026-09-04 14.22.08.png`), because `orig_name` cannot be null and there is no name to be had; text opens a draft; **a link does nothing at all** |
| **New file…** | Opens a dialog that asks for the name (§3.4) |

**The same two are in the toolbar's Add menu** (§1), because a right-click on empty space is a
gesture people who already know an application use, and this menu is not reachable while a file is
open. Paste is not: it is `Ctrl+V` and a context menu, which is where a paste belongs everywhere
else.

**An empty selection *is* the empty space.** Right-clicking a cell selects it first, so a menu with
nothing to act on can only have been opened over the background — no second detection, and no way
for the two to disagree.

**Pasting never fetches a link.** Invariant 7 permits exactly one network operation, an explicit
user-initiated import from a URL, and a fetch triggered by `Ctrl+V` is what that rule exists to
forbid. The status bar says so rather than the menu silently doing nothing.

**The clipboard is read in main.** The renderer has no ambient authority (invariant 11), and the
engine has no shell; what comes back over the contract is what was found and what was done about
it.

**Inside the Trash the last row is replaced, not extended.** `Move to trash` is gone there and
`Restore`, `Delete permanently`, and `Empty trash` take its place, so "delete" never means two
things in one menu. Which one applies is decided by comparing the query on screen against the one
the **engine** sent for the Trash row — the renderer assembles no RQL (§4.1), and a literal
`is:trashed` in a component would be a second copy of the grammar that nothing keeps in step.

| Item (in the Trash) | Behaviour |
| --- | --- |
| **Restore** | takes the selection back out of the trash. Asks nothing: it is the undo |
| **Delete permanently** | confirms, then removes the selection from the library **and deletes the files it owns** (ADR-0031). A referenced original is never touched |
| **Empty trash** | confirms, then removes everything the trash holds — which is not the selection, so the count comes back from the engine. **The sidebar's Trash row carries this one too** (§4.1), because reaching it here means standing in the Trash place first |

Both say what came back as well as what went: `Deleted 3 assets, freeing 3.0 MiB`. The freed bytes
are the half a person deleting to make room came for, and **zero is said too** — a selection of
referenced assets frees nothing, and a line that mentioned bytes only when there were some would
make that read as a failure to report rather than as a fact about those assets.

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

**An action that removes assets from the view clears the selection.** Trashing, restoring, and
deleting all take their assets out of the place they were selected in; a selection left naming
them says "1 selected" over a grid with nothing highlighted, keeps the inspector editing a
trashed asset, and leaves the roving ring with nowhere to go. Exporting does not clear it — an
export takes nothing off screen. Found by driving a real window on 2026-09-01, and invisible to
every component test, because no component owns a selection *and* a grid.

**Results go to the status bar, not to a dialog.** An export that worked is not worth
interrupting anyone for, and one that partly did not is not worth losing. The line clears when
the selection moves *away from* the one it was written against, which is the next thing a person
does after acting on one — so it needs no timer, and nothing vanishes while it is still being
read. Away from, not merely changes: the rule above clears the selection as part of trashing, and
a line wiped by any change is a line no destructive action can ever leave behind.

**Caption tracks are listed in the inspector, not in the sidebar.** A sidebar row is a *query*,
and a query cannot mean "the tracks of whatever is selected" — the inspector is the one surface
already about one asset. The block is drawn only where something is attached, one row per track
with its name and language, and three actions:

| Action | What it does |
| --- | --- |
| **Open** | Hands the track to the application that owns it — which is how a subtitle is edited, since Roost has no text editor |
| **Show in file manager** | Reveals the track's own file, selected |
| **Delete** | Detaches it **and** moves the file to the trash, in one batch |

**Delete, not "detach".** A detach that left the `.srt` behind in the grid as an ordinary text
asset was tried first and is the wrong half of the answer: somebody finished with a track is
finished with the file. It still means what `Delete` means everywhere else — the trash keeps the
row, nothing is emptied on a schedule (ADR-0022), and it asks nothing because it is reversible.
Restoring brings the file back; the attachment does not come with it, because that was a second
sentence and it was un-said.

**Each track takes two lines**: the name with its language beside it, and the actions under it.
Three buttons beside a filename wrap at any width worth having, and the inspector is the narrowest
surface in the window.

### 3.4 Confirming what cannot be undone

One dialog in the window, raised by whatever needs it — the context menu and the `Delete` key
both ask through the same code, because a shortcut that skipped a question the menu asks is the
version of this that ships by accident.

**Only irreversible actions get one.** Moving assets to the trash is undone by restoring them, so
it asks nothing; a dialog there would teach people to dismiss dialogs, and the next one would be
the permanent delete. Emptying the trash and deleting permanently both ask.

It is an **alert** dialog rather than a panel, and the three differences are the point: no close
button, no dismissal by clicking outside it, and focus starting on **Cancel**. The accident being
prevented is a stray click or a stray `Enter`, and a dialog either of those can confirm is
decoration. The confirming button says the verb — `Delete`, `Empty trash` — never `OK`, and it is
the only place the `--danger-` ramp is used (§2).

**A confirmation may carry a checkbox, and it is never a second confirmation.** Deleting a folder
is one gesture with two outcomes — the shelf alone, or the shelf and what is on it (ADR-0033) — and
the box chooses which rather than confirming that it happens. It starts unticked, because the
ticked answer is the one that touches assets, and the body says in words what each answer does.
Two menu items would have been the alternative, and *Delete folder* beside *Delete folder and its
contents* invites reading the shorter one as a safe abbreviation of the longer.

**A dialog that asks a question is not an alert dialog.** **New file…** (ADR-0026 §4) opens an
ordinary `Dialog`: it can be dismissed by clicking away and it starts with focus in the first
field, because there is nothing dangerous to guard against — the danger is losing what was typed,
and that is the user's own to weigh.

**It asks one thing: the name.** Typed, never defaulted — a file called `untitled` is a file
somebody has to rename — and the extension is part of it. `Enter` is the button, and **Create**
stays disabled until there is a name.

**New text document…** (§1) opens this same dialog with `.txt` in the field and the caret in front
of it. It is not a second kind of file — Roost has no file types, only bytes and a name — it is the
one guess the dialog can make, made where the menu has already said what was wanted. The prefill is
**not an answer**: **Create** stays disabled until something is typed in front of it, or the file
would be called `.txt`.

**The library holds one empty file however many are made**, and that is reported rather than
prevented: every empty file has the same hash, and `assets.hash` is the primary key, so the second
answers with the first under the first one's name. The status bar says so. An external editor
cannot fill one in afterwards either — originals are immutable and addressed by their content, so
editing outside writes bytes belonging to a *different* asset. Asking for contents as well was
tried on 2026-09-04 and withdrawn the next day: the dialog asks the question it does not know the
answer to, and no more.

Words from the clipboard become the contents without a field, because pasting has already said
what they are; the dialog says how many characters it is about to keep.

### 3.5 Comments, and the moment one points at

Accepted as ADR-0023. A **note** is the paragraph about an asset, edited in place; a **comment**
is one remark among several, keeps its own identity, and may point at a moment inside the medium.
Neither replaces the other, and the panel shows both.

**The list is a timeline, not a log.** Timed comments come first in timeline order, then the
untimed ones — the order the repository answers in, so the window never sorts what the engine
already ordered. A comment with no moment is about the asset as a whole, which is what lets a
`.zip` carry one.

**The moment is taken at the first keystroke, not when the comment is sent.** "At this point, …"
is what a person means, and a video that goes on playing while the sentence is finished would
otherwise record the moment they stopped writing. It is shown as a removable chip, which is also
how the same field writes a comment about the whole asset while a player is on screen.

**A timecode is a control only when there is somewhere to go.** With a preview open it seeks;
with none open it is text. A control that does nothing when pressed is worse than no control,
because it claims the timecode is a way to get somewhere.

**A timed comment is drawn twice: as a row here, and as a mark on the timeline** (§7). The row is
how it is read and edited; the mark is how it is navigated to. Untimed comments have no mark — a
tick at zero would say something the comment does not.

| Gesture | What happens |
| --- | --- |
| Type, then `Enter` | Adds the comment, at the captured moment or about the asset |
| `Escape` in the field | Drops the draft and its moment. Nothing is sent |
| Click the timecode | Seeks the open preview to it |
| Click the chip's `×` | Makes the comment about the asset rather than about a moment |
| **Edit** | Edits in place, keeping the id — never remove-and-re-add, which would move the comment to the end of every list ordered by creation |
| An emptied field | **Cancels.** Removing has its own button, and a gesture that destroys by leaving something blank cannot be taken back with `Escape` |

**Editing keeps the moment** unless the chip is dismissed, and the row buttons are drawn rather
than revealed on hover: a control that appears only under the pointer is one a keyboard cannot
find.

Comments follow the note in belonging to **one asset**, so like the note they are absent from the
multi-selection panel (§3.2) — writing one across twelve assets would say twelve different things.

### 3.6 Where the file came from

Asked for by the user on 2026-09-05 and accepted as ADR-0030 the same day, because Eagle keeps one
URL per item. It sits **directly under the note**, which is where it was asked for and where it
belongs: the note, the rating, the tags and this are all what the *user* says about the file, and
the metadata table below them is what the *file* says about itself.

**One line, not a textarea.** It has one value and no paragraphs, so `Enter` saves rather than
making a second line. Otherwise it is the note's field exactly — saves on blur and after a
second's idle, and adopts whatever the engine stored, so a value of three spaces comes back empty
rather than lingering in a field the library does not hold.

**Whatever is typed is kept.** No parsing, no normalising, no required scheme. A bare
`instagram.com/p/xyz` is as good an answer to "where did this come from" as a full address, and an
application that refused it would be arguing with the user about what provenance is.

**Only an `http(s)` value gets a button to open it**, and the button is *absent* otherwise rather
than disabled (§8): handing an arbitrary string to the desktop's URL handler on a click is not a
thing to do, and the value was still worth recording. Opening asks main, which opens the user's own
browser — nothing is fetched here, so invariant 7 is untouched, and nothing opens without the
click. **No favicon, no title lookup, no unfurled preview**; each would be the network operation
that invariant exists to forbid, and each would arrive looking like a small convenience.

The affordance follows what the **engine holds**, not what is being typed, or the button would
flicker in and out on the way to `https://`.

### 3.7 The tag field, and what it offers

Asked for by the user on 2026-09-06, looking at a field that made them retype a tag the library
already had. §3's component table has said *typeahead over existing tags* since it was written;
this is what that turned out to mean.

**The vocabulary is the sidebar's.** `library:sidebar` already carries every tag with its live
count, and the window already re-reads it whenever the library changes — so a suggestion costs no
request, no query, and no new state to keep fresh. A tag added here is in the next suggestion
because the edit bumps the same revision the navigation pane reads on.

**Names that begin with what was typed come first, then names that contain it**, and within each
half the most-used tag leads. Tag names are flat and globally unique — a group *arranges* tags
for the sidebar and never nests them, which is why `tag:` still means one thing — so a match in
the middle is the only way `raga` reaches `olahraga`, and keeping it below the prefixes stops it
displacing the tag somebody is plainly typing. Ties break on the name, so the order does not wander between two reads. At most
eight are offered, and a tag the selection already carries is never among them — its chip is on
screen a few pixels above, and adding it again is a no-op.

**A tag already on the asset is a chip, and right-clicking one opens a menu.** Asked for on
2026-09-07, from a panel where the only way to see everything else carrying a tag was to find that
tag again in the sidebar. Two items and no more: **Filter by this tag**, which replaces the query
exactly as clicking the row in the navigation pane does, and **Remove tag**, which is what the `×`
does — offered here because the `×` is a pointer-only target, and a menu holding one of a chip's
two actions reads as if the other were unavailable.

**The query travels; it is never assembled.** The chip filters with the RQL the engine wrote for
that tag's sidebar row, quoting included — the rule §4.1 states for the pane, and the same reason:
a renderer spelling `tag:Some Name` is a second implementation of the grammar and the one that
gets it wrong. A tag the sidebar has not caught up with — the moment after one is added — leaves
the item **disabled rather than absent**, so the menu does not change shape between two openings.

**Nothing is highlighted until an arrow key highlights it.** This is the rule that keeps a *new*
tag possible while an old one is on offer: Enter adds exactly what was typed unless a suggestion
has been chosen, so `oke` is still `oke` with `okelah` listed under it. `↓`/`↑` move the highlight
and wrap, Enter takes it, Escape closes the list and keeps the text — and a second Escape belongs
to the window, so the panel does not swallow the key that clears a selection.

**The list floats over the panel and moves nothing under it.** It was drawn in the panel's flow
first, which pushed the note down for as long as somebody was typing — the user reported that from
a real window the same day, and it is the right report: a field that rearranges the panel to
answer a keystroke is a field that makes you find your place again. In flow had a reason — the
inspector is a scroll container, and a list positioned inside it is clipped exactly when the field
has been scrolled near the bottom, the case a dropdown exists for — and a portal on `document.body`
answers both: outside the clip, and pinned to the field's measured rectangle rather than to a
parent that scrolls. The position is therefore measured rather than declared, so it is taken again
on every scroll and resize, and **the list goes above the field when there is not enough room under
it**.

The field keeps the focus throughout: the options are an `aria-activedescendant` listbox, and a
press on one prevents the default so the blur never fires under the click.

### 3.8 What importing an Eagle library would do

Reached from **Import from Eagle…** in the Add menu, after the chooser (ADR-0032 §6). A `Dialog`
rather than an `AlertDialog`: an import is not destructive — Eagle's library is only ever read, and
what arrives can be trashed like anything else — so it dismisses by clicking away and confirms with
a plain button. The danger ramp means *cannot be undone* (§2) and this is not that.

**It selects nothing.** The import brings every item and every kind of metadata, which is the user's
decision of 2026-09-06, so this is not a filter with checkboxes. It answers *what am I about to do*,
and its real work is the second half of that: the things which **will not** come across. Afterwards
they are unfalsifiable — a colour palette that was dropped and one that never existed look identical
in a library — so this is the only moment they can be said while the Eagle library is certainly
still there.

Four blocks, and every one of them omits what does not apply. A count of zero is a sentence about
something the user does not use:

| Block | Holds |
| --- | --- |
| The library | `Eagle <version> · <n> items · <size>`, from Eagle's own byte count |
| What it holds | Tags, folders, tag groups, rated, notes, URLs, comments, subtitles, items in Eagle's trash |
| Not carried across | Eagle's thumbnails, colour palettes, smart folders, quick access, and **its "date added"** |
| Warnings | Folders that will be renamed, and how many items will be skipped |

**Eagle's "date added" is listed with the losses and not buried.** It cannot be recovered once the
Eagle library is deleted, and it is the one thing in the mapping with no home here — `imported_at`
comes from the journal line's own timestamp. The file's own date does survive, which is the half
that makes it bearable, and the line says so.

**Where the survey found a rating, a note or a URL, the dialog says what happens to the ones this
library already has**: Eagle fills only what is empty and overwrites nothing (ADR-0032 §8). It is a
sentence and never a number — knowing how many would collide means hashing the whole Eagle library,
which is what a survey must not cost. The count of the ones it declined to write comes afterwards,
in the status bar, as *N kept as they were*.

**The survey is fetched when the dialog opens**, not passed in: it costs a read per item and the
caller has only a path. Until it answers the dialog says *Reading the library…* and **Import** is
disabled — as it stays for a survey of zero items, which is what a directory that is not an Eagle
library looks like once the engine has refused it. The refusal's own message is shown, because
"no `metadata.json`" is more use than "could not read it".

**Progress goes to the status bar, not to this dialog**, like every other import (§8): a run of
ninety thousand items is a state the window is in rather than a notification. The line is *done of
total* — and this is the one import where the total is a **fact**, because the survey counted the
items before the run began. A directory walk has no total until it ends, so there the denominator is
what the walk has found so far, which is the honest upper bound and grows as it goes.

**The numerator is what has finished, never what has been found.** `scanned` is the walk's own
queue: it drains five hundred paths before hashing any of them, so a line reading `500 scanned` says
five hundred files are done when none of them are. Measured against a real window on 2026-09-06 — a
3,000-file import emitted six progress events during its import phase and every one was a multiple
of five hundred, which is the shape of the queue rather than of the work.

### 3.9 The folders an asset is in

Chips with an `×`, and a menu that adds one — the same shape the tag editor has a control above,
because the two answer the same kind of question about the same selection. Built on 2026-09-06, at
the user's word: *"untuk file yang sudah tertaut ke folder, apakah memungkinkan ada opsi untuk
melepas dari folder?"* Until then a folder was in the metadata table as text, and **nothing in the
window could put an asset in one or take it out** — the ops existed, the CLI used them, and the
interface was the whole of the gap.

**Adding is a menu, not a field.** The tag beside it takes typing because a tag that does not exist
yet is made by typing it; a folder is not. Nothing in the window creates one, so a text field here
would offer a gesture that can only fail. The menu draws the whole tree, indented by the depth the
sidebar uses — the paths repeat, and three folders called `Icons` are three rows reading `Icons`
until the shape tells them apart. Each row carries its full path as a title, and a folder the
selection is already in is **disabled rather than absent**, so the tree does not change shape
between two openings.

**A chip says the path, not the name**, for the same reason: it is what somebody reads before
pressing the `×` beside it.

**Clicking the path shows that folder.** Asked for on 2026-09-07, beside the tag chip's menu in
§3.7 and deliberately not the same gesture: a folder chip offers one thing, so a menu would be a
click in the way, while a tag chip offers two and has to ask which. The name is therefore a button
— reachable from the keyboard, undressed to look like the text it replaced — and the query it
sends is the **sidebar row's own**, found by the folder's id in the tree this control already
holds. A chip whose folder the tree does not know yet is drawn plainly and does nothing, because
the panel and the navigation pane read the library separately and one can be a moment behind.

**Detaching is not deleting, and it asks nothing.** A folder is a collection, not a location
(`STORAGE_SPEC.md`) — leaving one changes nothing about the asset and moves nothing on disk. That is
why the button is an `×` like a tag's rather than a word like `Delete`, and why `Ctrl+Delete` needs
no confirmation while the bare `Delete` beside it does.

**It is one control over one asset and over twelve** (§3.2): folders every selected asset is in,
then folders some of them are in, drawn apart and labelled exactly as the tags are. Removing either
is the same call — the engine ignores an asset that is not in the folder — so the distinction is a
thing said, not a thing branched on.

**The window names a folder by id, never by path.** A path is what RQL names and what this control
draws, but names are unique only among siblings, and one holding a `/` is still readable from a
library written before that was refused (`TODO.md`). The id is the folder. The tree arrives with the
sidebar's own rows, which the window already re-reads on every change, so a folder made anywhere is
offerable here the moment it exists and nothing asks the engine twice for one small table.

### 3.10 The name

The panel's heading is the name, and it is a field: the one place an asset is renamed, since the
file on disk is called after its hash and always will be (invariant 3, `STORAGE_SPEC.md`).

**The extension is not in it.** An asset's `ext` is decided once, at import, from the file that
arrived, and `asset_rename` has never touched it — so typing over `.txt` renamed nothing: the
column, the object under `originals/`, the kind the grid draws and every query that reads them went
on saying `txt`, and this field was the only place in the application claiming otherwise. So it
holds the stem, and the extension goes back on when the name is saved. It is still on screen twice —
the preview placeholder's badge, and **Kind** in the metadata table — and the grid still draws the
whole filename, because that is what the file is called. What is gone is the invitation to edit a
thing that cannot change.

Two edges follow from taking the suffix off the *name* rather than off the column. Its case is the
name's: `Holiday.JPG` keeps its shouting extension, where the column is lowercased. And a name that
does not end in its extension at all — one an earlier rename or the CLI left behind — is shown
whole and saved as typed, because there is nothing to hide and appending one would rename the asset
on a click into the field. `roost rename` keeps taking a whole name: a terminal has no stem, and
somebody typing a full filename there means it.

**It wraps, and it grows to fit what it holds.** The names this has to show are not chosen by
anybody — `Gemini_Generated_Image_lxhl6dlxhl6dlxhlfefwefwefewfwef.png` came out of a generator, and
it is longer than a 280px column three times over. A single-line field answers that by scrolling
sideways, which makes the name something to be *operated* before it can be read and leaves the
heading of the panel unable to say which asset is selected. So the whole of it is on screen, over as
many lines as it takes, and the field is as tall as its name — one line for `shot-0.png` and four
for the one above. Long runs break mid-word, because a generated name has no spaces to break at.

**A name has no lines, though.** The control that wraps is a `textarea`, which is the first thing in
this panel that could put a newline into a name at all: `Enter` therefore commits and returns focus
as it did when this was one line, and a pasted newline arrives as a space. The engine trims the ends
of a name and nothing more, so an interior newline that got past here would be written to the
journal.

**Over several assets there is no name field at all** (§3.2) — a name belongs to one asset.

### 3.11 Where an import lands, and what was already there

An import joins **the folder on screen** (ADR-0037). Not a setting and not a field in a dialog: the
folder a person can see is the one they mean, and it is found by matching the running query against
the sidebar's rows — so a folder reached by typing `folder:Design` into the search field counts as
much as one reached by clicking it (§4.1). Where the query names no folder, the import files
nothing; the library's root is a destination rather than a missing answer.

**The folder is read when the run starts.** An import of forty thousand files takes minutes, and
navigating elsewhere while it runs must not scatter its last batch into somewhere the user was only
passing through.

**Importing from Eagle is the exception**, and not by a special case: an Eagle library brings its own
folders (ADR-0032), so its importer never names one. Pasting files is the other (ADR-0026) — half of
what a paste can carry is not a file.

Afterwards, a run that found files already in the library says so in a `Dialog`:

```
14 files were already in this library.
Nothing was copied twice — Roost recognises a file by its contents.

  autumn-3.jpg
  autumn-4.jpg
  …and 12 more

[ Ignore all ]                       [ Add to Design ]
```

**It comes after the run, not before it.** Deduplication here is structural — identical bytes have
one address (`STORAGE_SPEC.md` invariant 1) — so a duplicate is discovered by *hashing* the incoming
file. Asking first would mean reading every candidate twice. Waiting costs nothing, because for a
duplicate the import writes nothing at all: *Ignore all* is the behaviour the run already had, and
dismissing by clicking away means the same thing. It is not an `AlertDialog` for that reason.

**The second button adds; it never moves.** An asset belongs to as many folders as it was put in, so
filing these into the folder on screen takes them out of nowhere — which is why the button carries
the folder's name rather than the word *Move*. Where no folder is open the dialog is one button
wide, and still worth drawing: a grid that did not grow reads as an import that failed until
something says otherwise.

**The list is a preview and the count is not.** At most two hundred names, scrolling inside the
dialog, with the rest counted — re-importing a large directory is the ordinary way to produce a
hundred thousand duplicates. The hashes never reach the window: the engine keeps the list the run
reported, and the button acts on all of it.

## 4. Navigation

### 4.1 What the sidebar contains

```
Library ▾                        library switcher, and where "Open library…" lives

PLACES
  All assets                     everything, newest first
  Recent                         imported in the last 7 days
  Untagged                       the pile that needs work — the reason this is here
  Trash                     3    ADR-0022. The only place with a count, and the count is what
                                 makes it worth a row — an empty trash and one holding four
                                 hundred assets look identical without it. Right-click it for
                                 Empty trash

FOLDERS                    🔍 +  the tree, depth-first; the `+` makes a top-level folder,
  ▸ Clients                      the 🔍 reveals a field that searches it
  ▾ Acme                         closed: the count is the subtree's, so nothing is hidden by it
      Logos              412     right-click any row for subfolder, rename, delete
SMART FOLDERS                    saved RQL
  Recent PNGs               1.2k
```

**Three sections, and rating and tags are not among them** (ADR-0035). They were here until
2026-09-07 and are now the filter bar's, one pane over (§4.4). What is left is what answers *where
am I looking*; rating and tags answer *narrow this down*, which is a different gesture — a row here
**replaces** the query and a facet up there **narrows** it, and one vocabulary offering both is two
controls that will disagree about that before they disagree about anything else.

The engine still sends both. The bar needs the same six rating counts and the same tag rows, and so
does the inspector's tag field; what moved is where they are drawn, not what `readSidebar` answers.

**The Trash row is the one place with a menu of its own**, and it holds the one command: **Empty
trash**, the same item the grid's menu carries (§3.3) and the same confirmation. Asked for on
2026-09-08. Until then the command lived in the grid's menu alone, which meant standing *in* the
Trash place to reach it — and the row that carries the number is where somebody looks for it. It is
drawn dead while the count is zero rather than coming and going: a menu with one item that is
sometimes no items is one nobody learns. The pane raises it and owns no dialog, exactly as the three
folder commands do.

**A folder's count is the count of its own row's query**, so it follows *Show subfolder contents*
(§4.4, ADR-0036): the subtree when they are shown, the folder alone when they are not. Smart folders
carry match counts. All of them are computed by the engine — the renderer never counts anything it
did not receive.

**The one number that does not follow it** is the one **Delete folder…** asks about. Ticking that
dialog's box trashes the whole subtree in one journal batch (ADR-0033 §3.3), so its question counts
the subtree whatever the pane is drawing; the row carries both numbers for exactly this.

**The folder rows arrive depth-first**, each folder immediately followed by its own subtree
(`@roost/library`'s `orderTree`). Until 2026-09-06 they arrived in one alphabetical run and were
indented by depth anyway, so a child was drawn under whatever folder happened to sort above it —
a tree in appearance and a sorted list in fact. The order is what makes both the indentation and
the collapsing correct, and it is why no row needs to carry a parent: a closed branch is the run of
rows that follow it at a greater depth.

**Every branch starts closed** (ADR-0033). A hundred folders drawn flat is the pane that prompted
this. Closing a branch cost no information while every count was a subtree count; since ADR-0036 it
can, because with *Show subfolder contents* off a folder's count is its own — and that is the right
trade, since the count beside a query has to be the count of that query. Expansion
lives in the window and **does not survive it**: where it belongs is `settings.json` in the library
(ADR-0019), which is not built yet.

**The disclosure control is a `--space-5` square holding a drawn chevron**, and a folder with no
children gets a spacer of the same width rather than a disabled button — a target that answers a
press by doing nothing is worse than no target. It was a full-height 16px strip with a `▸` in it
until 2026-09-07, when the user reported it as too small to aim at: the glyph was the font's, at a
size that left a speck of ink, and the hover state — inherited whole from the base button — painted
a tall rectangle that read as a stripe of the row rather than as a button. The chevron is a path
now, so it is the same shape at both densities, and the turn is the glyph's rather than the box's:
a square that rotates with the arrow takes its hover state round with it.

**The tree is editable from the pane.** `+` in the heading makes a top-level folder; right-clicking
a row offers **New subfolder…**, **Rename…**, and **Delete folder…**. The heading is drawn even when
the section is empty, which no other section does — a new library with no folders and no way to make
one is a dead end, and it was the state of every new library until this changed.

**The tree is searched from a magnifier in its heading**, which reveals a field under it and takes
the caret with it. Only this section has one: Places is four rows, and a folder tree is the only
part of the pane that grows to the hundred rows that prompted ADR-0033.

**A search keeps the tree's shape.** A match is drawn where it sits, every folder on the path down
to it comes along as **context** — quieted, but still a real row that can be clicked and still a
drop target — and everything else goes. What does *not* come along is a match's own subtree, which
is what stops a needle matching a folder near the root from redrawing the whole pane.

**While a needle is typed the disclosure is a mark rather than a control.** A branch is drawn only
because something under it matched, so the one thing closing it could do is hide the reason it is
there. The expansion state is not consulted and not touched: closing the field gives back exactly
the tree that was left, which is why searching costs nothing to undo. `Escape` closes it, and so
does the magnifier.

**A folder command clears the needle and keeps the field.** All four — `+`, New subfolder, Rename,
Delete — end in a dialog that changes the tree, and a new folder whose name does not match the
needle would be made and then not drawn, which reads as the command having failed.

**A name a sibling already has is refused**, by the engine, at the point the name is authored —
in the New folder and Rename dialogs, and on a drag that would carry a folder into a parent already
holding its name. Two folders called `logos` under one parent compile to the same `folder:` query
and the path walk takes the first row it matches, so the second is unreachable from the moment it
exists; it is the same defect as a name containing `/`, arriving by a different route. Names are
compared **without regard to case**, which is the house rule for every user-authored name here.
The dialog says which folder already holds it, and stays open with the name still in the field.
A library that already holds such a pair still opens and still rebuilds — the rule binds new names,
not old ones.

**Deleting a folder asks what should happen to what is in it**, in one dialog with one checkbox
(ADR-0033, §3.4). Unticked, the folder and its subfolders go and the assets stay in the library, no
longer filed anywhere. Ticked, every live asset in the subtree goes to the **trash** in the same
journal batch — reversible, like every other `Delete` in Roost, so restoring brings them back with
every other folder they were in. The number in both the checkbox and the sentence is the row's own
count, so the dialog and the sidebar cannot disagree.

**A count beside a query is the count *of* that query.** Folder and tag counts therefore exclude
trashed assets, exactly as `folder:` and `tag:` do (ADR-0022) — a sidebar saying 3 while the grid
shows 2 is the shape this goes wrong in. A tag every one of whose assets is in the trash stays
listed at zero: the tag has not been deleted, and a row vanishing says something different from a
count falling.

**Every row carries the RQL that selects it**, built in `@roost/library`. The renderer never
assembles a query string; clicking `Logos` sends the row's query to the search field, which is
why the search field always shows what is actually being asked. This is carried over from
`roost-old` and it is the single decision that keeps the search bar honest.

### 4.2 Selection versus filtering

**There is no separate filter state that the search field does not know about** — one source of
truth for "what is on screen", and it is a string the user can read and edit. That is the rule; the
filter bar of §4.4 is the first control large enough to test it, and it is a *view* of the query
rather than a second copy of one.

Clicking a sidebar row **replaces every conjunct the bar does not own, and leaves the ones it do**
(ADR-0035 §6). So a folder becomes the new place and the tag, rating and type filters stand;
**All assets** carries the empty query and therefore clears the place and nothing else. One rule for
all three sections, and for the inspector's chips: a chip that names a tag becomes the tag filter,
where a chip that names a folder becomes the place. Typed free text is not a filter, so a row still
replaces it — which is what a row has always done.

**A new query takes the selection, the focus and the open file with it.** What was selected is not
on screen any more, and neither is the cell the ring was on — a ring left behind opens an asset the
result does not hold when `Enter` is pressed. The preview goes the same way: a row is a request to
look somewhere else, and a pane left standing over the answer draws a file that is not in it, behind
a head that has replaced the grid's own (§7). So a sidebar row, an inspector chip, a filter and
typed text all land the same way — on the grid, showing where the click went. It stayed open until
2026-09-08, when the user reported it.

Ctrl-clicking a second row to `AND` its term is **not built**, and the bar is most of why it was
wanted.

### 4.3 Dragging into a folder, and dragging a folder

Built 2026-09-07 (ADR-0033 §5). Two gestures, one drop target.

**Assets onto a folder row.** What travels is the **selection**, not the cell under the pointer —
`pointerdown` has already selected an unselected cell by the time a drag starts, exactly as a
right-click does, so dragging one of twelve selected assets drags all twelve.

**A press on an already-selected cell changes nothing until it is released.** This is the rule that
makes dragging several possible at all: collapsing the selection on `pointerdown`, which is what the
grid used to do, leaves one asset selected before the drag has begun — so a drag of five carried
one, however many were highlighted. The click is remembered and settled on `pointerup`, and a drag
cancels it. Found by driving a real window on 2026-09-07; every component test passed, because
`fireEvent.dragStart` fires no pointer event before it. §6 records the same rule from the selection's
side.

**Whether it is a move is decided by what is on screen, not by the drop.** A folder is a collection
rather than a location, so there is nothing to move *out of* unless a folder is being looked at:

| Dragging from | The drop means |
| --- | --- |
| A folder | **Move** — added to the target, removed from the folder on screen, and the row leaves the grid |
| All assets, a search, a tag, a rating | **Add** — there is no folder to leave |
| Anywhere, with `Ctrl` | **Add**, always |

The status bar says which happened, in those words: *Moved 3 assets from Icons to Logos*, or
*Added 3 assets to Logos*. **Two requests, not one**, and in that order: the add is what was asked
for, and a failure between them leaves the assets in both folders — visible, harmless, and undone by
dragging again. The reverse order could lose them from both.

**A folder onto another folder** re-parents it. Onto the **FOLDERS heading**, it goes to the top
level. The engine refuses a move into the folder's own subtree, because that cuts the subtree off
from the root — unreachable in the pane and therefore undeletable through it — and the refusal is
**shown**: the pane offered the drop, so a silent no reads as a gesture that did nothing. The pane
refuses only the self-drop, which is the one case a `dragover` can see without the tree.

**The keyboard has the one half it can.** **Move to top level** sits in a folder's own menu,
disabled where the folder is already there. Moving a folder *into* another is a choice among every
folder there is — a picker, not a menu item — and the drag is the gesture that already expresses it.

**The drag carries a thumbnail, not the cell.** A browser's default drag image is a snapshot of the
element being dragged, and a grid cell at a comfortable zoom is several hundred pixels square — it
covered the sidebar it was being dragged *to*, which is the one thing the hand needs to see
(reported from a real window, 2026-09-07). The ghost is a 64px square carrying the cell's own
thumbnail, anchored at its centre so it hangs under the pointer, with the count in the corner when
more than one asset is coming — a picture of one asset over a drag of three says something untrue.
An asset with no thumbnail carries its extension, exactly as its cell does.

**A drag target lights up rather than relying on `:hover`**, which does not match while a drag is in
progress: the pointer is holding something, and the outline is the only thing telling the hand where
it will land.

**An internal drag carries a Roost media type and never `Files`**, which is what keeps the import
overlay out of the way: `DropZone` appears for a drag carrying `Files`, which is what a drag from
the desktop carries and what a drag inside this window never does. Neither has to know about the
other.

### 4.4 The filter bar

One row under the toolbar, over the grid, always drawn (ADR-0035). Three facets — **Tags**,
**Rating**, **Types** — each a button that opens a menu of checkboxes, then the **Show subfolder
contents** checkbox (ADR-0036), and one **Clear filters** that appears only when there is something
to clear.

```
Search…                                     8 matches    Icons ▾    + Add ▾
Tags  wood +1 ▾   Rating ★★★★★ ▾   Types PNG ▾   ☐ Show subfolder contents   Clear filters
      ┌──────────────────────────┐
      │ Rule            [Any] All│    tags only
      │ [ Search tags…         ] │    only past eight values
      │ MATERIALS                │
      │ ✓ wood                88 │
      │   metal               41 │
      └──────────────────────────┘
```

**It is a view of the query.** Everything drawn here is read back out of the query string, and every
click writes a new one into the search field. Nothing is remembered from the click itself: type
`ext:png` by hand and the Types chip lights up; delete it and the chip goes out. That is §4.2's
promise made visible, and it is the reason the bar can be trusted to say why the grid is short.

**Within a facet the values are `OR`ed, across facets `AND`ed** — except tags, which carry a rule
(below). Two ratings `AND`ed match nothing, and so do two extensions. It is also the difference from
a sidebar row, which replaces the query outright.

**The tags have a rule: Any or All** (ADR-0035 §7). *Any* is `(tag:wood OR tag:metal)` and matches
an asset carrying either; *All* is `tag:wood tag:metal` and matches only one carrying both. Two
shapes the query already had, so the rule reads straight out of it and needs nothing added to the
grammar.

**Only tags have one, and the data decides that.** An asset has one extension and one rating, so
*All* on either would be a button whose only outcome is an empty grid.

**Below two tags the window remembers the rule**, because `tag:wood` is the same query under either
and there is nothing to read back. It is the one thing in the bar not derived from the query, and
deliberately the one thing the query cannot express — the same standing the view mode and the zoom
have. The moment a second tag makes it expressible, the string wins: typing `tag:a tag:b` by hand
moves the toggle to *All*.

**Clearing the filters does not touch the rule.** It is how the *next* two tags will be joined, and
clearing has said nothing about that.

**To the right of Types sits one checkbox, and it is not a facet** (ADR-0036). *Show subfolder
contents* says how deep the **place** reaches, where the three chips to its left narrow what is
inside it — a different question, which is why it has no menu, no count, and no part in *Clear
filters*.

**It is a view of the query, like everything else here.** `folder:Design` ticks it,
`infolder:Design` unticks it, and ticking it rewrites the query on screen so the grid answers now
rather than after the next click. Typing either term by hand moves the checkbox. The setting decides
which term a sidebar row *carries*; it never changes what a term means, so a query saved months ago
asks the same question forever.

**Where the query names no folder it shows the library's setting** — what the *next* folder opened
will use. The same standing the tag rule has, one shelf further out: it lives in `settings.json`
inside the library (ADR-0019), so it travels with the folder and the CLI reads the same one.
**Off by default**: a folder shows its own contents, as a file manager's does.

**A facet's menu is searched past eight values**, with a field at its head that filters the list as
it is typed. A field over five tags costs a row and saves nothing. The rule is generic, so a library
with thirty extensions gets one on Types without anybody deciding twice.

**Several values are chosen in one visit.** The menu stays open through a tick — and both halves of
that are needed, because `preventDefault` on the select holds for the first tick of a visit and not
the second. Found by driving a real window on 2026-09-08, where choosing two tags shut the menu on
the second while every component test passed; `scripts/check-filters.mjs` is where that claim now
lives.

**A facet's button says what is chosen**, not merely that something is: `wood +1`, `★★★★★`, `PNG`.
Three chips that only light up make somebody open all three to find the one hiding their assets.

**The counts are the ones the pane used to draw**, from the same read. A rating row matches one
rating, not "this many and up" — five nested rows would have counts adding up to more than the
library holds, and `rating:>=4` is one term in the search field for the other question. **Unrated is
the sixth row and it is not a rating of zero**: the schema has no zero (`DATA_MODEL.md`), so the row
carries `is:unrated` and sits last, because the five above it are a scale and it is not on it.

**The rows are drawn as stars, and the engine sends a number rather than a glyph.** Each carries
`stars` — how many of the five to light — because what a row *is* belongs to the engine and what it
*looks like* belongs to the window; the CLI prints `3 stars` from the same fact. Five are always
drawn so the rows read as one scale, the unlit ones in the border colour, and the row's name stays
in the accessible tree so a screen reader still hears "3 stars 7".

**Tags keep their groups.** A group arranges tags, so it is a heading in the menu rather than a
submenu: burying eight tags one level down would make choosing two of them a four-gesture job.

**Types are extensions**, most-used first, with counts — `ext:` as the grammar already has it, so
this facet needed no new term. An asset with no extension is drawn as **No extension** rather than
dropped, because a facet whose counts do not add up is worse than a plain-looking row. A coarse
`kind:` — Image, Video, Audio, Document — reads better and does not exist: `kind` is derived from
the extension and is not a column, so it would be an addition to a grammar frozen by compatibility.
ADR-0035 §3.4 leaves the door open and nothing decided here would have to move.

**A query it cannot describe is said out loud.** A top-level `OR`, or two terms of one facet —
`tag:a tag:b` means both, where a facet can only mean either — and the bar draws every chip as off
and prints *the search field holds a query these cannot show*. Three empty chips over a filtered
grid is the one thing this control could lie about. Its menus still work: choosing a value **adds**
to the query rather than claiming to own what is already there.

**The menus are not modal.** The grid behind them is the thing being changed, and ticking a second
tag while watching the count move is the ordinary way this is used.

**The engine reads and writes the query.** Two requests, `query:split` and `query:join`, both pure
functions of a string: the renderer sends the values it holds and puts back the query it is given.
It never parses and never concatenates, which is §4.1's rule holding under the one feature that
would most have tempted a renderer-side parser.

## 5. Search

The field takes RQL (`DATA_MODEL.md` §3). It is the primary control in its column's head and takes
every pixel the view control and Add leave it — a query is not a paragraph, and RQL runs long
enough (three terms, a quoted folder path, a date range) that a capped field would scroll sideways
while empty bar sat beside it.

- **Typing words is a search, and needs no syntax** (ADR-0027). Bare words are free-text terms,
  and free text reaches everything a person wrote about an asset: its name, its tags, its note,
  and its comments. **Not its source** — a URL is an address rather than prose about the asset,
  and the user ruled it out on the day it was proposed (ADR-0030 §4). The placeholder says what
  is reached rather than teaching a field prefix — RQL is discovered from the sidebar, which
  writes `tag:wood` into this field when a tag is clicked.
- **Validates before it applies.** A half-typed query leaves the grid alone. The parse error
  appears under the field with a caret at the byte offset the parser reported — not a red
  border and not a toast.
- **Applies on a 250ms idle**, and immediately on Enter.
- **It rests showing the head of the query.** A field is scrolled to wherever its caret last
  was, and for a folder path that is the tail — `…/post/testing"`, the half that names nothing,
  while the half saying *which place* sits off the left edge. So the scroll is pinned to the
  start whenever nobody is typing in it, which is the state it spends its life in: a sidebar
  click writes a query and then nothing touches it.
- **Taking the focus puts the caret one space past the query**, with the field scrolled there
  and eight characters of room left to the right of it. A folder query is *continued* — a term
  added, a subfolder typed onto a path already in the field — so the end is where the work
  happens, and reaching it by hand in a path too long to fit is what this answers. The space is
  a real character and RQL's separator, added only when there is not one already, and it is
  trimmed off before the query reaches the engine: a click is not an edit. The room after the
  caret is the input's right **padding**, not characters — spaces there would be part of the
  query and would grow with every click. The click that *arrives* goes to the end; a second
  click puts the caret where it landed, because a click carries a position and a query is also
  edited a term at a time. `Ctrl+F` / `/` do the same from anywhere. **A caret and not a
  selection**: it was built as a select-all first, the address bar's gesture, and the user
  rejected it on sight on 2026-09-08 — selecting text nobody asked to select is what a click
  then looks like. Together with the rule above, the two ends divide the field's life: at rest
  it shows the head, which says *which* folder; touched, it shows the end, which is where the
  next character goes. Neither is a substitute for autocomplete above; they are what make a
  query too long to fit workable.
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

**One highlight per selected thing, in every view.** What changes is its shape, because the eye
reads a row and a card differently.

- **Compact** and **Details**: the cell *is* a row, so the whole row is filled. A pill on the
  label plus a ring on a 40px thumbnail, inside an outline around the row, is three marks for one
  selected thing — reported as looking wrong on 2026-09-01, and it was.
- **Icons**: the cell is a picture with its name under it, so the **cell** is filled and ringed,
  not the picture and the caption separately. The ring used to sit on the thumbnail and the fill
  on the caption, with the 4px seam between them showing page background — two marks with a gap,
  reported the same day. Filled behind the picture, the seam, and the caption alike, it reads as
  one card.

**The roving ring shares the selection's mark rather than adding a second one.** Over a row it is
drawn inside, hairline; over a card it thickens and brightens the ring the card already has,
because inside a card is the picture and there is nowhere to put it. Either way the fill says
"selected" as plainly as the sidebar's current row does, and the ring only answers "and which of
the selected ones is the keyboard on". It cannot be dropped when the item is selected: focus and
selection are separate, so with twelve items selected there would be nothing to show where the
next `Space` would land.

That distinction is why **`--select-border` is one step calmer than `--border-focus`** (§2). They
were the same value in both themes until 2026-09-01, which made "brighter means focused" a claim
nothing could see — two tokens for two roles are worth nothing while they resolve to one colour.

**Hover never paints over a selected row.** `.grid[data-view] .cell:hover` outranks
`.cell[data-view][data-selected]` on specificity, so the selection fill vanished under the
pointer until the hover rule was told to skip selected rows — measured, not guessed. CSS has no
warning for this, the same way it has none for an undefined token, and there is no test that can
see it either: the guard is a real window (`TODO.md` §3).

**A press on a cell that is already selected is settled on release, not on press** — otherwise a
press collapses a multi-selection before a drag can carry it (§4.3).

**Selection model.** Click selects; `Ctrl`-click toggles; `Shift`-click extends from the anchor;
drag on the background marquee-selects; `Ctrl+A` selects the loaded set and says so, because
"select all" over 900,000 unloaded rows is a promise the grid cannot keep.

**The marquee**, in the four decisions it actually is:

- **It takes what it touches, not what it encloses.** Enclosing is unusable in proportional
  Icons, where a cell is routinely taller than the sweep meant to catch it, and touching is what
  every file manager does.
- **The clear happens on release, not on press.** A press on the background is a sweep until it
  turns out to be a click — clearing on `pointerdown` would empty the inspector at the start of
  every drag, and the panel would flash on each one.
- **`Ctrl` adds to what was already selected** rather than toggling through it. A rect that grows
  and shrinks over the same cell would otherwise flip it on and off as the hand wobbled.
- **Holding at the top or bottom edge scrolls**, so a sweep can be longer than the window. The
  roving ring does not move with a sweep and the grid does not scroll to it while one is running:
  focus and selection are separate, and hauling the viewport back to the ring mid-drag would take
  the grid out from under the pointer.

**Focus.** The grid is one tab stop with a roving focus ring. Arrow keys move focus; `Space`
toggles selection; `Enter` opens the preview. Focus and selection are separate — moving focus
with `Ctrl` held does not change the selection.

**The frame's own ring draws only while nothing inside it is focused.** Tabbing into the grid
rings the frame, because with no cell focused it is the only answer to "where is the keyboard";
the first arrow key hands that ring to a cell and the frame stops drawing it. Two rectangles —
one around a cell and one around the whole grid — say the same thing twice, and `:focus-visible`
holds once a key has been used, so the outer one stayed on screen for as long as the keyboard
stayed in the grid. It was the first thing a person asked about the window. This is §10's rule
narrowed by *where* rather than *whether*: the ring is never removed, it is only ever drawn in
one place at a time. The frame knows which case it is in from `data-roving`, written to the
element beside `aria-activedescendant` rather than rendered, for the same reason.

**The frame budget is an acceptance criterion, not a later optimisation.** A scroll benchmark
mode drives the grid and prints frame percentiles, and refuses to print a number when the
window was not being composited. `roost-old` measured no dropped frames at reading speed and
0.25% while flinging through 79,800 assets, on a weaker webview than Chromium. That is the bar.

## 7. Preview

Opens on `Enter` or double-click, into the content region — **unless Roost cannot draw the file**,
in which case the same gesture hands it straight to the application that owns it. A pane whose only
offer is "Open externally" is a pane in the way of what the gesture meant. The kind travels on the
grid's card so the decision costs no round trip, and `other` is the test: everything Roost has a
backend for still opens here, even while its thumbnail is still being derived.

**The content column's head goes with the grid.** Every control in it is the grid's — the search
field, the view menu, Add — so while a file is open the bar is not drawn at all, and the pane's
own head takes its place: **two arrows and the way out** at the end of the row, and **a slot at
the start of it** for whatever is on screen to draw its own controls into. Today that is the
picture's zoom. The two ends say two different things — one changes what is being looked at, the
other how — and the slot is a real element first in the row rather than a shuffled order, so what
the eye reads left to right is what the Tab key walks through. It takes no room at all when it is
empty. The sidebar and the inspector stay, because both are still about the thing on screen. The
field is unmounted rather than emptied: the query it was showing comes back when the preview
closes.

**The head carries no filename.** It did until 2026-09-06, while the inspector three inches to the
right carried the same name in an editable field — and the pane cannot be open with nothing
selected, so the second copy was a title bar the window already has. The arrows are what the arrow
*keys* already did, put where a pointer can reach them; each is **drawn dead at its end of the
list** rather than hidden, because an end is a fact worth showing (§3.5), and the list is the
grid's, so it ends where the loaded page does.

Arrow keys step through the loaded
list, and **stepping changes the selection**, so the inspector follows what is on screen — in
`roost-old` it did not, and a note could be written onto the wrong asset.

**It closes on `Escape`, on the head's Close — and on a new query** (§4.2). The sidebar and the
inspector are still live while a file is open, and a click in either is a click on something the
pane is not showing.

| Kind | Renders as |
| --- | --- |
| Image | `<img src="roost://original/<hash>">`, fit to pane, and zoomable: the wheel, two buttons and a readout, `+`/`-`, click to toggle 1:1, drag to pan |
| SVG | Same, sandboxed — scripts in an SVG do not run |
| Video / audio | `<video>` / `<audio>` over `roost://original/`, which answers range requests, under a transport of ours — `controls` is off |
| PDF | Page-through: `PageUp` / `PageDown` and two buttons, each page an `<img>` over `roost://page/<hash>/<n>@1024`. Arrow keys keep stepping between assets, so a document does not trap the keyboard |
| Font | The specimen sheet the derive pass drew, with the family and style under it |
| Text | The file itself, monospace, wrapped, with the encoding named under it — `.txt`, `.md`, `.srt`, a log. **Edit** makes it a textarea in the same box |
| Anything else | The thumbnail, the metadata, and **Open externally** |

**A photograph can be looked at closely.** Asked for on 2026-09-07 — *"jika view foto. tambahkan
untuk zoom in atau zoom out"*, and then *"terus bisa pakai scroll untuk zoom in atau out nya"* —
and this table has asked for the click and the drag since it was written.

- **Fit is the resting state, and it is a state rather than a number.** While nothing has been
  zoomed the scale is computed from the pane, so widening the window re-fits the picture instead of
  leaving it at the size the old pane wanted. The first zoom fixes a number and the number is then
  what is drawn.
- **Nothing is blown up at rest.** The fit is capped at 1:1, so a 64px icon opens at 64px rather
  than as a wall of mush. Past that is a thing somebody asked for, which is different.
- **The wheel zooms about the pointer.** The pixel under the cursor is the one being examined, so
  it is the one that must not move. No modifier: the stage scrolls nothing, so the wheel has no
  other job here — and a trackpad pinch arrives as a wheel event with `ctrlKey` set, which lands on
  the same handler and means the same thing. The step is a proportion of what is on screen, never a
  fixed addition, or the same notch is imperceptible at 8× and a leap at the fit.
- **The floor is the fit and the ceiling is 16×.** Below the fit a picture only makes the pane
  emptier, so the button is drawn dead there rather than shrinking a photograph into the middle of
  an empty rectangle.
- **The controls are at the head of the pane**: `−`, the scale, `+`, at the start of the row the
  arrows and Close end. They stood at the foot for a few hours on 2026-09-07 — the arrangement the
  transport uses — and the user moved them, which gives the picture back the strip they were
  standing on and puts every control the pane has in one row. They belong to the picture even so:
  the scale is its state and nothing else has it, so they are **drawn through a portal** rather
  than by lifting that state a component up and holding it twice. The readout *is* the control — a
  percentage says where the picture is, and the one thing somebody wants from it is the way back,
  so pressing it goes to 1:1 and back to the fit. Always drawn, never revealed on hover: a control
  that appears only under the pointer is one a keyboard cannot find.
- **A drag pans, and cannot take the picture off the pane.** An axis smaller than the pane is
  centred and not pannable; a larger one is clamped to its own edges. A press that does not move is
  a click, which is the 1:1 toggle.
- **The zoom belongs to the photograph, not to the pane.** Stepping to the next asset opens it
  fitted. A scale carried across assets is a scale that was chosen for a different picture.

**The transport is ours** (ADR-0024). The browser's control bar is a closed widget — nothing can be
drawn on it, nothing added to it, and it cannot be styled — so `controls` is off and the bar under
the picture is drawn here. That is what puts a comment mark **on** the timeline rather than beside
it, and it is the only reason the transport exists: everything else it does, the native bar also
did.

| Control | Notes |
| --- | --- |
| Play / pause | The button, `Space`, and `K` |
| Timeline | A `role="slider"` whose `aria-valuetext` is a timecode, never a count of milliseconds. Arrow keys move a tenth of a second, which is the precision a comment's moment carries |
| Buffered ranges | Drawn from `video.buffered`, behind the played range — the difference between a slow file and a broken one |
| Elapsed / duration | Monospace and tabular, so the digits do not dance. **To the second**, both of them: a comment's moment carries a tenth because somebody chose it, and a playhead only passes through. The elapsed is floored — at 16:12.6 you are in the twelfth second — and the total is rounded, which is the same number the inspector's Duration row shows |
| Volume and mute | `M`, and a slider that is also a slider to a screen reader |
| Fullscreen | On the **player's box**, not on the video: sending the video alone takes the controls off the screen with it |
| Picture-in-picture | Video only. Audio has no picture |
| **Comment marks** | One per **timed** comment, at its moment. Click to seek, hover for the text, and each names its moment and its words to a screen reader |
| **Subtitles** | A `CC` menu listing the tracks attached to this asset, **Off** first, and **Add subtitle…** last. Drawn for every video, because the moment somebody notices there are none is the moment they want to add one |
| Frame stepping | One frame a press, ten from the keyboard. Only where the probe recorded a frame rate: a step is arithmetic on it, and a missing one has to mean no stepping rather than a step of `Infinity`. Stepping pauses first — a step while playing is not a step |
| Playback rate | 0.25× to 8×, in a menu that shows the current one as text. The extremes play **silently**: the platform stops stretching sound outside roughly 0.5×–4×, and the menu says so rather than letting it read as a fault |
| A-B loop | One button and three states — set the start, set the end, clear — plus `I` and `O`. The region is drawn along the track, and a start with no end is a mark rather than a band, because the loop is not running yet |

**The transport is the foot of the pane, and it spans it.** The picture takes whatever is left
above it, centred and fitted rather than filled, so a small video keeps its own pixels. Until
2026-09-05 the player shrink-wrapped the media and the bar was a caption under it, which put the
controls wherever the file's aspect ratio happened to end — a different place for every asset — and
gave a portrait video a timeline a few hundred pixels long. A bar that stands still is a bar the
hand can find without looking, and the longest timeline the pane can give is the finest resolution
somebody scrubbing can aim with. `<audio>` is the exception, and for the reason that proves the
rule: with no picture above it there is nothing for the bar to be the foot of, so it stays in the
middle of the pane.

**Every control in the bar is a target before it is a drawing.** The transport is pressed while
something is playing, often in a hurry and sometimes at the edge of a window, so nothing here is
sized to the ink in it. The timeline takes the press across a strip four times the height of the line
drawn inside it, because a pointer aimed at a timeline is aimed at a moment and the height it has
to hit to say so is nobody's intent; the line itself stays thin. Radix turns a press into a moment from the root's *width* alone, so the height costs nothing
but the room it takes, and the drag it starts holds the pointer, so leaving the strip mid-scrub
keeps scrubbing. A comment mark is a target a row
wide with a three-pixel tick inside it, and the tick grows on hover while the button does not — a
target that changed size under the pointer would move its neighbour out from under it. Missing a
mark costs nothing: the press falls through to the slider and seeks to roughly where it was aimed.
The buttons stand at the toolbar's height, not a generic control's.

**The elapsed time stands alone.** A frame counter sat beside it from 2026-09-02 until
2026-09-05, drawn from `requestVideoFrameCallback` so that it reported the frame the compositor
presented rather than arithmetic on `currentTime` — which is a real distinction, because a seek in
a long-GOP codec lands on the nearest decodable frame. It was withdrawn at the user's word all the
same: the number answered a question nobody in this application was asking, and it was moving too
fast to read for most of the time it was on screen. Frame *stepping* stays. It never needed the
counter — a step is `currentTime ± n/fps` — and the keys are what it is for.

Both platform controls are drawn **only where the platform has them**: a window with no Fullscreen
API gets no fullscreen button, for the same reason §3.5 gives about a timecode.

`<audio>` gets the same transport, with the element itself hidden — it is the decoder, and there
is nothing to look at. Two implementations of one control is how they come to disagree.

**The transport is drawn from the element, never from a copy of it.** Paused, muted, volume,
duration and the buffered ranges are read back out of the media element whenever it says they
changed, which is what lets a key pressed on the pane and a button pressed in the bar drive the
same player without either knowing about the other. The position is the one exception — no event
reports it often enough to scrub with — so it is sampled in an animation frame **while playing**,
and on the element's own events when it is still.

The transport is drawn whether or not anything is on the timeline, so writing the first comment
does not move the picture it is about.

**Text is handed to the application that owns it.** A viewer and an editor were built on
2026-09-03 and withdrawn on 2026-09-04, at the user's word: an external editor is enough, and
showing a text file in the pane means owning an editor to go with it — the encoding, the page
keys, four refusals, and a save that produces a new asset. So a `.txt` and a `.srt` reach the same
place every format Roost cannot draw does.

**What that costs is worth saying**, because it is why the decision could have gone either way:
nothing in the window can change an asset's contents, and a subtitle cannot be read without
leaving Roost. `roost save` keeps the capability in the CLI, where it is a deliberate command
rather than a pane that has to be defended.

**A caption track is a `<track>`, served as WebVTT** (ADR-0025). The `.srt` is an ordinary asset in
the library; `roost://subtitle/<hash>` converts it on the way out, because `<track>` accepts WebVTT
and nothing else and the format people have is SubRip. **Nothing turns itself on**: no track is
`default`, and the menu starts at Off — a subtitle that appears unasked is the thing people go
looking for the button to turn off.

**Add subtitle…** opens a chooser of its own — **files only**, filtered to the subtitle extensions,
with **Add** on its button — and hands the paths to **one** request that imports and attaches them
together. The import chooser is a different dialog and offers folders, because importing a folder
is the ordinary gesture; attaching a caption track is not, and a chooser that lets somebody pick a
directory for it is offering something the caller cannot use. Apart, the two leave a state between them — a track imported and attached
to nothing, sitting in the grid as a stray text file — and the window would have to learn the hash
of something it only handed over a path to. The import is always `managed`, whatever the default
mode is: the whole point of a track being an asset is that it survives its source.

A track that needs an external tool — ASS, or a stream inside the container — is **not** hung on
the element, because a `<track>` pointed at a URL that cannot answer is an empty track with no
error anywhere. It stays in the library and waits for the backend that can read it.

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
- An empty **Trash** → "The trash is empty." Its emptiness is a *state*, not a search that
  found nothing, and "nothing matches this query" reads as a query that did not work.
- **Nothing selected** → the inspector says so: "Nothing selected", and one sentence naming
  what the panel would hold. It does **not** disappear, and it does not draw disabled controls
  either — the first makes the grid reflow, the second looks broken rather than idle, and an
  empty state is neither. Measured on 2026-09-01, before the panel became permanent: selecting
  one asset took the grid from 1040px and four columns to 760px and two, and deselecting took it
  back, so every cell moved twice for every click on the background. `scripts/check-trash.mjs`
  asserts the width now.
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
| `Ctrl+Q` | Quit. Bound in the shell rather than by a menu, which the window does not have (ADR-0028) |
| `Ctrl+I` | Import files… |
| `Ctrl+Shift+I` | Import folder… |
| `Arrows` | Move focus in the grid |
| `Space` | Toggle selection of the focused cell |
| `Enter` | Open preview |
| `Ctrl+A` | Select all loaded |
| `Ctrl+D` | Deselect all |
| `0`–`5` | Set rating on the selection (`0` clears to unrated) |
| `T` | Focus the tag editor for the selection |
| `Delete` | Move the selection to the trash — and, inside the Trash place, delete it permanently after confirming (ADR-0022) |
| `Ctrl+Delete` | Take the selection out of the folder on screen. Nothing outside one — there would be no folder to name, and guessing at one is a removal nobody asked for. No confirmation: a folder is a collection, so nothing is lost (§3.9) |
| `[` / `]` | Zoom cells down · up |
| `Ctrl+K` | Command palette (**M6**) |

In the preview, with a picture open (§7):

| Key | Action |
| --- | --- |
| `+` / `-` | Zoom in · out, about the middle of the pane. Not a digit: `0`–`5` set the rating on the selection, and a preview does not take that away from the asset it is showing |

In the preview, with a video or an audio file open (ADR-0024):

| Key | Action |
| --- | --- |
| `Space` / `K` | Play / pause |
| `J` / `L` | Seek ten seconds back · on |
| `M` | Mute |
| `Arrows` on the timeline | Seek a tenth of a second. Everywhere else in the preview the arrows still step between assets, and whichever control acted on the key keeps it |
| `,` / `.` | Step one frame back · on |
| `<` / `>` | Step ten frames. Reachable with a pointer by pressing the button ten times; the key is the accelerator, not the only way |
| `I` / `O` | Set the loop's start · end. The button beside the timeline does both, and clears |

**Fullscreen has a button and no key.** `F` was the favourite, which is retired (ADR-0029) — but a
key that means one thing beside a video and another beside a picture is worse than a button, and
that was always the real reason. The media keys are read only while
the pane itself has focus, so `Space` on a focused button still presses the button.

## 10. Accessibility

Not a milestone; a constraint on every component.

- The grid uses `role="grid"` with `aria-rowcount`/`aria-colcount` reflecting the *total*, not
  the rendered window, so a screen reader is not told the library holds forty items.
- One tab stop per region, roving focus inside. Tab order follows the visual order. **The media
  transport is the exception**: its controls are individual tab stops, because roving arrow-key
  focus over a toolbar containing a slider collides with the slider's own arrow keys, and the
  timeline's arrows are how it is seeked from the keyboard (§7).
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
