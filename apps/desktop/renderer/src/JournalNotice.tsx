import type { WireJournalNotice } from "@roost/contract";
import { Dialog } from "radix-ui";
import { useState } from "react";
import { counted } from "./format.js";

/**
 * What the library's journal held that this build could not use
 * (`UI_SPEC.md` §3.14).
 *
 * The library format is read by programs written before it changed and by
 * programs nobody here has seen, so meeting an operation this build does not
 * know is an ordinary event rather than damage. It requires that the **person**
 * be told — not only a log — and the reason is worth stating plainly: skipping
 * is safe because the journal is append-only, so a record ignored here is still
 * there when the library opens elsewhere. *Silently* skipping is a library that
 * quietly means less than it says, and the user is the only one who can act on
 * that, by opening it in the build that wrote them.
 *
 * **A line in the status bar, not a dialog on open.** Roost has one modal habit
 * and this is not worth joining it: nothing is wrong, nothing needs deciding,
 * and a box in front of the grid every time somebody opens a shared library
 * would be dismissed unread within a week. The line is quiet and permanent for
 * as long as it is true, which is the right weight for news that does not
 * expire.
 *
 * It says nothing at all when there is nothing to say.
 */
export function JournalNotice({
  notice,
}: {
  readonly notice: WireJournalNotice;
}): React.JSX.Element | null {
  const [showing, setShowing] = useState(false);

  const skippedRecords = notice.skipped.reduce((sum, entry) => sum + entry.count, 0);
  if (skippedRecords === 0) return null;

  // Whose, when it is one build's — because that is the sentence somebody can
  // act on, and the prefix on the operation name is what makes it knowable.
  // Several at once collapses to a count rather than a list of names in a line
  // that has to fit beside four others.
  const labels = [...new Set(notice.skipped.map((entry) => entry.platformLabel))];
  const only = labels.length === 1 ? labels[0] : undefined;
  const line =
    only === undefined || only === null
      ? `${counted(skippedRecords)} not shown`
      : `${counted(skippedRecords)} only ${only} shows`;

  return (
    <>
      <button
        type="button"
        className="status-job"
        onClick={() => setShowing(true)}
        title="See what this build could not read, and which Roost wrote it"
      >
        {line}
      </button>
      {showing && <Detail notice={notice} onClose={() => setShowing(false)} />}
    </>
  );
}

/**
 * The list, and the one sentence that matters about it.
 *
 * A `Dialog` and not an `AlertDialog`: nothing here is destructive and closing
 * it changes nothing. What the reader needs is the reassurance that the records
 * are still in the journal, and the name of the build that can show them.
 */
function Detail({
  notice,
  onClose,
}: {
  readonly notice: WireJournalNotice;
  readonly onClose: () => void;
}): React.JSX.Element {
  return (
    <Dialog.Root
      open={true}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog dialog-wide" aria-describedby={undefined}>
          <Dialog.Title className="dialog-title">What this build cannot show</Dialog.Title>
          <p className="dialog-body">
            {/* Said first, because a list of skipped records reads like lost
                work and none of it is lost. */}
            These records are still in the library's journal. Nothing has been removed, and nothing
            will be: Roost never rewrites a journal it did not fully understand.
          </p>

          <div className="failure-groups">
            {notice.skipped.map((entry) => (
              <p className="failure-aside" key={entry.op}>
                <code>{entry.op}</code> — {counted(entry.count)},{" "}
                {entry.platformLabel === null
                  ? "from a later revision of the library format"
                  : `written by ${entry.platformLabel}`}
                .
              </p>
            ))}
          </div>

          <p className="dialog-body">
            Open the library in the build that wrote them to see what they say. Everything else in
            this library is here and is safe to edit — the journal only grows.
          </p>

          <div className="dialog-actions">
            <Dialog.Close asChild>
              <button type="button">Close</button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
