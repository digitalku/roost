import { Dialog } from "radix-ui";
import { counted } from "../format.js";
import type { DuplicateQuestion } from "./useImport.js";

/**
 * What an import found was already here, and where else it could go
 * (ADR-0037 §3).
 *
 * A `Dialog` and not an `AlertDialog`: nothing here is destructive and nothing
 * is being confirmed. The run has already finished, and for a duplicate it
 * wrote nothing — so *Ignore all* is not a cancellation, it is the answer the
 * import already gave. Dismissing by clicking away means the same thing.
 *
 * **The other choice adds, it does not move.** An asset belongs to as many
 * folders as it was put in, so filing these into the folder on screen takes
 * them out of nothing. The button says the folder's name for that reason: a
 * button reading *Move* would promise a removal that never happens.
 *
 * Where no folder is open there is nowhere to offer, and the dialog is one
 * button wide — still worth drawing, because "14 files were already here" is
 * the answer to a question somebody is about to ask about a grid that did not
 * grow.
 */
export function DuplicatesDialog({
  question,
  folder,
  onIgnore,
  onFile,
}: {
  readonly question: DuplicateQuestion;
  /** The folder on screen, if one is. */
  readonly folder?: { readonly id: number; readonly name: string };
  readonly onIgnore: () => void;
  readonly onFile: (folder: number) => void;
}): React.JSX.Element {
  const rest = question.total - question.names.length;
  // Two files in different directories can share a name, and this is a list of
  // files rather than of names — so the key counts the repeats rather than
  // pretending they are the same row.
  const seen = new Map<string, number>();
  const rows = question.names.map((name) => {
    const nth = (seen.get(name) ?? 0) + 1;
    seen.set(name, nth);
    return { key: `${nth}\u0000${name}`, name };
  });

  return (
    <Dialog.Root
      open={true}
      onOpenChange={(next) => {
        if (!next) onIgnore();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog" aria-describedby={undefined}>
          <Dialog.Title className="dialog-title">
            {question.total === 1
              ? "1 file was already in this library"
              : `${counted(question.total)} files were already in this library`}
          </Dialog.Title>
          <p className="dialog-body">
            {/* Said plainly, because a grid that did not grow looks like an
                import that failed. Identical bytes have one address
                (RL-11), so this is the ordinary
                outcome of re-importing rather than a fault. */}
            Nothing was copied twice — Roost recognises a file by its contents.
          </p>
          <ul className="duplicate-list">
            {rows.map((row) => (
              <li key={row.key}>{row.name}</li>
            ))}
            {rest > 0 && <li className="duplicate-rest">…and {counted(rest)} more</li>}
          </ul>
          <div className="dialog-actions">
            <Dialog.Close asChild>
              <button type="button">Ignore all</button>
            </Dialog.Close>
            {folder !== undefined && (
              <button type="button" onClick={() => onFile(folder.id)}>
                Add to {folder.name}
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
