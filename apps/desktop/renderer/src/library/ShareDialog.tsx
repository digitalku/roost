import type { WireRemoteStatus } from "@roost/contract";
import { Dialog } from "radix-ui";
import { useEffect, useState } from "react";
import { invoke } from "../bridge.js";
import { whenOpened } from "./RecentList.js";

const STATUS_EVERY_MS = 2000;

/**
 * Sharing the open library on the local network, for a phone (ADR-0072 §3.1).
 *
 * One checkbox, remembered for this library on this machine, the addresses to
 * type into the phone while it is on, and the phones paired with it, each with
 * **Unpair**. A library without a password cannot be shared, and the dialog
 * says so and offers to set one instead of offering a checkbox that would do
 * nothing. **The one line about plain HTTP is the honest part** (§3.4): on the
 * home Wi-Fi the password and the token cross unencrypted.
 */
export function ShareDialog({
  onClose,
  onSetPassword,
}: {
  readonly onClose: () => void;
  /** Opens *Set password…*, for a library that has none. */
  readonly onSetPassword: () => void;
}): React.JSX.Element {
  const [status, setStatus] = useState<WireRemoteStatus | undefined>();
  const [busy, setBusy] = useState(false);
  const now = Math.floor(Date.now() / 1000);

  // Read again every two seconds while open, because the dialog is where the
  // owner looks while pairing a phone, and a phone that just paired should
  // appear in the list without the dialog being closed and opened again. It
  // asks main, which answers from memory and a small file: no engine involved.
  useEffect(() => {
    let live = true;
    const read = (): void => {
      void invoke({ type: "remote:status" }).then((answer) => {
        if (live && answer.ok) setStatus(answer.value);
      });
    };
    read();
    const every = setInterval(read, STATUS_EVERY_MS);
    return () => {
      live = false;
      clearInterval(every);
    };
  }, []);

  const share = async (on: boolean): Promise<void> => {
    setBusy(true);
    const answer = await invoke({ type: "remote:share", on });
    setBusy(false);
    if (answer.ok) setStatus(answer.value);
  };

  const unpair = async (device: string): Promise<void> => {
    const answer = await invoke({ type: "remote:revoke", device });
    if (answer.ok) setStatus(answer.value);
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog dialog-wide">
          <Dialog.Title className="dialog-title">Share on this network</Dialog.Title>
          <Dialog.Description className="dialog-body">
            A phone on the same network, or on your Tailscale, can open this library while Roost has
            it open here. It asks for the library's password once, to pair.
          </Dialog.Description>

          {status === undefined ? (
            <p className="dialog-body">Reading…</p>
          ) : !status.hasPassword ? (
            <>
              <p className="dialog-body">
                This library has no password, and a library without one is not shared: the password
                is what lets a phone in.
              </p>
              <div className="dialog-actions">
                <Dialog.Close asChild>
                  <button type="button">Close</button>
                </Dialog.Close>
                <button type="button" data-variant="primary" onClick={onSetPassword}>
                  Set password…
                </button>
              </div>
            </>
          ) : (
            <>
              <label className="dialog-option">
                <input
                  type="checkbox"
                  checked={status.sharing}
                  disabled={busy}
                  onChange={(event) => void share(event.target.checked)}
                />
                <span>
                  Share this library on this network
                  <span className="dialog-option-note">
                    Remembered for this library, on this computer.
                  </span>
                </span>
              </label>

              {status.sharing && status.problem !== null && (
                <p className="dialog-problem" role="alert">
                  {status.problem}
                </p>
              )}

              {status.listening && (
                <div className="share-addresses">
                  {status.addresses.length === 0 ? (
                    <p className="dialog-body">
                      This computer has no address a phone could reach. In the Flatpak, Roost has no
                      network permission yet.
                    </p>
                  ) : (
                    <>
                      <p className="dialog-body">In the phone, type one of these:</p>
                      <ul className="share-address-list">
                        {status.addresses.map((address) => (
                          <li key={address}>
                            <code>{address}</code>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  <p className="dialog-option-note">
                    Plain HTTP: on your own Wi-Fi, the password and the phone's key are not
                    encrypted. Away from home, Tailscale encrypts them.
                  </p>
                </div>
              )}

              <div className="share-devices">
                <h3 className="share-devices-title">Paired phones</h3>
                {status.devices.length === 0 ? (
                  <p className="dialog-body">None yet.</p>
                ) : (
                  <ul className="share-device-list">
                    {status.devices.map((device) => (
                      <li key={device.id} className="share-device">
                        <span className="share-device-name">{device.name}</span>
                        <span className="share-device-when">
                          {device.lastSeen === null
                            ? `Paired ${whenOpened(device.pairedAt, now).toLowerCase()}`
                            : `Seen ${whenOpened(device.lastSeen, now).toLowerCase()}`}
                        </span>
                        <button
                          type="button"
                          aria-label={`Unpair ${device.name}`}
                          onClick={() => void unpair(device.id)}
                        >
                          Unpair
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="dialog-actions">
                <Dialog.Close asChild>
                  <button type="button">Close</button>
                </Dialog.Close>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
