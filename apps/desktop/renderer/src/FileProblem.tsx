import type { InstallableBackend, WireAssetDetail, WireCapability } from "@roost/contract";
import { INSTALLABLE_BACKENDS } from "@roost/contract";
import { useEffect, useState } from "react";
import { invoke, onEvent } from "./bridge.js";
import { badgeOf, capabilityOfReason, decoderOf, explainFailure } from "./deriveReason.js";
import { counted } from "./format.js";

/**
 * Why this file has no picture, and what can be done about it (ADR-0050).
 *
 * Asked for on 2026-09-25: *"pop up X could not be drawn tidak perlu. namun jika
 * ada kendala seperti itu, tampilkan ketika membuka file nya saja … isinya
 * rekomendasi yang bisa dilakukan untuk file tersebut"*. So the status bar no
 * longer counts problems, and a list of thirty-six files is no longer the way
 * in. The file somebody is looking at says what went wrong with it, what they
 * can try, and has the buttons to try it: **Try again**, **Open externally**
 * and **Show in folder**, which were the user's choice of three.
 *
 * Drawn in the inspector the moment the file is selected, and at full size in
 * the preview. Nothing is drawn for a file that has a picture or is still
 * waiting its turn, and nothing for a format nothing draws — a `.zip` is not a
 * problem (`UI_SPEC.md` §3.13).
 *
 * **Try again means two things, and the button says which.** For a file that
 * failed, it is this file: a damaged copy replaced is one file fixed. For a file
 * waiting on a tool — libheif, a fuller ffmpeg — it is every file waiting on the
 * same tool, because installing it fixes all of them at once, and a button that
 * released one would have somebody open eight hundred HEICs in turn.
 */
export function FileProblem({
  detail,
  heading = true,
}: {
  readonly detail: Pick<WireAssetDetail, "id" | "undrawn">;
  /** Off where something above has already said the line, as the preview does. */
  readonly heading?: boolean;
}): React.JSX.Element | null {
  const reason = detail.undrawn;
  const tool = reason === null ? undefined : capabilityOfReason(reason);
  const [capabilities, setCapabilities] = useState<readonly WireCapability[]>([]);
  const [waiting, setWaiting] = useState(0);
  const [trying, setTrying] = useState(false);

  // What this machine has, and how many files wait with this one — only for a
  // file waiting on a tool, which is the only time either is drawn.
  useEffect(() => {
    setTrying(false);
    if (reason === null || tool === undefined) return;
    let current = true;
    void (async () => {
      const outcome = await invoke({ type: "derive:status" });
      if (!current || !outcome.ok) return;
      setCapabilities(outcome.value.capabilities);
      setWaiting(outcome.value.reasons.find((row) => row.reason === reason)?.count ?? 0);
    })();
    return () => {
      current = false;
    };
  }, [reason, tool]);

  if (reason === null || badgeOf(reason) === undefined) return null;
  const explained = explainFailure(reason);

  const tryAgain = (): void => {
    setTrying(true);
    void invoke(
      tool === undefined
        ? { type: "derive:retryAsset", id: detail.id }
        : { type: "derive:retry", reason },
    );
  };

  return (
    <section className="file-problem" aria-label="Why there is no preview">
      {heading && <p className="file-problem-line">{explained.line}</p>}
      {explained.hint !== undefined && <p className="file-problem-hint">{explained.hint}</p>}
      {explained.steps !== undefined && (
        <ul className="file-problem-steps">
          {explained.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ul>
      )}
      {tool !== undefined && (
        <Install backend={installFor(reason, capabilities)} onInstalled={tryAgain} />
      )}
      {/* The backend's own words, small and last: what a bug report is pasted
          from, and never the first thing read. */}
      <p className="file-problem-said">{reason}</p>
      <div className="file-problem-actions">
        <button type="button" data-variant="primary" disabled={trying} onClick={tryAgain}>
          {trying
            ? "Trying again…"
            : tool !== undefined && waiting > 1
              ? `Try again (${counted(waiting)} files)`
              : "Try again"}
        </button>
        <button
          type="button"
          onClick={() => void invoke({ type: "asset:openExternally", id: detail.id })}
        >
          Open externally
        </button>
        <button type="button" onClick={() => void invoke({ type: "asset:reveal", id: detail.id })}>
          Show in folder
        </button>
      </div>
    </section>
  );
}

/**
 * The command that would supply what is missing, and a button that runs it
 * where it needs no password (ADR-0042).
 *
 * Moved here from the failures list, whole: the command is shown whether or not
 * the button is — somebody who would rather see what is about to happen to
 * their machine should not have to take it on trust — and while an install
 * runs, the package manager's latest line is drawn under it, because a disabled
 * button held for three minutes looks exactly like one that has hung.
 */
function Install({
  backend,
  onInstalled,
}: {
  readonly backend: WireCapability | undefined;
  readonly onInstalled: () => void;
}): React.JSX.Element | null {
  const [copied, setCopied] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [said, setSaid] = useState<string | undefined>();
  const command = backend?.install ?? undefined;
  const name = installable(backend);

  useEffect(() => {
    if (!installing) return;
    return onEvent((event) => {
      if (event.type === "install:progress" && event.backend === name) setSaid(event.line);
    });
  }, [installing, name]);

  if (command === undefined) return null;

  const copy = async (): Promise<void> => {
    const outcome = await invoke({ type: "clipboard:copyText", text: command });
    setCopied(outcome.ok && outcome.value);
  };

  const install = async (): Promise<void> => {
    if (name === undefined) return;
    setInstalling(true);
    setSaid(undefined);
    try {
      const outcome = await invoke({ type: "capability:install", backend: name });
      if (outcome.ok && outcome.value.installed) {
        // Nothing announced: the pictures arriving is the answer, released
        // through the same Try again a person would have pressed.
        onInstalled();
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
    <div className="file-problem-install">
      <p className="file-problem-command">{command}</p>
      <div className="file-problem-actions">
        <button type="button" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy command"}
        </button>
        {name !== undefined && (
          <button type="button" onClick={() => void install()} disabled={installing}>
            {installing ? "Installing…" : "Install it"}
          </button>
        )}
      </div>
      {said !== undefined && <p className="file-problem-output">{said}</p>}
    </div>
  );
}

/**
 * The backend a file is parked on, if it is parked on one that is missing —
 * or, for a decoder, on one that is present and has a command to replace it.
 */
function installFor(
  reason: string,
  capabilities: readonly WireCapability[],
): WireCapability | undefined {
  const backend = capabilityOfReason(reason);
  if (backend === undefined) return undefined;
  const decoder = reason.startsWith("missing:") && decoderOf(reason) !== undefined;
  return capabilities.find(
    (entry) => entry.name === backend && (decoder ? entry.install !== null : !entry.available),
  );
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
