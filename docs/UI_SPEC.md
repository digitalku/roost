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
│ [☰] library  │ [← → ↑] [ search RQL . ] [view ▾] [+ Add ▾] │              │
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
| Sidebar head | with the sidebar | with it | Fixed height. The `☰` (ADR-0028) and the library's name. **The `☰` is drawn in whichever head is on screen** — this one, the content head while the sidebar is hidden, or the preview's own bar when that has replaced the content head (§7) — because it is the control that brings the sidebar back, and a menu that hides itself has no way back (ADR-0028 §6). Never two at once. The name does not travel with it: it belongs to the column that is gone, and the title bar carries it. |
| Content head | with the content | no | Fixed height. **Back, forward and up** (ADR-0044) first, then search — the widest thing in it — then the view control and **Add**. The three arrows are drawn in front of the field because the field is the address bar they belong to, which is a file manager's order and its corner. |
| Sidebar | 220–420px, drag to resize | yes, `F9` or **Show sidebar** in the `☰` | Both the width and the collapsed state are remembered per library, in `settings.json` (ADR-0019). Hidden means **not drawn**, not narrowed — the grid takes the room. |
| Content | fills | no | Hosts exactly one of: icons, compact, details, preview. |
| Inspector | 280–480px, drag to resize | yes, `F4` or **Show inspector** in the `☰` | Width remembered per library, like the sidebar's. **Always drawn while it is shown**, and unmounted when it is not — it asks the engine for a detail or a summary on every change of selection, and a panel nobody can see should ask for nothing. An empty selection gets the empty state from §8, never a shell of disabled controls. Reserves a scrollbar gutter, as the grid does: how tall its content is depends on the asset, so without one the panel's fields shift sideways as the selection moves. |
| Status bar | full | no | Counts on the left, background jobs on the right. |

**The seam between two columns is the handle.** A drag moves it; the hit area hangs either side of
the line so that a 1px border is not a 1px target, and it is **never resized by a state** — a strip
that narrowed under the pointer would shrink out from under the hand on it. `Home`-less on purpose:
a **double-click** puts the pane back to the width the library started at, which is what a file
manager does with the same seam. It is a `separator` and takes focus, so `←` and `→` move it by 16px
each, always in the direction the *pane* grows rather than the direction the seam does — for the
inspector those are opposite, and an arrow that widened the column it is pushing into would be the
key lying about itself. A width reaches the library once, when the gesture ends: while the pointer
is down the number is written straight to the row's `--sidebar-width` / `--inspector-width` and
nothing re-renders, because a drag emits an event per pixel and the grid does not read the number
at all — it reflows from watching its own box.

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
the commands that belong to the application live in the toolbar's `☰` instead: **Show sidebar**,
**Show inspector**, **Copy and drag by name**, **Reclaim space…**, **Rename library…** (§3.15),
**Close library**, **About Roost…** and **Quit**, and nothing that already has a home. The two
pane checkboxes are first, and they are the only items in here used more than once: they say **what the
window is made of**, which is why they are not in the view control — that menu says how the
*results* are drawn, and every other item in it changes a cell (ADR-0028 §6). **Copy and drag by
name** is a checkbox of its own between separators, ticked by default and remembered by the library
(ADR-0034 §8). Ticked, **Copy file** and a drag out of the window hand over a copy under the name
the library shows, staged in `staging/`. Unticked, they hand over the library's own file under its
id, and nothing is copied. It is here rather than in the context menu because it is answered once
for a library rather than at every copy. Reclaiming is there because it
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
--folder-back         --folder-front
--link
--shadow-1            --shadow-2
```

`--folder-back` and `--folder-front` are the two tones of the folder drawn in the grid (§6,
ADR-0043). One step apart on the accent ramp, and two rather than one because a silhouette in a
single fill is a blob at 40px and a slab of colour at 400 — the sheet in front of the tab is what
makes the shape read as a folder at both ends.

`--link` is separate from `--accent` because the two are used differently: `--accent` fills a
button and carries `--accent-text` on top of it, while `--link` *is* text on the surface behind
it, which needs the contrast a fill does not. One step along the ramp, in whichever direction the
theme reads as brighter.

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

**A count is grouped in English, not in the machine's locale.** `counted()` in `format.ts` is
the one place that does it, pinned to `en-US`; `toLocaleString()` with no argument is what it
replaced. The interface has one language (`CLAUDE.md` §2) and the thousands separator is part of
it: an English sentence reading *"1.234 assets"* on a machine set to Indonesian says one and a
bit. It is also what makes the rendering assertable — three renderer tests had been pinning the
en-US spelling and passing only because CI runs in it, which is how this was found. **A date is
not covered by this** and still follows the machine, deliberately: the order of a day and a
month is not a separator, and nobody has decided it.

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

**The window itself never scrolls.** Every scroller here is a named region — the sidebar, the
grid, the inspector, a dialog's list — and each is sized to the frame it sits in, so a bar down
the *outside* of the inspector's is never a view of anything: it is something half a pixel out of
place, and it lets the whole layout be dragged up under a status bar that stays where it is.
Reported on 2026-09-10, from a status bar whose failure count is the one line in it that is a
`button` and therefore the one line that took `--control-height` — a pixel taller than the bar's
content box. So `html` is clipped, and `check-failures.mjs` asserts that nothing overflows the
frame: clipping hides the symptom, and the assertion is what keeps the cause visible.

## 3. Components

The inventory, with what each one owes. "Owns state" means it holds state no parent needs.

| Component | Region | Owns state | Notes |
| --- | --- | --- | --- |
| `AppShell` | — | panel sizes, theme | Grid template, resize handles, keyboard scope root |
| `LibraryPicker` | full screen | — | First run and library switching. Recent list, create, open |
| `RecentList` | picker | — | The libraries this machine has opened. Pin, forget; §3.1 |
| `LostNotice` | picker | — | Why the picker is up when nobody closed the library: its folder left its path. §3.15, ADR-0056 |
| `RenameLibraryDialog` | overlay | the draft name | Rename library…, which renames the folder. §3.15, ADR-0056 |
| `Toolbar` | toolbar | — | Composes the four below |
| `SearchField` | toolbar | draft text | RQL input; §5 |
| `ViewMenu` | toolbar | — | One button, one menu: the views, the proportion checkbox, zoom, and a Sort By submenu of six orders. ADR-0018, ADR-0039 |
| `AddMenu` | toolbar | — | One button, one menu: the four ways an asset comes into being. §1 |
| `AssetContextMenu` | content | — | Right-click on the selection; §3.3. Native menus were considered and rejected; ADR-0021 |
| `TransferMenu` | `AssetContextMenu` | — | Move to library and Copy to library, two submenus of the recent list; §3.3, ADR-0054 |
| `TransferStatus` | status bar | — | A running transfer: bar, percentage, bytes, assets, and × to stop it; §3.3, ADR-0054 §3.9 |
| `ImportStatus` | status bar | — | A running import: counting, then bar, percentage, bytes, files, and × to stop it; the outcome afterwards; §8, ADR-0055 |
| `NavTree` | sidebar | — | Smart folders and the flat sections; §4.2 |
| `Folders` | sidebar | — | The one section that is a tree: disclosure arrows, a `+` in its heading, and a right-click menu. Expansion is the window's, so a new subfolder can be revealed; ADR-0033 |
| `FolderDialog` | overlay | draft | Naming a folder, for both **New folder** and **Rename**. The engine refuses a bad name; the dialog draws its message and stays open |
| `TagList` | sidebar | expansion | Grouped, with counts |
| `AssetGrid` | content | scroll, pages | Virtualized; §6. Icons and compact are one component |
| `AssetCell` | content | — | `memo`, primitive props only |
| `AssetList` | content | scroll, pages | Details view; same paging hook |
| `PreviewPane` | content | — | Image, video, audio, PDF, fallback; §7 |
| `Transport` | content | position, loop | The player's own controls, over a `<video controls={false}>`. Timeline, buffered ranges, volume, fullscreen, picture-in-picture, the comment marks, and what the native bar withholds — frame stepping, playback rate, an A-B loop; §7. ADR-0024 |
| `Inspector` | inspector | field drafts | Always drawn; empty selection gets §8's empty state. With one asset selected, **its picture is the file**: dragging it drags the file out of the window, as a cell does (ADR-0034 §7). Under the picture, a quiet **Custom thumbnail** where somebody chose it (ADR-0060, §3.3) |
| `FilterBar` | content | menu open, search draft | Tags, rating and file type over the grid, then **Show subfolder contents**. A **view of the query**: read with `query:split`, written with `query:join` and `query:subfolders`. Tags carry an Any/All rule the window remembers where the query cannot hold it; the depth falls back to the library's setting the same way. §4.4. ADR-0035, ADR-0036 |
| `NameField` | inspector | draft | The panel's heading, and the only editable name. Holds the **stem**: the extension is not editable and is not shown here. **Wraps over as many lines as the name takes**; `Enter` commits and a name never holds one. §3.10 |
| `RatingControl` | inspector | — | 0–5, `null` is not 0 |
| `TagEditor` | inspector | draft | Typeahead over the tags the library already has, creates on Enter. §3.7 |
| `FolderEditor` | inspector | — | The folders the selection is in, with an `×` each, and a menu of the whole tree to add one — capped to the room there is for it, and searched past eight folders. Creates nothing. §3.9 |
| `NoteField` | inspector | draft | Autosaves on blur and after 1s idle |
| `SourceField` | inspector | draft | Where the file came from. One line, saves on blur, idle, and `Enter`; offers to open only an `http(s)` value. §3.6. ADR-0030 |
| `Comments` | inspector | drafts | Several comments where the note is one; each may carry a moment. §3.5 |
| `MetadataTable` | inspector | — | Key/value, monospace values, copy on click. Since M4 it also carries duration, page count, and whatever the format's own backend reported — a font's family and style, a video's codec — labelled where the label is known and under the property's own name where it is not, so a new backend is visible before any interface code is written for it. **Labels are qualified where two properties would otherwise share one**: `Video codec` and `Audio codec`, never two rows both saying `Codec` |
| `StatusBar` | status | — | Counts, and one row per running job |
| `ImportDropZone` | overlay | — | Whole-window drop target; appears only while dragging |
| `ContextMenu` | overlay | — | One implementation, driven by a descriptor |
| `Dialog` | overlay | — | Focus trap, Escape, one at a time |
| `ConfirmDialog` | overlay | — | An alert dialog, not a panel: no close button, no dismiss on an outside click, focus starts on Cancel. Irreversible actions only; §3.4 |
| `AboutDialog` | overlay | which panel | Which build this is, who owns it, how to reach support, and the third-party licences the binary ships with. §3.12. ADR-0038 |
| `Credit` | picker | — | One line under the picker, because the `☰` is not drawn until a library is open. §3.12 |
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
- **A library that has gone is shown and marked, not hidden.** Struck through, saying "Missing",
  with its own way to be forgotten. A list that quietly shrinks reads as the application having
  forgotten, and leaves the reader unsure whether they imagined the library or lost it.
- **A missing row still asks.** The mark is a `stat` taken when the list was read, not a property
  of the library, and the commonest reason for it is a removable drive: somebody sees "Missing",
  plugs the drive in, and clicks the row. It was refused until 2026-09-10 — the one moment the
  answer had just changed was the one moment the row would not ask. A click that fails re-reads the
  list, so the row is re-marked from the new answer rather than left looking as though it worked,
  and the reason distinguishes **a path that is not there** (`library_not_found` — check the drive)
  from **a directory holding no `library.json`** (`not_a_library` — the wrong folder).
- **Nothing at all on a first run.** No heading, no empty box (§8) — the picker is then exactly
  what it was before this existed.
- Relative times are coarse on purpose: "Yesterday", "3 days ago", and a date past a week. The
  question is which library, not how many hours.
- **A row is named by its folder** (ADR-0056), read when the list is drawn, so a library renamed in
  a file manager is listed under its new name. Opened again from its new path, it **takes the
  place of the row it left**, pin and all, recognised by its `library.json` id. That id is trusted
  only where the old path no longer holds a library: a library and a copy of it carry one id, and
  both keep their rows.

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
| Note, Source | The value they share, edited as for one asset. When they differ, the field is empty and its placeholder says how: *Mixed — 2 different notes*, or *Mixed — 1 of 3 have a source*. A write then asks first — *Replace the note on 12 assets? 3 of them already have one.* It saves on blur and never on the idle timer, and Cancel empties the field again. ADR-0048 |
| Metadata | Total size and the commonest kinds. Nothing per-asset |

**What it deliberately does not show**, each for its own reason:

- **No name field.** A name belongs to one asset.
- ~~**No note, and no source.**~~ Until 2026-09-24: *writing either across twelve would silently
  destroy eleven*. ADR-0048 keeps the word **silently** as the rule rather than the refusal. A
  write across a selection that disagrees is asked about first, and one across a selection that
  agrees replaces only what is on screen.
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
| **Set thumbnail from clipboard** | an image on the clipboard, or an image file copied in a file manager, drawn as its thumbnail (ADR-0060) | the same picture on every one |
| **Set thumbnail from file…** | the system's open dialog, offering images first | the same |
| **Remove custom thumbnail** | only where one is shown; the file's own picture is drawn again | from every one that has one |
| **Copy file** `Ctrl+C` | the file itself, for pasting into a file manager — a copy under the name the library shows, staged in the library (ADR-0034); the library's own file under its id where **Copy and drag by name** is off (§1, ADR-0034 §8) | `Copy N files` |
| **Copy image** | the picture, as a full-size PNG, for pasting into a chat, an editor or a slide. Disabled over anything but a picture (ADR-0034 §5) | disabled — a clipboard holds one picture |
| **Copy path** | one path | `Copy N paths`, one per line |
| **Export…** | a directory chooser, then a copy out | `Export N assets…` |
| **Move to library ›** | a submenu of the recent libraries; the asset goes there with everything written about it, and leaves this one (ADR-0054) | the same, for the whole selection |
| **Copy to library ›** | the same submenu; the asset arrives there and stays here too | the same |
| **Move to trash** | reversible, so it asks nothing | `Move N assets to trash` |

**Move to library and Copy to library are over the grid only**, below a separator of their own.
Over the preview, moving the asset on screen out of the library would leave the pane showing
something no longer here. Each submenu is the picker's recent list (§3.1), read when the menu opens:
the libraries that are still there, pinned first and then most recent first, never the one that is
open. With none to offer, it holds one disabled row, *No other library in the recent list*, which
says where the list comes from and so how to fill it. While a transfer runs, both submenus are
disabled, because the engine takes one at a time.

**The transfer is drawn in the status bar while it runs** (ADR-0054 §3.9), because onto a hard disk
it can take minutes. There is a bar, then a percentage, the bytes and the assets:
`Moving to Photos… 28% · 2.1 GiB of 7.4 GiB · 1 of 3`. **×** beside it stops the transfer. What has
arrived stays arrived and, for a move, leaves this library. The rest stays here, and the chip says
`Stopping…` while the file in hand is abandoned. When the transfer ends, the chip gives way to a
note of what arrived, what was merged onto a file the target already held, and what stayed here
and why: `Moved 12 assets to Photos · 2 already there, merged · 1 not on this machine, left here`,
or `Stopped · Moved 4 assets to Photos · the rest are still here`. **Neither gesture asks first.** A
move is undone by moving back, and it loses nothing but the ids. The assets that left are taken out
of the selection, and only those: minutes may have passed, and what is selected may be something
else by then.

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

**A thumbnail somebody chose** (ADR-0060) is three rows below their own separator, after the two
frame rows where those are drawn. The first two are always there and always live, over any file and
any number of them: knowing whether the clipboard holds an image would be a round trip to main
every time the menu opened, so a clipboard holding nothing usable is said in the status bar instead,
*Nothing on the clipboard can be a thumbnail — copy an image*. A closed dialog says nothing.
**Remove custom thumbnail** is drawn only when a selected card has one, which the cards say without
asking (`chosenThumbnail`). The image is drawn at the sizes every thumbnail has, kept in
`thumbs/roost.db` and nowhere else, and never drawn over: a file edited elsewhere is measured again
and keeps it, and a frame pinned meanwhile waits until it is removed. The inspector says **Custom
thumbnail** under its picture (§3, `Inspector`). The preview pane is unchanged.

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
conditions that make it the opposite of the pattern RL-51 forbids: the user picked
the directory in a dialog, and nothing inside the library is moved, modified, or removed. Files
land under the name the library shows, not the one on disk — a folder of ids is not an export
anyone wanted — and a name the destination already holds gets a numbered suffix. The
status bar says how many were renamed, because a silent rename means the file they go looking
for afterwards is not called what they expect.

**An action that removes assets from the view clears the selection.** Trashing, restoring, and
deleting all take their assets out of the place they were selected in; a selection left naming
them says "1 selected" over a grid with nothing highlighted, keeps the inspector editing a
trashed asset, and leaves the roving ring with nowhere to go. Exporting does not clear it — an
export takes nothing off screen. Found by driving a real window on 2026-09-01, and invisible to
every component test, because no component owns a selection *and* a grid.

**Everything else stays where it was.** The rows that went are taken out of the grid, and the
grid is not paged again. The scroll position holds, and the roving ring moves to the asset that
takes the gone one's place: the next one, or the one before when nothing comes after it. A file
manager does the same, and so does `Ctrl+Delete` in a folder and a drag out of one. In the
preview, that means the pane steps on to the neighbour. The window tells itself how far the counts
will move before it asks (`expectRows`), so the re-read that follows recognises its own change.
If the counts moved by anything else at the same moment, the grid pages again from the top, as it
always did. Reported on 2026-10-05: trashing an asset sent the grid back to the top, because the
trash count moved and the ring was left on an asset that was gone.

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

**A tag already on the asset is a chip, and clicking its name filters by it.** Asked for on
2026-09-07, from a panel where the only way to see everything else carrying a tag was to find that
tag again in the sidebar. The filter replaces the query exactly as clicking the row in the
navigation pane does, and the `×` beside the name removes the tag. It was a **right-click menu**
first — *Filter by this tag* and *Remove tag* — and the user asked on 2026-09-24 for the filter to
be one click, the gesture the folder chip in §3.9 already had. With the filter on the name, the
menu held nothing the `×` does not, so **there is no menu**: right-clicking a chip does nothing.

**The query travels; it is never assembled.** The chip filters with the RQL the engine wrote for
that tag's sidebar row, quoting included — the rule §4.1 states for the pane, and the same reason:
a renderer spelling `tag:Some Name` is a second implementation of the grammar and the one that
gets it wrong. A tag the sidebar has not caught up with — the moment after one is added — leaves
the name **disabled** until it has.

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
items before the run began. Since ADR-0055 a directory has one too: it is counted before it is
read, and the bar fills in bytes (§8).

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

**The menu is as tall as there is room for, and then it scrolls, and past a listful of folders it
is searched.** Both from a screenshot on 2026-09-09: twenty folders opened from a control two
thirds of the way down the panel, drawn at their natural height, with the first rows off the top of
the screen. A fraction of the window is not the cap either — 60vh is more than the room above that
trigger — so the cap is the room `radix-ui` measures between the trigger and the edge of the
window. The field is the **filter bar's rule** rather than the pane's magnifier (§4.4, ADR-0033
§6): a menu is only on screen while it is being used, so a row spent on a field costs nothing when
it is not. It searches by the **pane's rule** — a match where it sits, the folders holding it up
along as context, a match's own subtree left out — because the indentation is what tells two
folders of one name apart, and a match without its ancestors is a row reading `post` and nothing
else. The needle is forgotten between two openings, and the caret starts in the field.

**A chip says the path, not the name**, for the same reason: it is what somebody reads before
pressing the `×` beside it.

**Clicking the path shows that folder.** Asked for on 2026-09-07: a folder chip offers one thing,
so a menu would be a click in the way. The tag chip in §3.7 had a menu then and has taken this
gesture since 2026-09-24. The name is therefore a button
— reachable from the keyboard, undressed to look like the text it replaced — and the query it
sends is the **sidebar row's own**, found by the folder's id in the tree this control already
holds. A chip whose folder the tree does not know yet is drawn plainly and does nothing, because
the panel and the navigation pane read the library separately and one can be a moment behind.

**Detaching is not deleting, and it asks nothing.** A folder is a collection, not a location
(RL-38) — leaving one changes nothing about the asset and moves nothing on disk. That is
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
file on disk is called after its id and always will be (RL-9).

**The extension is not in it.** An asset's `ext` is decided once, at import, from the file that
arrived, and `asset_rename` has never touched it — so typing over `.txt` renamed nothing: the
column, the file under `files/`, the kind the grid draws and every query that reads them went
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

**A directory comes across as a folder** (ADR-0058). Dropping `Trip 2024/`, which holds `Bali/` and
`Lombok/`, makes `Trip 2024` with `Bali` and `Lombok` inside it — under the folder on screen, or at
the top level — and each file joins the folder its own directory became. A folder already there by
that name is used rather than made again, so dropping the same directory twice fills one tree. A
folder is made as its first file arrives, so an empty directory, or one of nothing but duplicates,
makes none. Always, from the window: there is no checkbox, and a file dropped on its own lands as
it did before. The status line says how many folders the run made, because the sidebar has grown by
them without anybody making one.

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
one address (RL-11) — so a duplicate is discovered by *hashing* the incoming
file. Asking first would mean reading every candidate twice. Waiting costs nothing, because for a
duplicate the import writes nothing at all: *Ignore all* is the behaviour the run already had, and
dismissing by clicking away means the same thing. It is not an `AlertDialog` for that reason.

**The second button adds; it never moves.** An asset belongs to as many folders as it was put in, so
filing these into the folder on screen takes them out of nowhere — which is why the button carries
the folder's name rather than the word *Move*. Where no folder is open the dialog is one button
wide, and still worth drawing: a grid that did not grow reads as an import that failed until
something says otherwise.

**Duplicates from a directory have folders of their own.** When the run brought directories across,
the second button reads **Add to their folders**, with or without a folder on screen: each duplicate
joins the folder its directory became, made then if the run did not need it (ADR-0058 §3.4).

**The list is a preview and the count is not.** At most two hundred names, scrolling inside the
dialog, with the rest counted — re-importing a large directory is the ordinary way to produce a
hundred thousand duplicates. The hashes never reach the window: the engine keeps the list the run
reported, and the button acts on all of it.

### 3.12 About, and the credit under the picker

Roost is proprietary software (ADR-0038), which puts two things on the interface that an open
build could leave to the repository: **which build this is**, and **the licences of the code it
ships**. Both live in one dialog, opened from **About Roost…** in the `☰`.

```
┌──────────────────────────────────────────────┐
│  [roost]                                     │
│  A local-first digital asset manager.        │
│                                              │
│  Version 0.0.0 · 9f2c1ab · Electron 43.4.1…  │
│                                              │
│  © 2026 Digitalku. Proprietary software,     │
│  licensed for use rather than for            │
│  redistribution. Your files stay yours…      │
│                                              │
│  Home     roost.digitalku.com                │
│  Support  roostsupport@digitalku.com         │
│                                              │
│         [ Third-party licences ]  [ Close ]  │
└──────────────────────────────────────────────┘
```

**The wordmark is the title**, with the name in its `alt` — the same trade §3.1 makes, and for the
same reason: drawing the word above a picture of the word says it twice.

**The build line is one line, and it is selectable.** Version, commit, Electron, Chromium, written
to be pasted into a support email. **Both identifiers may be missing, and the line then says what
is left rather than guessing.** An unpackaged build has no version of its own — asked for one
anyway, Electron answers with *its* version, which is how this line first read "Version 43.4.1" —
so it is drawn as **Development build**; a build nobody handed a commit to (`ROOST_COMMIT`, set by
`pnpm dev` and by packaging) leaves that half out. A request that fails draws an empty line rather
than an error: somebody who came here for an address should still find it.

**Third-party licences** swaps the body for the notices, scrolling inside the dialog, and the
button becomes **Back**. The text is `THIRD-PARTY-NOTICES.md` compiled into the bundle: invariant 7
forbids fetching it and the renderer has no filesystem, so shipping it *in* the window is the only
way it can be present — and it is the way that cannot disagree with the file in the repository. It
is drawn as preformatted text rather than rendered markdown, because a legal notice's exact wording
is the point and a renderer that reflows it is a second thing that can be wrong about it.

**The homepage is a button and the address is text.** Nothing in this window navigates: a link
hands its URL to the desktop's browser through the same path a source URL uses (§3.6, ADR-0030 §5),
and that path takes `http(s)` only. The rule is not bent for our own `mailto:`, and an address that
can be selected and copied is what an email client wants anyway.

**One line sits under the picker** (§3.1): `© 2026 Digitalku · roost.digitalku.com ·
roostsupport@digitalku.com`, at the status bar's type scale. It is there because the `☰` is drawn
beside a library's name — without this line there is a state of the application, the one a first
run is in and the one a library that will not open leaves you in, where the support address cannot
be reached at all. It sits in the picker's frame rather than in its panel, so it stays put while
the panel swaps between opening a library and making one. Quiet on purpose: a credit that competes
with **Open library…** is an advert.

### 3.13 What has no preview, and why

**A file with no picture says why on itself, when it is opened** (ADR-0050). The status bar counts
nothing about it (§8), and there is no list. Until 2026-09-25 the bar carried *"36 could not be
drawn"* and the parked line, and each opened a list of reasons and file names. The user found that
this was not the question they had: *"pop up X could not be drawn tidak perlu. namun jika ada
kendala seperti itu, tampilkan ketika membuka file nya saja … isinya rekomendasi yang bisa
dilakukan untuk file tersebut"*.

There are three places, from a glance to a close look:

- **The cell** carries a badge in the warning colour, *Could not be drawn* or *Needs libheif*
  (§6.1). That is how a person finds one in a grid of pictures.
- **The inspector**, the moment the file is selected, draws a card under the thumbnail:

```
┌──────────────────────────────┐
│ The file is damaged or       │
│ incomplete                   │
│ The bytes stop before the    │
│ picture does — usually an    │
│ interrupted copy or download.│
│ • Get a fresh copy from      │
│   wherever this one came from│
│ • Show in folder, and put the│
│   fresh copy in its place    │
│   under the same name: Roost │
│   notices and draws it.      │
│ • Open it externally to check│
│   whether any application can│
│   still read this copy.      │
│ Input file has corrupt header│
│ [Try again]                  │
│ [Open externally]            │
│ [Show in folder]             │
└──────────────────────────────┘
```

- **The preview** draws the same card at full size, under the kind's outline and the line (§7.3).

**What the card says, in order.** The line, which is the interface's reading of the fault. The
hint, which says why. The **steps**, which are what to do about this file, each naming the button
it needs where one of the card's buttons is the way to do it. For a file waiting on a tool, the
**command** that would supply it. Then, small and monospaced, **what the backend actually said**.
The two voices keep their order: the translation lives in the renderer (`deriveReason.ts`) and is
stored nowhere, so a backend that rewords its errors must not mean a migration. A message the table
does not recognise still gets a card, reading *"Roost could not draw this file"*, with steps to try
once and then to check the file itself.

**Three buttons, the user's choice**: **Try again**, **Open externally**, **Show in folder**. Show
in folder is how a damaged copy gets replaced. Roost edits nothing in place, but the file is a
workspace file (RL-20): put a fresh copy there under the same name and the watcher redraws it
(ADR-0047).

**Try again means two things, and the button says which.** For a file that **failed**, it is this
file (`derive:retryAsset`), because a damaged copy replaced is one file fixed. For a file
**waiting on a tool**, it is every file waiting on the same tool (`derive:retry` with the reason),
and the label counts them: *Try again (8 files)*. Installing libheif fixes eight hundred HEICs at
once, and a button that released one would have somebody open each of them in turn. Either way it
works while the queue is paused (ADR-0049), because it is a request by name. It also ignores how
many times the job has been tried. The queue stops offering a failure after three attempts, which
is right for the sweep that runs on its own and wrong for a button somebody pressed.

**The command, and the button that runs it** (ADR-0042), moved here whole from the list. *Copy
command* is offered everywhere. *Install it* is offered only where the command needs no password,
which today means winget's ffmpeg on Windows and nothing on Linux, where every line begins with
`sudo`. **The command stays visible whether or not the button is there.** While an install runs,
the button reads *Installing…* and the package manager's latest line is drawn under it. If the
package manager refuses, its words stay. On success nothing is announced: Try again is pressed for
the person, and the pictures arriving are the answer.

**A file of kind `other` gets no card, no badge and no count.** A `.zip`, an `.xcf` and a file
nothing recognises have no picture by nature. That is the expected outcome, not news (asked for on
2026-09-24: *"file other langsung tampil saja tidak ada notifikasi"*). Their jobs stay parked, which
keeps the backfill sweep from offering them again. **An image nothing here draws still gets one**,
such as a BMP or a RAW with no embedded preview, because a picture that cannot be shown is still
worth a word.

### 3.14 What another build wrote, and this one cannot show

Roost is one format with an implementation per platform (ADR-0045), so a library may carry journal
operations this build has never heard of — a feature from a later revision of the format, or one
belonging to Roost for Windows or Roost for Mac. Those records are **skipped**, which is safe
because the journal is append-only: a record ignored here is still there when the library opens
elsewhere.

**Skipping silently is not safe**, and the format says so in a requirement (RL-28): a library that
quietly means less than it says is a library whose owner has no way to find out. So the window says
so, and the shape of the saying is the whole of this section.

**A line in the status bar, beside the derive status. Not a dialog on open.** Nothing is wrong,
nothing needs deciding, and a box in front of the grid every time somebody opens a library they
also use on another machine would be dismissed unread within a week. The line is quiet and
permanent for as long as it is true, which is the right weight for news that does not expire.

**It names the build when it can.** An operation belonging to a platform carries a prefix before a
dot — `win.shell_pin`, `mac.quicklook_tag` — and one belonging to the format carries none (RL-29).
That single character is what lets the line read *"2 only Roost for Windows shows"* rather than a
bare count. When several builds wrote the skipped records, it falls back to `4 not shown`: a list
of names does not fit in a line that already shares its row with four other things.

Clicking it opens a list, and the list leads with the reassurance rather than the detail — a column
of operation names reads like lost work, and none of it is lost. Then one row per operation with
its count and whose it is, and a closing sentence that everything else in the library is here and
safe to edit, because the journal only grows.

**A dangling reference gets no line.** A record naming a folder another build deleted is the
ordinary result of one library edited from two of them; the format counts it and logs it and calls
it a diagnostic rather than news (RL-26a). A status bar that announced it would be a status bar
announcing that somebody had used two builds.

### 3.15 The name, and the folder it comes from

**A library is called by its folder** (ADR-0056, `FORMAT.md` RL-7b). `traveling.roost` is
*traveling*, everywhere a name is drawn: the head of the window, the recent list, the transfer
submenus. Renaming the folder in a file manager while Roost has it closed is a complete rename.

**Rename library…** in the `☰` opens a dialog with one field, holding the current name selected,
and a sentence naming the folder it will become, *"The folder becomes `trip.roost`, in the same
place"*, updated as the name is typed. The sentence also says that renaming the folder in a file
manager does the same, because the dialog is where somebody learns that it does. The engine refuses
a name, not the dialog (a separator, a leading dot, a neighbour of that name), and the dialog stays
open and draws its message. The library closes and opens again under the new name. Every window
holding it redraws its head, and the grid keeps its pages and its scroll, because nothing in it
changed. The status bar says *Renamed the library to trip*.

**A folder renamed while it is open** is noticed within a second. The engine closes the library,
and every window goes back to the picker with a notice above the recent list. It is a warning, not
a problem, because nothing failed and nothing was lost:

> *traveling was renamed to trip while it was open. Roost closed it so that nothing would be written
> to the wrong place.*  **[Open trip]**

The button is there when the folder was found beside the old one, which is what a rename does. A
folder moved to another directory, or a drive unplugged, cannot be found, and the notice says so
instead: *"The folder of traveling was moved, or its drive removed, while it was open."* *Open
library…* above it is then the way back. Opening anything clears the notice.

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

**The mark for the folder on screen spans the whole line**, indentation and disclosure column
included — what every file manager does, and what this pane did not until 2026-09-13. The fill had
been on the row, which begins *after* the disclosure column, so the marked row carried a 20px notch
of page background down its left and no other row carried anything: a margin that appears on
exactly one row reads as a mistake. The depth is padding on the line, and a background paints under
padding, so the name still sits where it did.

**The pane is no longer the only way into a folder** (ADR-0043, 2026-09-13). The grid draws the
subfolders of the folder on screen, so descending happens there and the tree follows: the row
matching the query is marked as current wherever the query came from. Coming back *up* is `Alt+↑`
(§9), which matters most when this pane is hidden — `F9` can take it away, and a grid that could
only descend would leave somewhere with no way out.

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
this. Closing a branch costs no information, because **every folder's count is its subtree's**,
whatever *Show subfolder contents* says (ADR-0036 §3.3, amended 2026-10-01): a closed branch still
says how much is under it. Expansion
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

**A third control in the heading shows the folder the grid is on** (ADR-0033 §7). It opens every
branch above that row — ancestors only, never an expand-all — scrolls it into view with
`block: "nearest"` so a row already visible does not move, and leaves the focus on it, because a
scroll has nothing to point at. It clears a needle **only when the needle is hiding the row**: a
search already showing it is one somebody is still using. It is **absent, not dead**, when the grid
is not in a folder, which is the same rule as the magnifier over an empty section. It is the bill
for the two decisions above it: closing every branch and filtering the tree both mean the current
row is routinely somewhere nobody can see. Nothing reveals on its own — a pane that scrolled itself
whenever the query changed would move under the hand of anybody typing in the search field.

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

**A count beside a query is the count *of* that query**, with one exception: a folder's row counts
**what the folder holds**, its subfolders included, whatever *Show subfolder contents* says — so
with the box unticked the row can say 12 over a grid of 2. That is how a file manager counts a
folder, and the user asked for it on 2026-10-01 (ADR-0036 §3.3, amended). It is still the count of
`folder:` on that folder, **each asset once** however many of the subtree's folders hold it. Folder
and tag counts exclude trashed assets, exactly as `folder:` and `tag:` do (ADR-0022) — a sidebar
saying 3 while the grid shows 2 is the shape this goes wrong in. A tag every one of whose assets is in the trash stays
listed at zero: the tag has not been deleted, and a row vanishing says something different from a
count falling.

**A name is cut at 35 characters, and the whole one is a hover away.** Asked for on 2026-09-08,
from a pane of folder names long enough that several of them said the same thing for the first
inch. The label has ellipsised since the pane was built, but on **width** — so what was cut moved
with the pane, and at a comfortable width nothing was cut at all while one row still took the whole
column. A count of characters is the one rule that reads the same at every width; the width
ellipsis stays underneath it as a backstop for a narrow pane or a deep indent. The ellipsis is
inside the budget rather than added to it — 35 characters are drawn, not 36 — and the space of a
word cut in half goes with it. It is counted in **code points**, so an emoji in a name is one
character rather than two halves of one. The rule is the row's rather than the tree's: a smart
folder is named by hand as well, and one section cutting while the one under it does not is a
difference nobody could explain. **The tooltip is only drawn where something was taken away** — a
tooltip repeating a name already on screen is one that covers the row below while somebody reads
it — and the **whole name stays the row's accessible name**, off screen beside the cut one, because
a cut name read aloud is the half that does not say which folder.

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

**Since 2026-09-25 the same drag also leaves the window** (ADR-0034 §6): dropped on Dolphin, a
chat or an editor, it hands over the files under the names the library shows. It is a native drag,
started by main, so it carries `Files` and nothing of Roost's own. The folder rows and tiles take it
anyway by remembering which assets the window asked to drag, the import overlay ignores it, and the
cursor over a folder shows *copy* even where the drop will move, because *copy* is all a native drag
allows. **On a filesystem without reflink a drag past 200 MB stays inside the window**, and the
status bar says so: *Dragging within Roost only — 1.2 GB would be copied before the drag could
start. Copy file (Ctrl+C) hands them over instead.* The first drag of a session carries Roost's
icon, and later ones carry the thumbnail. **Where Copy and drag by name is off** (ADR-0034 §8),
the drag carries the library's own files under their ids, nothing is copied, and the 200 MB rule
does not apply.

**Since 2026-09-13 a folder row is not the only target**: the grid draws the subfolders of the
folder on screen (§6, ADR-0043), and a drop onto one of those tiles is this same gesture with this
same rule. A tile is only ever drawn *inside* a folder, so a drag from the grid onto a sibling is
always a **move** — which is what a file manager does, and the first thing anybody tries.

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

**Inside a folder, Tags and Types offer what the folder holds** (ADR-0035 §8), each value counted
there, at the depth the place asks: the subtree with *Show subfolder contents*, each asset once,
and the folder alone without it. Anywhere else, including a smart folder or a search, they offer the
library's lists. A value already ticked stays in the menu at the count it has here, so it can always
be unticked. The lists are read **when the menu opens**, never on a change of place, and until they
arrive the menu reads *Counting…*. An empty folder's menus say *No tags here* and *Nothing here*.
Rating is the same six rows everywhere.

**Under *All*, Tags counts among what is on screen** (ADR-0035 §9). With anything ticked, the number
beside each tag is how many assets the grid would hold with that tag ticked too, through every
ticked tag, rating and type over the place, and a tag none of them carries is not offered unless it
is ticked. Under *Any* the counts are the place's own, because one more tag widens the grid. Over the
whole library the sidebar's counts stand in until the narrowed ones arrive.

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
- **Nothing moves the caret.** A click lands where the pointer landed, `Ctrl+F` / `/` take the
  focus and stop there, and the query is never selected. It was built the other way first — a
  select-all, the address bar's own gesture, then a caret one space past the query, with the
  field scrolled to the end because that is where a folder path is *continued*. The user
  rejected both, the second on 2026-09-08: a field that rearranges itself under the pointer is
  one you have to undo before you can edit a term in the middle of a query, and reaching the end
  of a long one is what `End` is for. So the rule above is the only one the field has — at rest
  it shows the head, which says *which* folder; touched, it behaves like any text field. Neither
  is a substitute for the autocomplete below; the head is what makes a query too long to fit
  readable.
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

**Zoom** is **the view's own** (ADR-0039 §10): a cell's width in Icons, 120–400px in seven
steps, starting at 160; a row's height in Compact and Details, 26–72px in seven steps, starting at
30 and 34. A row's thumbnail is its height less 8px, so zooming a list makes the pictures larger
and not only the gaps; the text keeps its size. Switching views gives back the size that view was
left at. `layout()` has taken the zoom as a parameter since M3; the menu is the first thing to pass
anything but a constant. The three
controls are one row on one menu line, and **selecting one does not close the menu** — zooming
twice should not cost two trips. Each is a real menu item underneath, because a bare button
inside the content would be reachable by pointer and by nothing else (§10).

**Sort By** is a submenu of six orders and a direction (ADR-0039, built 2026-09-09). The trigger
says which one is on — *Sort By … Date added ›* — so the answer is readable without opening it.
The words are the key's own rather than a direction, because nobody wants "imported ascending":
**Newest first / Oldest first**, **A to Z / Z to A**, **Largest first**, **Highest first**. Choosing
a key **sets that key's own direction**, since keeping the last one's would make *Name* mean Z to A
for anybody looking at the newest first, which is every library by default.

**Random** is the sixth, and it has no direction — reversing a shuffle is another shuffle — so where
the two ways round would be, it offers **Shuffle again** instead. The library remembers that it is
in Random, but not which shuffle (ADR-0039 §11). A new one is rolled each time the library opens,
each time Random is chosen from another order, and by **Shuffle again**. Scrolling, switching
views, zooming and filtering leave it alone, because the grid pages by it.

**The order is not a renderer change and never was.** It is a key, an index, and a cursor per key
(ADR-0039 §4), which is why this menu carried it as a disabled promise from M3 until the engine work
was done. What the renderer owns is the vocabulary above and one rule: the grid **re-pages** when
the order changes, because a cursor belongs to the order it was handed out under.

**Group By is not here.** It stood in this menu as a disabled promise from ADR-0018 and was
withdrawn on 2026-09-09: it was never built, and a menu item that has never done anything is one
nobody should read twice.

**The view, the icon shape, the zoom and the order are the library's, not the window's**
(ADR-0039 §7). They live in `settings.json` beside *Show subfolder contents*, so a library opens as
it was left — and the first page of the grid is asked for **after** the preferences arrive, because
a page fetched in the default order would be a hundred rows thrown away and the wrong order shown
first.

**Common to every view.** Column count derives from the scroller's **content** width — not
`clientWidth`, which includes the scroller's own padding and made every view one gutter too
wide, running the last column under the scrollbar with its edge cut off. The zoom target sets
how wide a column wants to be; the filename is a reserved band under the thumbnail, never an
overlay on it. An asset with no recorded dimensions is laid out at 1:1 and re-laid out once
metadata arrives — the only reflow the grid is permitted, and it happens off-screen when the
derive queue is keeping up.

**Cell contract, non-negotiable:**
- `AssetCell` is `memo`'d and receives only primitives: `id`, `ext`, `kind`, `undrawn`, `width`,
  `height`, `name`, `isSelected`, `isFocused`. No objects, no closures, no callbacks constructed
  inline.
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
  (`CONCEPT.md` §5), so a `.blend` or a `.zip` is an ordinary member of the grid: a shape for
  its kind and the extension set in the monospace stack, legible at the smallest zoom, over the
  surface colour — never a broken-image glyph and never an empty box. Where the queue has given
  up on a picture for a reason somebody can act on, it says so (§6.1).
- **A picture carries its extension in its corner**, in Icons only (the user's ask, 2026-10-05):
  a still from an `.mp4` and a `.jpg` otherwise look alike, and the name under a cell is the stem.
  A small monospace chip, bottom left, in `--on-image-bg` and `--on-image-text` — one pair for
  both themes, because what it sits on is the file's colours. It is **shown by CSS once the image
  has loaded** (`data-loaded`, set and cleared beside `hidden`), so a cell with no picture is not
  labelled twice, and costs the memo nothing. Not in Compact or Details, whose rows say it in
  *Kind*; not hidden at the smallest zoom, because Icons stop at 120px.

**Folders are drawn in the grid, and they are not results** (ADR-0043, built 2026-09-13). Where
the query is one folder's own contents, its subfolders are laid out **ahead of the assets** — a
sheet, the name in the caption band, the count beside it — so that descending into a library is
the gesture a file manager has taught everybody.

**A folder is a punched sheet protector with its pictures in it** (ADR-0043 §7). This is the
user's own drawing of 2026-09-25, and it replaced a two-tone folder glyph. Down the left is a
strip of holes, then a fold line, then a body with rounded right-hand corners holding **up to four
of the folder's pictures**. They are the newest, the folder's own first and then its subfolders',
so a folder that holds only folders still shows what is in it. One picture fills the sheet, and
two to four sit in a 2×2. The holes and the fold line are the ground showing through
(`--folder-hole`), and the sleeve is a grey (`--folder-sheet`) rather than the accent, because the
pictures are the colour and a sleeve competing with them would be the loudest thing in a grid of
photographs. The pictures are `roost://thumb` addresses the engine names through `folder:covers`,
asked once whenever the list of subfolders is read again. That happens when the library changes,
so a cover follows imports and derives without a timer. **Its size is per view**: a row holds **the sleeve without pictures**, because in a list the name is what is
read — but punched to pixels rather than scaled from the tile, three round holes in a 6-pixel
strip, since scaled down the holes were a pixel wide and the row showed a grey rectangle
(2026-09-25) — and in Icons the sheet takes
most of the picture area's height, capped so it never reads as a panel.
**The count rides in the caption beside the name**, where every view has room for text, rather
than as a badge over a filled shape. Four things follow, and none of them is
negotiable:

- **A tile is a control.** It is not paged (the children of one folder are already in the window,
  as the pane's own tree), not taken by `Ctrl+A`, not swept by the marquee, and never in the
  selection. Its mark is the ring: the selection is what the inspector, the trash and every edit
  read, and a folder among those hashes would be an edit aimed at nothing.
- **A click marks, a double-click or `Enter` opens.** Explorer's gesture, chosen on 2026-09-13
  over the sidebar's one-click, because a hand that learned it there double-clicks whatever this
  build prefers — and with the first click navigating, the second lands on a grid that has
  changed.
- **They are drawn only where the query is a place and nothing more.** A filter over the folder
  takes them away, which is right: a subfolder does not have five stars. *Show subfolder contents*
  does **not** (ADR-0043 §3, amended 2026-10-01): a tile is a way in, so it offers no asset twice
  when the subtree's assets are around it. An asset moved onto a subfolder's tile from there stays
  drawn, because it is still beneath the folder on screen.
- **A typed search draws the folders it finds by name** (ADR-0057), ahead of the assets it finds,
  while the query is words and at most one folder. Every word must be a **whole word** of the
  folder's name, split as the full-text index splits an asset's, so a word finds a folder exactly
  when it would find a file of the same name. Typed inside a folder, the words look through the
  whole subtree beneath it. Each such tile says **where it is**: the parent's path, quieted, before
  the name, giving way first when the caption is short, because names repeat. Any other term — a
  tag, a rating, a type — draws none. A drop of assets onto one adds, since a search is not a
  folder to move out of, and opening one is a change of place that Back returns from.
- **Always first, and by name**, whatever the order is. Five of the six sort keys mean nothing to
  a shelf; `random` shuffles the assets and leaves the folders where they are.

**With *Show subfolder contents* on, a folder's own assets come first** (ADR-0059): the tiles, then
what is directly in the folder, then a band across the grid — **In subfolders · 412**, in the voice
of a sidebar heading — and then everything beneath it, each part in the order the view menu chose.
The rows above the band end ragged, so the two parts never share a row. The band is not a tile and
cannot be selected. An asset in the folder and in a subfolder of it is in the first part only. A
filter keeps the grouping, because the grouping says *where* and the filter *what*.

**Show folders** is the view menu's fifth setting, on by default and remembered by the library, and
it turns off both kinds of tile. It was disabled while *Show subfolder contents* was on, until the
tiles were drawn there too. Going back up is `Alt+↑` (§9): the tiles only descend, and the tree that used to be the
only way out of a folder can now be hidden.

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

### 6.1 A cell with no picture, and why

Reported on 2026-09-24 against a library of HEIC photographs and HEVC clips on a machine with
neither decoder: *"tidak sekedar blank gitu saja"*. Every one of them was a grey square with its
extension in it — exactly what a photograph still in the queue looks like, and exactly what a
`.zip` that will never have a picture looks like. Three different states, one drawing.

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│              │  │              │  │     MP4      │  ← a short cell keeps the
│     ▣        │  │     ▷        │  │ ⚠ No HEVC    │    words and drops the shape
│    HEIC      │  │    ZIP       │  │   decoder    │
│ ⚠ Needs      │  │              │  └──────────────┘
│   libheif    │  │              │
└──────────────┘  └──────────────┘
```

**The placeholder says three things now**: the kind, as an outline — a photograph, a film, a
sound, a page, a letter, a file; the extension, as before; and, **only where the queue has
stalled on a reason somebody can act on**, a few words in the warning colour with the whole
sentence as a tooltip — *Needs libheif*, *No HEVC decoder*, *Needs ffmpeg*, *File is missing*,
*Could not be drawn*. The sentence is `deriveReason.ts`'s, the same one the file's card (§3.13)
heads itself with, so the two never describe one file differently.

**A format nothing draws gets no badge.** A `.zip` without a picture is what a library that holds
anything looks like, not a fault, and a warning on every archive would teach people to read past
the one on a photograph. `unsupported:` is the one family of reasons the badge ignores.

**The reason is on the card**, as `undrawn`: the stalled job's reason in the queue's own words,
or `null` — drawn, or not reached yet. It is read **after** a page rather than joined into it,
one lookup per card on the job table's `(kind, asset_id)` key, because the random order has no
index and sorts every match (ADR-0039): a column computed in the page query would be computed for
all of them. It is raw rather than a sentence, so a backend that rewords an error changes the
window and not the engine.

**It arrives as the queue decides**, not at the next re-page. `assets:derived` carried only the
assets a derive *drew*; it now carries the ones it parked and failed too, each with its reason,
and with `derivedAt: null` where nothing about the file was written — which the card reads as
"keep the key you have", not "forget it". A successful derive carries `undrawn: null`, which is
what clears a badge a retry has just made obsolete.

**It is drawn under the thumbnail like the rest of the placeholder.** So an asset whose re-derive
failed after an edit keeps the picture it had, and the badge beneath it is never seen — which is
right: there is still a picture.

**A short cell drops the shape first.** The placeholder is a size container — its size is its
cell's and never its content's, so containing it costs the layout nothing — and below 104px tall
the outline goes, and below 56px the extension too, where there is a badge to keep. A wide video
at a small zoom is the cell this is for. **A row's thumbnail** in Compact and Details has room for
neither: it shows the extension alone, in the warning colour where there is a badge.

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
empty. The sidebar and the inspector stay if they are shown, because both are still about the
thing on screen. The
field is unmounted rather than emptied: the query it was showing comes back when the preview
closes.

**The `☰` is drawn in this head when the sidebar is hidden** (ADR-0028 §6), before the slot and at
the start of the row — the corner it occupies in the other two heads, so it does not move as a
preview opens. It is there only then: with the sidebar shown the button is at that column's head,
and a preview is not a place to repeat a control already on screen. Bringing the sidebar back from
it moves the button away mid-gesture, so **the pane takes focus back** whenever the button arrives
or leaves; without that, focus lands on `<body>` and `Escape`, the arrows and the media keys are
dead until something is clicked.

**The file itself is picked up from the inspector's picture** (ADR-0034 §7), which a drag from is a
drag of the file: out of the window as a file where a drag from the grid would go out, and onto a
folder in the sidebar otherwise. The preview's own picture cannot be the handle, because a drag
across a photograph pans it and a drag along a timeline seeks. **While the inspector is hidden**,
a thumbnail the size of the controls beside it stands in the head before the arrows and does the
same job. There is one handle at a time, wherever there is room for it, as there is one `☰`. Both
are pointer-only, since `Ctrl+C` hands over the same file from the keyboard.

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
| Image | `<img src="roost://file/<id>">`, fit to pane, and zoomable: the wheel, two buttons and a readout, `+`/`-`, click to toggle 1:1, drag to pan |
| SVG | Same, sandboxed — scripts in an SVG do not run |
| Video / audio | `<video>` / `<audio>` over `roost://file/`, which answers range requests, under a transport of ours — `controls` is off. **Fit** in the head scales a small video up to the pane |
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
| **Back / forward five seconds** | Two buttons **side by side**, after the play cluster, and `J` / `L`. Together rather than either side of play (2026-09-13): one gesture with two directions, and a pair reads as one control where a split reads as two. One constant behind both, and it is **drawn on the buttons**: an arrow is the one control in this bar whose amount cannot be guessed, and a tooltip is not an answer for a button somebody is about to press. Asked for on 2026-09-13, which moved the keys from ten to fifteen; five since 2026-10-23, at the user's word |
| Timeline | A `role="slider"` whose `aria-valuetext` is a timecode, never a count of milliseconds. Arrow keys move a tenth of a second, which is the precision a comment's moment carries |
| Buffered ranges | Drawn from `video.buffered`, behind the played range — the difference between a slow file and a broken one |
| Elapsed / duration | Monospace and tabular, so the digits do not dance. **To the second**, both of them: a comment's moment carries a tenth because somebody chose it, and a playhead only passes through. The elapsed is floored — at 16:12.6 you are in the twelfth second — and the total is rounded, which is the same number the inspector's Duration row shows |
| Volume and mute | `M`, and a slider that is also a slider to a screen reader. **Both are remembered by the library** (ADR-0024 §9): a player opens where the last one was left, not at full volume, and a silenced one opens silent |
| Fullscreen | On the **player's box**, not on the video: sending the video alone takes the controls off the screen with it |
| Picture-in-picture | Video only. Audio has no picture |
| **Comment marks** | One per **timed** comment, at its moment. Click to seek, hover for the text, and each names its moment and its words to a screen reader |
| **Subtitles** | A `CC` menu listing the tracks attached to this asset, **Off** first, and **Add subtitle…** last. Drawn for every video, because the moment somebody notices there are none is the moment they want to add one |
| Frame stepping | One frame a press, ten from the keyboard. Only where the probe recorded a frame rate: a step is arithmetic on it, and a missing one has to mean no stepping rather than a step of `Infinity`. Stepping pauses first — a step while playing is not a step |
| Playback rate | 0.25× to 8×, in a menu that shows the current one as text. The extremes play **silently**: the platform stops stretching sound outside roughly 0.5×–4×, and the menu says so rather than letting it read as a fault |
| A-B loop | One button and three states — set the start, set the end, clear — plus `I` and `O`. The region is drawn along the track, and a start with no end is a mark rather than a band, because the loop is not running yet |

**The transport is the foot of the pane, and it spans it.** The picture takes whatever is left
above it, centred and fitted rather than filled, so a small video keeps its own pixels — unless
**Fit** says otherwise, which is the paragraph after this one. Until
2026-09-05 the player shrink-wrapped the media and the bar was a caption under it, which put the
controls wherever the file's aspect ratio happened to end — a different place for every asset — and
gave a portrait video a timeline a few hundred pixels long. A bar that stands still is a bar the
hand can find without looking, and the longest timeline the pane can give is the finest resolution
somebody scrubbing can aim with. `<audio>` is the exception, and for the reason that proves the
rule: with no picture above it there is nothing for the bar to be the foot of, so it stays in the
middle of the pane.

**Fit to window is a mode, and it is off by default** (ADR-0024 §8). Asked for on 2026-09-08 —
*"ketika memutar video apakah memungkinkan di beirkan tombol fit to window? supaya videonya gak
kekecilan jika memutar resolusi rendah"*. The rule above fits in one direction only: `max-*` brings
a video **larger** than the pane down to it and leaves a smaller one exactly where it is, so a
320×240 clip sat in the middle of a pane ten times its area. **Fit** is a button in the head of the
pane, beside where a picture's zoom controls stand, and it scales a video up to the room it has —
`object-fit: contain`, so what it gains is size and never a crop. It is drawn **pressed** rather
than as something that happens once, because the question is standing: a video too big for the pane
looks the same either way, and the next video wants the same answer as this one. That is why the
answer is remembered in the library's `settings.json` (ADR-0019) rather than forgotten per asset the
way the picture's zoom deliberately is — a scale chosen for one photograph is not a fact about the
next, and eyesight is. Audio has no picture and therefore no button.

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

**The loudness is the exception on the way in.** An element starts at full volume every time one is
made, and the pane makes a new one per asset, so the level and the mute are seeded from the library
(`settings.json`, as a whole percent) and put on in the element's ref callback — before an `autoPlay`
clip whose bytes are cached can be heard. Everything after that is still the element's: the slider,
the button and `M` all reach it, and what it announces is what gets remembered. It is held in a
store beside `playhead` rather than in the window's state, because a slider drag emits a change per
pixel and the grid behind the preview must not re-render for a number it does not draw.

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

### 7.1 Three formats the pane cannot read itself

An asset's own bytes go into an `<img>`, which is right for a JPEG and empty for **HEIC**, **RAW**
and **TIFF**: Chromium decodes none of the three. They arrive instead as a rendition over
`roost://render/<hash>` — the HEIC assembled from its tiles by libheif, a RAW's embedded JPEG, a
TIFF re-encoded — at full resolution, so the zoom in §7 still means something. `browserDrawable` on
the asset's detail is what the pane switches on, and the engine decides it from the format table
rather than the pane guessing from an extension (ADR-0040 §7).

Where the rendition cannot be made — a machine with no libheif, a RAW with no embedded preview —
the route answers 404 and the pane steps down to the thumbnail, at `@512` and then `@256`. Where
there is no thumbnail either, which on a machine with no libheif is every HEIC, it says why
(§7.3). Never a broken-image glyph, and never an empty pane.

**The step down matched only version 1's hashes** until 2026-09-24. It read the id back out of
`roost://render/<id>` with a pattern for sixty-four hex digits, which a version 2 id — twelve
characters of Crockford base32 (RL-13) — never is, so every failed rendition went straight to
hidden and the pane opened empty. The tests carried 64-hex ids and passed throughout.

**`browserDrawable` decides this for an `<img>` and for nothing else.** It is false for every video
and audio format there is — they are not things an `<img>` draws — so a pane that consulted it
before choosing a source sent every `<video>` to `roost://render/<hash>`, which has no rendition for
an mp4 and answers 404. A player and a picture ask different questions of the same field, and from
2026-09-10 until it was found on 2026-09-13 every video and every sound in a library opened blank.
A video and a sound take the original, always: it is what makes seeking work, and there is no
rendition of a film.

### 7.2 A video the window cannot play

**A thumbnail is not a promise that the pane can play it.** The thumbnail is drawn by the system's
ffmpeg (ADR-0017) and the pane hands the file's own bytes to Chromium, which ships a narrower list
of codecs — HEVC the obvious one. So the two disagree, and the disagreement looked like a bug in the
pane: reported on 2026-09-13 as a grid full of thumbnails and a preview that opened blank.

A picture that fails falls back to its thumbnail; a video has nothing to fall back to, so it says
what happened instead — one line under the picture, over the transport, **and the element's own
words under that**: the same two voices, in the same order, as the file's card (§3.13).
The codec is named, because *"this window could not play hevc files"* is something a person can act
on and *"the video could not be played"* is not.

**The second voice is not decoration, and the first thing it caught proves it.** `MediaError` has
three codes for more than three faults: a codec with no decoder and a route that answered 404 are
*the same code*, and only one of them is a bug in Roost. The message this pane was built to give
blamed the codec — the element's own *Format error* under it is what pointed at the request
instead, and the request turned out to be asking `roost://render/<hash>` for a video (§7.1). So the
sentence for that code names both faults rather than choosing, and the original line stays under it.
A load that was merely replaced — which happens on every step through the grid — says nothing.

**The commonest case raises no error at all.** Chromium drops a video track it has no decoder for
and plays the rest, so an HEVC clip with AAC sound — which is what a phone records — loads,
reports its duration and plays the sound under an empty rectangle, with the timeline moving
(measured on 2026-09-24 against Electron 43, which has no HEVC decoder whatever the system has
installed). The one sign is a `videoWidth` of zero at `loadedmetadata`, and it means something
only where the probe found a picture: an `.mp4` that is only sound is zero wide too, and is simply
audio. The pane **pauses** it and says so (§7.3). A clip with *no* sound has nothing left to play,
and that one does raise the error above.

### 7.3 What stands where the asset cannot be shown

Both of the above used to end somewhere blank: a picture with no rendition and no thumbnail hid
its `<img>`, and a video whose picture could not be decoded played its sound under nothing. An
empty pane reads as a bug in Roost, and neither was one. Where the pane cannot show the asset it
now shows this instead, centred in the room the asset would have had:

```
┌───────────────────────────────────────────────────┐
│ Fit                              ←   →   Close    │
├───────────────────────────────────────────────────┤
│                         ▷                         │
│                        MP4                        │
│     This window cannot play HEVC (H.265) video    │
│      The sound can still be played — only the     │
│     picture is missing. Chromium, which draws     │
│        this window, has no decoder for it …       │
│      1920 × 1080 · 0:06 · HEVC (H.265) / AAC      │
│                                                   │
│   ┌ The installed ffmpeg cannot decode HEVC ┐     │
│   │ • Replace the installed ffmpeg …        │     │
│   │ sudo dnf swap ffmpeg-free ffmpeg …      │     │
│   │ [Try again (7 files)] [Open externally] │     │
│   └ [Show in folder]                        ┘     │
├───────────────────────────────────────────────────┤
│ ▶  0:00 / 0:06  ──────────────────────────  🔊     │
└───────────────────────────────────────────────────┘
```

**In order: what it is, why it is not here, what is known anyway, and what can be done.** The
kind's outline and the extension, as the cell draws them (§6.1). One sentence — the card's line
for the asset's reason where it has one, *"HEIC photographs need libheif"*; the element's
reading of its error for a video that failed; *"This window cannot play HEVC (H.265) video"* for
one whose picture was dropped. The line under it. The facts the probe found without drawing
anything, which are derived (RL-22) and so may each be missing, and a missing one is left out.
The element's own words, in monospace, where an element said any. Then the buttons.

**Where the file's derive is stalled, what can be done is the file's card** (§3.13, ADR-0050), at
full size: its steps, the command where a tool would help, and **Try again**, **Open externally**
and **Show in folder**. For a photograph the card leaves out its own line, which is already the
sentence above it. For a video it keeps its line, because the sentence above is about the window
and the card is about the thumbnail, and a different decoder draws each. Where nothing is stalled,
**Open externally** stands alone, as it does for every file the pane cannot draw. There is no card
for a format nothing draws.

**A video keeps its transport.** The element stays mounted and hidden, paused, and the timeline
under the panel plays the sound on request: sound from a preview whose picture is missing sounds
like a bug, and sound somebody asked for does not. **The sentence says which decoder is which**,
because two are involved and only one is the system's: the pane plays through Chromium's, which
is fixed when Electron is built, and the thumbnail is drawn by the system's ffmpeg (ADR-0017).
Installing something fixes the second and never the first, so the card under the sentence is
headed with the thumbnail's own problem, *"The installed ffmpeg cannot decode HEVC (H.265)"*, and
the sentence above promises nothing about playing. Playing HEVC in the pane at all is the
open proposal in `TODO.md`, a rendition streamed from the system's ffmpeg.

**A picture has no zoom bar in this state.** There is nothing to zoom, and a control that does
nothing reads as one that is broken.

**The list this section once opened is gone** (ADR-0050). It had two lessons that still stand
wherever a dialog is opened from the pane. A dialog portalled out of the pane is still inside it in
React's tree, so its keys must stop at its own boundary, or `Escape` closes the preview underneath
it. And a dialog opened without a `Dialog.Trigger` must give the focus back to what had it, or the
pane's keys go dead until somebody clicks.

## 8. States

Every surface owes four states, and the empty one is where most applications get lazy.

**A cell with no thumbnail is a state too.** Four things look identical in a grid — work that
has not been done yet, a format nothing in this build draws, a video waiting for an ffmpeg nobody
installed, and a file that was tried and would not decode. **The status bar says only the
first**: *"Deriving… 42 to go"*, or *"Paused · 42 left"*. The other three are told by the cell
itself, in its badge, and by the file when it is opened, with what to do about it (§3.13,
ADR-0050). On 2026-09-25 the bar went from one line (the first that applied) to three side by side,
and then, the same day, to progress alone. The user asked for the failures not to be counted there
at all, only told on the file.

**The running count has a × beside it, and a paused queue says what is left** (ADR-0049). The ×
is its own button, never the count: the count was not a control while work is going, and a
click that stopped the work would be a pause nobody meant to make. Pressed, the line reads
*"Paused · 1,240 left"* with **Resume** beside it, and the ☰ gains *"Resume deriving (1,240
left)"* at its head for as long as anything is left. The pause is the library's and outlives the
window until Resume. While paused, an opened file (selected or previewed), a new import, what
*Try again* releases, a pinned poster and a file made here are still derived **by name**, and
nothing else is.

**An import is drawn the way a transfer is** (ADR-0055): counting, then a bar in bytes with a ×.
A dropped or chosen directory is first walked to be counted, and the line says so with what it has
found, and no bar yet: *"Counting… 12,400 files · 38.2 GiB"*. Then comes the bar, a percentage,
the bytes and the files: *"Importing… 34% · 2.1 GiB of 6.2 GiB · 12 of 40"*. The percentage is
the bytes', because one video of several gigabytes would otherwise read *0 of 1* for as long as it
took. An Eagle import counts items against its survey instead. **×** stops the run, during the
count as well. What has arrived stays, a file half copied is abandoned, and the line reads
*"Stopping… what has arrived stays"* while the batch in hand is committed. The run then ends as
*"Import stopped · 12 imported · 3 already here"*, and importing the same directory again brings
the rest. The thumbnails phase that follows, *"Thumbnails… 800 of 1,240"*, has **no ×**, because
by then the files are in and the pictures are the derive queue's, which has its own.

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
faster reads as a flash. The first page target is under 450ms on 100k assets. Built on
2026-09-24, when the user asked whether opening a large library could show that it was loading.
The skeleton is drawn from the time the grid is mounted until the first page arrives, which covers
the library's preferences as well as the page. Its cells are square, because nothing is known about
the pictures yet and a square is how the layout already draws an asset with no dimensions. It
fills one screen and does not scroll. It does not move, because a shimmer is a spinner spread
across the grid. While it is up the grid is `aria-busy`.

**Opening a library** is the wait before there is a grid. After the same 150ms the picker says
*Opening <name>…* under the buttons it disabled. An ordinary open has nothing to count, so that is
all it says. An open that has to fold the journal — a library another implementation wrote, or
one whose index is gone — reports the bytes it has read (`library:folding`), and the picker draws
*Reading the journal* and a **real bar with a percentage** (§0.6). When the read is done the bar is
**replaced** with *Getting it ready* rather than left sitting at 100%, since what follows has no
count. The name is the recent entry's name when the library is in the list, and otherwise the
folder's name with `.roost` taken off. A fold measured 2.0s at 100k assets.

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
| `F9` / `F4` | Show or hide the sidebar · the inspector. Also **Show sidebar** and **Show inspector** in the `☰`, which is where the state is visible; the library remembers both (ADR-0028 §6). No typing guard — a function key is never a character, so hiding a pane works with a hand still in the search field |
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
| `Ctrl+C` | **Copy file** on the selection, or on the asset the preview is showing (ADR-0034 §5). Not while typing, and not over text somebody has selected — a name or a note in the inspector is text first |
| `Delete` | Move the selection to the trash — and, inside the Trash place, delete it permanently after confirming (ADR-0022) |
| `Alt+←` / `Backspace` | Back, through the **places** this window has been (ADR-0044). A filter is not a place, so Back is not an undo for the filter bar — and travelling keeps the chips standing, exactly as clicking a folder does |
| `Alt+→` | Forward, until something new is chosen and the way ahead is dropped |
| `Alt+↑` | Up one folder, and from a top-level folder to the library itself. Nothing outside a folder. **Not `Backspace`**: that one is *back* — history — and this one is *up* — hierarchy. Explorer draws the same line (ADR-0043 §8, ADR-0044 §6) |
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
| `J` / `L` | Seek five seconds back · on — the amount the transport's two skip buttons carry (§7) |
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
