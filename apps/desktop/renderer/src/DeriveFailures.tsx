import type {
  InstallableBackend,
  WireCapability,
  WireDeriveFailureGroup,
  WireDeriveFailures,
} from "@roost/contract";
import { INSTALLABLE_BACKENDS } from "@roost/contract";
import { Dialog } from "radix-ui";
import { useEffect, useState } from "react";
import { invoke } from "./bridge.js";
import { CAPABILITY_OF_REASON, explainFailure } from "./deriveReason.js";
import { counted } from "./format.js";

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
  state,
  capabilities,
  onRetry,
  onClose,
}: {
  /**
   * Which half of "no picture" this is.
   *
   * `failed` was tried and went wrong; `blocked` is waiting on the world to
   * change — a format nothing here draws, or a decoder nobody installed. The
   * list is the same because the question is, but what can be *done* differs,
   * and that is what changes below: a failure offers one retry for everything,
   * while a parked group offers one only when something could have arrived.
   */
  readonly state: "failed" | "blocked";
  /** What this machine can draw, so a missing backend can name its command. */
  readonly capabilities: readonly WireCapability[];
  readonly onRetry: (reason?: string) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const [failures, setFailures] = useState<WireDeriveFailures | undefined>();
  const [refused, setRefused] = useState(false);
  const [copied, setCopied] = useState(false);

  // Read when the dialog opens rather than beside the status: grouping reads
  // every failed row, and until somebody asks there is nothing to group for.
  useEffect(() => {
    void (async () => {
      // `catch` as well as the failed outcome: an outcome is the engine saying
      // no, and a throw is the door itself being missing — which is a state the
      // window can be in, and one that must still draw a dialog rather than an
      // empty box.
      try {
        const outcome = await invoke({ type: "derive:failures", state });
        if (outcome.ok) setFailures(outcome.value);
        else setRefused(true);
      } catch {
        setRefused(true);
      }
    })();
  }, [state]);

  const copy = async (): Promise<void> => {
    if (failures === undefined) return;
    const outcome = await invoke({ type: "clipboard:copyText", text: asText(failures, state) });
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
            {failures === undefined ? "What has no preview" : title(failures.total, state)}
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
                <Group
                  key={group.reason}
                  group={group}
                  open={index === 0}
                  backend={installFor(group.reason, capabilities)}
                  {...(state === "blocked" ? {} : { onRetry: undefined })}
                  {...(state === "blocked" && group.reason.startsWith("missing:")
                    ? { onRetry: () => onRetry(group.reason) }
                    : {})}
                />
              ))}
              {failures.hidden > 0 && (
                <p className="failure-aside">
                  …and {counted(failures.hidden)} more, in reasons too varied to group.
                </p>
              )}
              {failures.read < failures.total && (
                <p className="failure-aside">
                  Grouped from the first {counted(failures.read)} of {counted(failures.total)}.
                </p>
              )}
            </div>
          )}

          <div className="dialog-actions">
            <button type="button" onClick={() => void copy()} disabled={failures === undefined}>
              {copied ? "Copied" : "Copy list"}
            </button>
            {/* One retry for everything, and only where everything *can* be
                retried. A parked group is waiting on a tool rather than on
                another attempt, so its button is beside the tool it wants. */}
            {state === "failed" && (
              <button
                type="button"
                onClick={() => {
                  onRetry();
                  onClose();
                }}
              >
                Try again
              </button>
            )}
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
  backend,
  onRetry,
}: {
  readonly group: WireDeriveFailureGroup;
  readonly open: boolean;
  /** The backend this group is waiting for, where it is waiting for one. */
  readonly backend?: WireCapability | undefined;
  /** Offered only for work an arrival could release. */
  readonly onRetry?: (() => void) | undefined;
}): React.JSX.Element {
  const explained = explainFailure(group.reason);
  const rest = group.count - group.samples.length;
  const [copied, setCopied] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [said, setSaid] = useState<string | undefined>();

  const command = backend?.install ?? undefined;
  const name = installable(backend);

  const copy = async (): Promise<void> => {
    if (command === undefined) return;
    const outcome = await invoke({ type: "clipboard:copyText", text: command });
    setCopied(outcome.ok && outcome.value);
  };

  /**
   * Runs it, and says what happened either way.
   *
   * The package manager's own words are shown rather than a sentence of ours:
   * the reason somebody is reading this is that it did not go the way either of
   * us expected, and "it failed" is not something to act on. A refusal is
   * common and ordinary here — *already installed* is what a second click says.
   */
  const install = async (): Promise<void> => {
    if (name === undefined) return;
    setInstalling(true);
    setSaid(undefined);
    try {
      const outcome = await invoke({ type: "capability:install", backend: name });
      if (outcome.ok && outcome.value.installed) {
        // Nothing is announced on success (`UI_SPEC.md` §3.13): the previews
        // appearing is the answer, and the work is released through the same
        // button a person would have pressed rather than a second path that
        // could drift from it.
        onRetry?.();
      } else {
        setSaid(outcome.ok ? outcome.value.detail : "The install could not be started.");
      }
    } catch {
      setSaid("The install could not be started.");
    } finally {
      setInstalling(false);
    }
  };

  return (
    <details className="failure-group" open={open}>
      <summary>
        <span className="failure-line">{explained.line}</span>
        <span className="failure-count">{counted(group.count)}</span>
      </summary>
      {explained.hint !== undefined && <p className="failure-hint">{explained.hint}</p>}
      {command !== undefined && (
        <>
          {/* The command, where a person can select it — and, where running it
              needs no password, a button that runs it (ADR-0042). On Linux
              every line begins with `sudo`, so there is no button and this is
              the whole of the answer. */}
          <p className="failure-install">{command}</p>
          <div className="failure-install-actions">
            <button type="button" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy command"}
            </button>
            {name !== undefined && (
              <button type="button" onClick={() => void install()} disabled={installing}>
                {installing ? "Installing…" : "Install it"}
              </button>
            )}
            {onRetry !== undefined && (
              <button type="button" onClick={onRetry}>
                Try again
              </button>
            )}
          </div>
          {/* Verbatim, and only after a run: winget goes to the network before
              it decides it has nothing to do, so the first thing this says is
              usually the last thing anybody expected. */}
          {said !== undefined && <p className="failure-install-output">{said}</p>}
        </>
      )}
      {/* The backend's own words, kept verbatim minus the paths the engine took
          out to group them. Small, monospaced, and never the first thing read. */}
      <p className="failure-reason">{group.reason}</p>
      {group.attempts > 1 && (
        <p className="failure-aside">Tried {counted(group.attempts)} times already.</p>
      )}
      <ul className="failure-files">
        {group.samples.map((sample) => (
          <li key={sample.hash}>{sample.name}</li>
        ))}
        {rest > 0 && <li className="failure-rest">…and {counted(rest)} more</li>}
      </ul>
    </details>
  );
}

function title(total: number, state: "failed" | "blocked"): string {
  const count = counted(total);
  if (state === "blocked") {
    return total === 1 ? "1 file without a preview" : `${count} without a preview`;
  }
  return total === 1 ? "1 file could not be drawn" : `${count} could not be drawn`;
}

/** The backend a group is parked on, if it is parked on one that is missing. */
function installFor(
  reason: string,
  capabilities: readonly WireCapability[],
): WireCapability | undefined {
  const backend = CAPABILITY_OF_REASON[reason];
  if (backend === undefined) return undefined;
  return capabilities.find((entry) => entry.name === backend && !entry.available);
}

/**
 * The backend's name, where the engine said a button may be drawn.
 *
 * Narrowed against the contract's own list rather than cast: `name` arrives as
 * a string, and this is the request that starts a process (ADR-0042 §4).
 */
function installable(backend: WireCapability | undefined): InstallableBackend | undefined {
  if (backend === undefined || !backend.installable) return undefined;
  return (INSTALLABLE_BACKENDS as readonly string[]).includes(backend.name)
    ? (backend.name as InstallableBackend)
    : undefined;
}

/**
 * The whole list as text, for the clipboard.
 *
 * Written for somewhere else — a bug report, a note, a shell loop — so it
 * carries the backend's message rather than this file's translation of it, and
 * names every file the engine sampled.
 */
function asText(failures: WireDeriveFailures, state: "failed" | "blocked"): string {
  const lines: string[] = [title(failures.total, state)];
  for (const group of failures.groups) {
    lines.push("", `${explainFailure(group.reason).line} — ${group.count}`, `  ${group.reason}`);
    for (const sample of group.samples) lines.push(`  ${sample.name}`);
    const rest = group.count - group.samples.length;
    if (rest > 0) lines.push(`  …and ${rest} more`);
  }
  return `${lines.join("\n")}\n`;
}
