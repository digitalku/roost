import { AlertDialog } from "radix-ui";

/**
 * The confirmation an irreversible action asks for (`UI_SPEC.md` §3.4).
 *
 * Built on Radix's `AlertDialog` rather than `Dialog`: an alert dialog has no
 * close button, cannot be dismissed by clicking outside it, and starts with
 * focus on the **cancel** button. All three are what separates "are you sure"
 * from a panel — the accident this exists to prevent is a stray click or a
 * stray `Enter`, and a dialog that either of those can confirm is decoration.
 *
 * Reversible actions do not get one. Moving assets to the trash is undone by
 * restoring them, so it asks nothing (ADR-0022); emptying the trash cannot be
 * undone, so it asks.
 */

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  /** What is about to happen, in the user's terms. One sentence. */
  readonly body: string;
  /** The verb, not "OK": a button that says what it does cannot be misread. */
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): React.JSX.Element {
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="dialog-overlay" />
        <AlertDialog.Content className="dialog">
          <AlertDialog.Title className="dialog-title">{title}</AlertDialog.Title>
          <AlertDialog.Description className="dialog-body">{body}</AlertDialog.Description>
          <div className="dialog-actions">
            <AlertDialog.Cancel asChild>
              <button type="button">Cancel</button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button type="button" className="button-danger" onClick={onConfirm}>
                {confirmLabel}
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
