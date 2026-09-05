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
| Inspector | 280–480px, drag to resize | yes, `F4` | **Always drawn.** An empty selection gets the empty state from §8, never a shell of disabled controls. Reserves a scrollbar gutter, as the grid does: how tall its content is depends on the asset, so without one the panel's fields shift sideways as the selection moves. |
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
| `Transport` | content | position, loop | The player's own controls, over a `<video controls={false}>`. Timeline, buffered ranges, volume, fullscreen, picture-in-picture, the comment marks, and what the native bar withholds — frame stepping, playback rate, an A-B loop; §7. ADR-0024 |
| `Inspector` | inspector | field drafts | Always drawn; empty selection gets §8's empty state |
| `RatingControl` | inspector | — | 0–5, `null` is not 0 |
| `TagEditor` | inspector | draft | Typeahead over existing tags, creates on Enter |
| `NoteField` | inspector | draft | Autosaves on blur and after 1s idle |
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
| **Delete permanently** | confirms, then removes the selection from the library |
| **Empty trash** | confirms, then removes everything the trash holds — which is not the selection, so the count comes back from the engine |

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
| **Detach** | Un-says the sentence. **Nothing is deleted**: both assets stay and the track becomes an ordinary text asset again, visible in the grid |

The label is **Detach** and never "Remove", because removing an asset is a different, destructive
thing that lives on `Delete` — and two words for two meanings is the only way that stays clear.

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

**A dialog that asks a question is not an alert dialog.** **New file…** (ADR-0026 §4) opens an
ordinary `Dialog`: it can be dismissed by clicking away and it starts with focus in the first
field, because there is nothing dangerous to guard against — the danger is losing what was typed,
and that is the user's own to weigh.

**It asks one thing: the name.** Typed, never defaulted — a file called `untitled` is a file
somebody has to rename — and the extension is part of it. `Enter` is the button, and **Create**
stays disabled until there is a name.

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

## 4. Navigation

### 4.1 What the sidebar contains

```
Library ▾                        library switcher, and where "Open library…" lives

PLACES
  All assets                     everything, newest first
  Recent                         imported in the last 7 days
  Favorites
  Untagged                       the pile that needs work — the reason this is here
  Trash                     3    ADR-0022. The only place with a count, and the count is what
                                 makes it worth a row — an empty trash and one holding four
                                 hundred assets look identical without it

RATING                           one row per star, always five
  5 stars                  12
  4 stars                   0    drawn even at zero: a row that appears and vanishes with state
  3 stars                   7    nothing on screen shows is a row people misread
  2 stars                   0
  1 star                    1

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

**A rating row matches one rating, not "this many and up".** Five nested rows would have counts
adding up to more than the library holds, and *how many five-star assets are there* is the question
a sidebar can answer at a glance; `rating:>=4` is one term in the search field for the other
question. All five counts come from one grouped statement, so the section costs the read no more
than a single place does.

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

Arrow keys step through the loaded
list, and **stepping changes the selection**, so the inspector follows what is on screen — in
`roost-old` it did not, and a note could be written onto the wrong asset.

| Kind | Renders as |
| --- | --- |
| Image | `<img src="roost://original/<hash>">`, fit to pane, click to toggle 1:1, drag to pan |
| SVG | Same, sandboxed — scripts in an SVG do not run |
| Video / audio | `<video>` / `<audio>` over `roost://original/`, which answers range requests, under a transport of ours — `controls` is off |
| PDF | Page-through: `PageUp` / `PageDown` and two buttons, each page an `<img>` over `roost://page/<hash>/<n>@1024`. Arrow keys keep stepping between assets, so a document does not trap the keyboard |
| Font | The specimen sheet the derive pass drew, with the family and style under it |
| Text | The file itself, monospace, wrapped, with the encoding named under it — `.txt`, `.md`, `.srt`, a log. **Edit** makes it a textarea in the same box |
| Anything else | The thumbnail, the metadata, and **Open externally** |

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
| Elapsed / duration | Monospace and tabular, so the digits do not dance |
| Volume and mute | `M`, and a slider that is also a slider to a screen reader |
| Fullscreen | On the **player's box**, not on the video: sending the video alone takes the controls off the screen with it |
| Picture-in-picture | Video only. Audio has no picture |
| **Comment marks** | One per **timed** comment, at its moment. Click to seek, hover for the text, and each names its moment and its words to a screen reader |
| **Subtitles** | A `CC` menu listing the tracks attached to this asset, **Off** first, and **Add subtitle…** last. Drawn for every video, because the moment somebody notices there are none is the moment they want to add one |
| Frame stepping | One frame a press, ten from the keyboard. Only where the probe recorded a frame rate: a step is arithmetic on it, and a missing one has to mean no stepping rather than a step of `Infinity`. Stepping pauses first — a step while playing is not a step |
| Playback rate | 0.25× to 8×, in a menu that shows the current one as text. The extremes play **silently**: the platform stops stretching sound outside roughly 0.5×–4×, and the menu says so rather than letting it read as a fault |
| A-B loop | One button and three states — set the start, set the end, clear — plus `I` and `O`. The region is drawn along the track, and a start with no end is a mark rather than a band, because the loop is not running yet |

**The frame counter is the frame that was presented, not the frame that was asked for.** A seek in
a long-GOP codec lands on the nearest decodable frame, so arithmetic on `currentTime` is a counter
that lies on exactly the files frame stepping exists for. It comes from
`requestVideoFrameCallback`, which reports what the compositor showed — and which fires after a
seek while paused, so a step is legible. Video only, and only with a probed frame rate.

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
| `Delete` | Move the selection to the trash — and, inside the Trash place, delete it permanently after confirming (ADR-0022) |
| `Ctrl+Delete` | Remove from the current folder only |
| `[` / `]` | Zoom cells down · up |
| `Ctrl+K` | Command palette (**M6**) |

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

**Fullscreen has a button and no key.** `F` is the favourite, and a key that means one thing beside
a video and another beside a picture is worse than a button. The media keys are read only while
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
