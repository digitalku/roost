import type { Take, WireRecentLibrary, WireTransferReport } from "@roost/contract";
import { ContextMenu } from "radix-ui";
import { assets } from "./trash-actions.js";

/**
 * **Move to library ›** and **Copy to library ›** in the grid's context menu
 * (ADR-0054, `UI_SPEC.md` §3.3).
 *
 * The libraries offered are the picker's recent list, as the user asked: the
 * ones still there, pinned first, and never the one that is open. The list is
 * read when the menu opens rather than held by the window, because the picker
 * is the only other thing that reads it and a library unplugged since the
 * window opened should not be offered.
 *
 * `libraries` is `undefined` until that read has answered, which is a moment
 * and not a state anybody should be able to act on, so the submenu says so.
 */

export interface TransferMenuProps {
  readonly libraries: readonly WireRecentLibrary[] | undefined;
  /**
   * A transfer is already running. Both submenus are disabled, because the
   * engine takes one at a time: two at once into one target would open it
   * twice in one process, which its lock cannot see.
   */
  readonly busy: boolean;
  readonly onPick: (target: WireRecentLibrary, take: Take) => void;
}

export function TransferMenu({ libraries, busy, onPick }: TransferMenuProps): React.JSX.Element {
  return (
    <>
      <Destinations
        label="Move to library"
        libraries={libraries}
        busy={busy}
        onPick={(target) => onPick(target, "move")}
      />
      <Destinations
        label="Copy to library"
        libraries={libraries}
        busy={busy}
        onPick={(target) => onPick(target, "copy")}
      />
    </>
  );
}

function Destinations({
  label,
  libraries,
  busy,
  onPick,
}: {
  readonly label: string;
  readonly libraries: readonly WireRecentLibrary[] | undefined;
  readonly busy: boolean;
  readonly onPick: (target: WireRecentLibrary) => void;
}): React.JSX.Element {
  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger
        className="menu-item"
        disabled={busy}
        {...(busy && { title: "A move or copy is already running" })}
      >
        <span className="menu-mark" />
        <span className="menu-label">{label}</span>
        <span className="menu-arrow" aria-hidden="true">
          ›
        </span>
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent className="menu" sideOffset={2} collisionPadding={8}>
          {libraries === undefined ? (
            <ContextMenu.Item className="menu-item" disabled>
              <span className="menu-mark" />
              <span className="menu-label">Reading the recent list…</span>
            </ContextMenu.Item>
          ) : libraries.length === 0 ? (
            // A row rather than an empty submenu, which reads as broken: this
            // says where the list comes from, so it also says how to fill it.
            <ContextMenu.Item className="menu-item" disabled>
              <span className="menu-mark" />
              <span className="menu-label">No other library in the recent list</span>
            </ContextMenu.Item>
          ) : (
            libraries.map((library) => (
              <ContextMenu.Item
                key={library.root}
                className="menu-item"
                title={library.root}
                onSelect={() => onPick(library)}
              >
                <span className="menu-mark" />
                <span className="menu-label">{library.name}</span>
              </ContextMenu.Item>
            ))
          )}
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}

/**
 * The recent list as a menu offers it: still there, not the open library,
 * pinned first and otherwise in the order the list keeps, most recent first.
 */
export function destinations(
  recent: readonly WireRecentLibrary[],
  openRoot: string,
): WireRecentLibrary[] {
  const offered = recent.filter((library) => library.available && library.root !== openRoot);
  return [
    ...offered.filter((library) => library.pinned),
    ...offered.filter((library) => !library.pinned),
  ];
}

/** What the status bar says once a transfer has answered. */
export function transferLine(report: WireTransferReport, take: Take, name: string): string {
  const arrived = report.added + report.merged;
  const verb = take === "move" ? "Moved" : "Copied";
  const parts = [
    ...(report.cancelled ? ["Stopped"] : []),
    arrived === 0
      ? `Nothing was ${take === "move" ? "moved" : "copied"} to ${name}`
      : `${verb} ${assets(arrived)} to ${name}`,
    // Said, because a stopped move leaves the selection in two libraries and
    // the grid alone does not say which half is which.
    ...(report.cancelled && take === "move" ? ["the rest are still here"] : []),
  ];
  if (report.merged > 0) parts.push(`${report.merged} already there, merged`);
  if (report.missing > 0) parts.push(`${report.missing} not on this machine, left here`);
  if (report.failed > 0) parts.push(`${report.failed} failed, left here`);
  return parts.join(" · ");
}
