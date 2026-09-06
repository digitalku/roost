import { useCallback, useMemo, useState } from "react";

/**
 * Which folder branches are open (`UI_SPEC.md` §4.1).
 *
 * **Held by the window rather than by the pane**, because two things outside
 * the pane need it: creating a subfolder has to reveal what it just made, and a
 * folder that is deleted should not leave its id remembered forever. The state
 * is a set of open ids, so a library where nothing has been touched starts
 * collapsed — which is the point. A hundred folders drawn flat is the pane the
 * user showed on 2026-09-06, and the subtree counts mean a closed branch still
 * says how much is under it.
 *
 * **It does not survive the window.** Where it should live is `settings.json`
 * in the library (ADR-0019), which is decided and not yet built; until then a
 * new window opens collapsed. `TODO.md` holds that.
 */
export interface Expansion {
  /** Folder ids whose children are drawn. */
  readonly open: ReadonlySet<number>;
  readonly toggle: (folder: number) => void;
  /** Opens a branch without closing it if it is already open. */
  readonly reveal: (folder: number) => void;
}

export function useExpansion(): Expansion {
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());

  const toggle = useCallback((folder: number) => {
    setOpen((held) => {
      const next = new Set(held);
      if (!next.delete(folder)) next.add(folder);
      return next;
    });
  }, []);

  const reveal = useCallback((folder: number) => {
    setOpen((held) => (held.has(folder) ? held : new Set(held).add(folder)));
  }, []);

  return useMemo(() => ({ open, toggle, reveal }), [open, toggle, reveal]);
}
