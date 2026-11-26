import type { EventType, RequestType } from "@roost/contract";

/**
 * The requests a phone may send (ADR-0072 §3.6).
 *
 * A list of what is allowed rather than of what is not, so that a request
 * added to the contract later is refused here until somebody decides it means
 * something away from the machine. Everything not on it either needs this
 * machine's filesystem or desktop — a path, a dialog, the clipboard, *Open
 * externally* — or is the library's own command, or is the desktop's view menu.
 *
 * Deleting for good is on it, at the owner's choice. The server cannot see a
 * confirmation, so `REMOTE.md` requires the client to ask what the window asks
 * before it sends one.
 */
export const REMOTE_REQUESTS: ReadonlySet<RequestType> = new Set<RequestType>([
  // Reading.
  "library:current",
  "library:stats",
  "library:sidebar",
  "assets:page",
  "assets:count",
  "query:check",
  "query:split",
  "query:join",
  "query:subfolders",
  "facets:vocabulary",
  "settings:read",
  "asset:detail",
  "asset:summary",
  "asset:readText",
  "folder:covers",
  "folder:find",
  "folder:deletePreview",
  "assets:deleteInFolderPreview",
  "tags:list",
  "derive:status",
  "derive:onScreen",
  // Writing, every one of them journalled as the window's is.
  "asset:rate",
  "asset:note",
  "asset:source",
  "asset:rename",
  "asset:tagAdd",
  "asset:tagRemove",
  "asset:folderAdd",
  "asset:folderRemove",
  "folder:create",
  "folder:rename",
  "folder:move",
  "tag:create",
  "tag:rename",
  "tag:group",
  "tagGroup:create",
  "tagGroup:rename",
  "comment:add",
  "comment:set",
  "comment:remove",
  "assets:trash",
  "assets:restore",
  "assets:deleteInFolder",
  // Deleting for good.
  "assets:remove",
  "assets:emptyTrash",
  "folder:delete",
  "tag:delete",
  "tagGroup:delete",
]);

/**
 * The events a phone hears (ADR-0072 §3.3): what makes a listing stale, a
 * picture newly drawn, and the library renamed or gone. The rest are progress
 * of work a phone did not start.
 */
export const REMOTE_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  "library:changed",
  "assets:derived",
  "library:renamed",
  "library:lost",
]);
