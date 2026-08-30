import type { WireRecentLibrary } from "@roost/contract";

/**
 * The libraries this machine has opened, on the picker screen.
 *
 * `UI_SPEC.md` §3 has asked the `LibraryPicker` for a recent list since M3 and
 * nothing built one, so the only way back into a library was a native folder
 * dialog — every time, including the first thing every morning.
 *
 * **A library that has gone is shown, not hidden.** It is drawn dimmed and
 * cannot be opened, with its own way to be forgotten. Dropping it silently
 * would read as the application having forgotten it, and leave somebody
 * wondering whether they imagined the library or merely lost it.
 */

export interface RecentListProps {
  readonly entries: readonly WireRecentLibrary[];
  readonly busy: boolean;
  readonly onOpen: (root: string) => void;
  readonly onForget: (root: string) => void;
  readonly onPin: (root: string, pinned: boolean) => void;
  /** Injected so the relative times are testable without stubbing the clock. */
  readonly now?: number;
}

export function RecentList({
  entries,
  busy,
  onOpen,
  onForget,
  onPin,
  now,
}: RecentListProps): React.JSX.Element | null {
  // Nothing at all on a first run: an empty heading over an empty box says the
  // feature is broken rather than unused (`UI_SPEC.md` §8).
  if (entries.length === 0) return null;

  const at = now ?? Math.floor(Date.now() / 1000);

  return (
    <div className="recent">
      <h2 className="recent-title">Recent</h2>
      <ul className="recent-list">
        {entries.map((entry) => (
          <li key={entry.root} className="recent-row" data-missing={!entry.available || undefined}>
            <button
              type="button"
              className="recent-open"
              disabled={busy || !entry.available}
              // The name, not the name plus the path: an accessible name is
              // read aloud, and a full filesystem path read one character at a
              // time is noise. The path is still on screen and in the tooltip.
              aria-label={`Open ${entry.name}`}
              title={entry.root}
              onClick={() => onOpen(entry.root)}
            >
              <span className="recent-name">{entry.name}</span>
              <span className="recent-path">{entry.root}</span>
            </button>
            <span className="recent-when">
              {entry.available ? whenOpened(entry.openedAt, at) : "Missing"}
            </span>
            <button
              type="button"
              className="recent-pin"
              aria-pressed={entry.pinned}
              aria-label={entry.pinned ? `Unpin ${entry.name}` : `Pin ${entry.name}`}
              onClick={() => onPin(entry.root, !entry.pinned)}
            >
              {entry.pinned ? "★" : "☆"}
            </button>
            <button
              type="button"
              className="recent-forget"
              aria-label={`Forget ${entry.name}`}
              onClick={() => onForget(entry.root)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago, in the words a person would use.
 *
 * Coarse on purpose: the question this answers is "is this the one I was in
 * yesterday", not "how many hours precisely". Past a week it becomes a date,
 * because "23 days ago" is arithmetic the reader has to do themselves.
 *
 * Exported for its test — the formatting is the part with edge cases in it.
 */
export function whenOpened(openedAt: number, now: number): string {
  const ago = now - openedAt;
  if (ago < MINUTE) return "Just now";
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`;
  if (ago < DAY) {
    const hours = Math.floor(ago / HOUR);
    return hours === 1 ? "An hour ago" : `${hours} hours ago`;
  }
  if (ago < 2 * DAY) return "Yesterday";
  if (ago < 7 * DAY) return `${Math.floor(ago / DAY)} days ago`;
  return new Date(openedAt * 1000).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
