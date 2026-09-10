import type { WireDeriveFailureGroup, WireDeriveFailures } from "@roost/contract";
import { Dialog } from "radix-ui";
import { useEffect, useState } from "react";
import { invoke } from "./bridge.js";
import { explainFailure } from "./deriveReason.js";

/**
 * What could not be drawn, and why (`UI_SPEC.md` §3.13).
 *
 * The status bar can only carry a number, and a number is not something anybody
 * can act on: "36 could not be drawn" says that thirty-six files have no
 * preview without saying which files, what went wrong, or whether trying again
 * would change anything. This is the answer to all three.
 *
 * **Grouped, because the answer is usually one answer.** Thirty-six failures
 * are rarely thirty-six problems — they are a folder of renamed files, or a
 * drive that was unplugged halfway through an import. The engine groups by the
 * message with the per-file parts taken out; this draws a row per group, in the
 * interface's words, with the backend's own underneath so a bug report has
 * something exact in it.
 *
 * A `Dialog` and not an `AlertDialog`: nothing here is destructive, and closing
 * it changes nothing. The assets are in the library either way — what is
 * missing is a picture of them.
 */
export function DeriveFailures({
  onRetry,
  onClose,
}: {
  readonly onRetry: () => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const [failures, setFailures] = useState<WireDeriveFailures | undefined>();
  const [refused, setRefused] = useState(false);
  const [copied, setCopied] = useState(false);

  // Read when the dialog opens rather than beside the status: grouping reads
  // every failed row, and until somebody asks there is nothing to group for.
  useEffect(() => {
    void (async () => {
      const outcome = await invoke({ type: "derive:failures" });
      if (outcome.ok) setFailures(outcome.value);
      else setRefused(true);
    })();
  }, []);

  const copy = async (): Promise<void> => {
    if (failures === undefined) return;
    const outcome = await invoke({ type: "clipboard:copyText", text: asText(failures) });
    setCopied(outcome.ok && outcome.value);
  };

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
          <Dialog.Title className="dialog-title">
            {failures === undefined ? "What could not be drawn" : title(failures.total)}
          </Dialog.Title>
          <p className="dialog-body">
            {/* Said first, because a list of failures reads like lost files and
                these are not lost: an asset without a thumbnail is an asset. */}
            These files are in the library — it is their previews that are missing.
          </p>

          {refused && <p className="dialog-problem">The list could not be read.</p>}
          {!refused && failures === undefined && <p className="dialog-body">Reading the queue…</p>}

          {failures !== undefined && (
            <div className="failure-groups">
              {failures.groups.map((group, index) => (
                <Group key={group.reason} group={group} open={index === 0} />
              ))}
              {failures.hidden > 0 && (
                <p className="failure-aside">
                  …and {failures.hidden.toLocaleString()} more, in reasons too varied to group.
                </p>
              )}
              {failures.read < failures.total && (
                <p className="failure-aside">
                  Grouped from the first {failures.read.toLocaleString()} of{" "}
                  {failures.total.toLocaleString()}.
                </p>
              )}
            </div>
          )}

          <div className="dialog-actions">
            <button type="button" onClick={() => void copy()} disabled={failures === undefined}>
              {copied ? "Copied" : "Copy list"}
            </button>
            <button
              type="button"
              onClick={() => {
                onRetry();
                onClose();
              }}
            >
              Try again
            </button>
            <Dialog.Close asChild>
              <button type="button">Close</button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * One reason, and the files it happened to.
 *
 * A native `<details>` rather than a built accordion: it opens with the
 * keyboard, it is announced as what it is, and the first group opens on its own
 * because a dialog of closed rows answers nothing without a click.
 */
function Group({
  group,
  open,
}: {
  readonly group: WireDeriveFailureGroup;
  readonly open: boolean;
}): React.JSX.Element {
  const explained = explainFailure(group.reason);
  const rest = group.count - group.samples.length;

  return (
    <details className="failure-group" open={open}>
      <summary>
        <span className="failure-line">{explained.line}</span>
        <span className="failure-count">{group.count.toLocaleString()}</span>
      </summary>
      {explained.hint !== undefined && <p className="failure-hint">{explained.hint}</p>}
      {/* The backend's own words, kept verbatim minus the paths the engine took
          out to group them. Small, monospaced, and never the first thing read. */}
      <p className="failure-reason">{group.reason}</p>
      {group.attempts > 1 && (
        <p className="failure-aside">Tried {group.attempts.toLocaleString()} times already.</p>
      )}
      <ul className="failure-files">
        {group.samples.map((sample) => (
          <li key={sample.hash}>{sample.name}</li>
        ))}
        {rest > 0 && <li className="failure-rest">…and {rest.toLocaleString()} more</li>}
      </ul>
    </details>
  );
}

function title(total: number): string {
  return total === 1 ? "1 file could not be drawn" : `${total.toLocaleString()} could not be drawn`;
}

/**
 * The whole list as text, for the clipboard.
 *
 * Written for somewhere else — a bug report, a note, a shell loop — so it
 * carries the backend's message rather than this file's translation of it, and
 * names every file the engine sampled.
 */
function asText(failures: WireDeriveFailures): string {
  const lines: string[] = [title(failures.total)];
  for (const group of failures.groups) {
    lines.push("", `${explainFailure(group.reason).line} — ${group.count}`, `  ${group.reason}`);
    for (const sample of group.samples) lines.push(`  ${sample.name}`);
    const rest = group.count - group.samples.length;
    if (rest > 0) lines.push(`  …and ${rest} more`);
  }
  return `${lines.join("\n")}\n`;
}
