import type { WireAbout } from "@roost/contract";
import { Dialog } from "radix-ui";
import { useEffect, useState } from "react";
import wordmark from "../../../../assets/brand/roost-logo-dark.svg";
import notices from "../../../../THIRD-PARTY-NOTICES.md?raw";
import { COPYRIGHT, HOMEPAGE, HOMEPAGE_URL, SUPPORT_EMAIL, TAGLINE } from "./brand.js";
import { invoke } from "./bridge.js";

/**
 * About Roost (`UI_SPEC.md` §3.12, ADR-0038 §5.1).
 *
 * In the `☰` because of ADR-0028's rule for that menu — *only what has no
 * better home* — which an About box is the definition of: it is not per-asset,
 * not the view, and read once.
 *
 * **The licences are here, not behind a link.** Roost ships as a binary, so the
 * notices are what make distributing somebody else's code lawful (ADR-0038 §4),
 * and a reader who has to be online to find them has not been given them.
 * `THIRD-PARTY-NOTICES.md` is compiled into the bundle rather than read at
 * runtime — invariant 7 forbids fetching it, and the renderer has no
 * filesystem — which also means the text on screen cannot disagree with the
 * file in the repository.
 *
 * **The email is text and the homepage is a button.** `link:open` refuses any
 * scheme but `http(s)` (ADR-0030 §5); that rule is not bent for our own
 * address, and an address that can be selected and copied is what an email
 * client needs anyway.
 */
export function AboutDialog({ onClose }: { readonly onClose: () => void }): React.JSX.Element {
  const [build, setBuild] = useState<WireAbout | undefined>(undefined);
  const [licences, setLicences] = useState(false);

  useEffect(() => {
    let live = true;
    void invoke({ type: "app:about" }).then((outcome) => {
      // A failure draws no version and says nothing about it. This dialog is
      // where somebody comes for an address, and an error over the top of it
      // would take away the one thing they came for.
      if (live && outcome.ok) setBuild(outcome.value);
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog dialog-wide about">
          {/*
            The wordmark is the title, and its `alt` is the accessible name —
            the same trade the picker makes (`UI_SPEC.md` §3.1). Drawing the
            word "Roost" above a picture of the word "Roost" says it twice.
          */}
          <Dialog.Title className="about-mark">
            <img src={wordmark} alt="Roost" width={147} height={40} draggable={false} />
          </Dialog.Title>
          <Dialog.Description className="about-tagline">{TAGLINE}</Dialog.Description>

          {licences ? (
            // `pre` rather than rendered markdown: this is a legal text whose
            // exact wording is the point, and a renderer that reflows it is a
            // second thing that can be wrong about it. The named `section`
            // around it is what makes the scroll container a landmark with a
            // name — and Chromium gives a scrollable region keyboard focus of
            // its own, so it needs no `tabindex` to be readable without a mouse.
            <section className="about-notices" aria-label="Third-party licences">
              <pre>{notices}</pre>
            </section>
          ) : (
            <div className="about-body">
              <p className="about-build">{describe(build)}</p>
              <p className="about-rights">
                {COPYRIGHT}. Proprietary software, licensed for use rather than for redistribution.
                Your files stay yours: nothing is uploaded, and the library format is documented so
                your metadata outlives the application.
              </p>
              <dl className="about-contact">
                <dt>Home</dt>
                <dd>
                  <button
                    type="button"
                    className="link"
                    onClick={() => void invoke({ type: "link:open", url: HOMEPAGE_URL })}
                  >
                    {HOMEPAGE}
                  </button>
                </dd>
                <dt>Support</dt>
                <dd>
                  <span className="about-email">{SUPPORT_EMAIL}</span>
                </dd>
              </dl>
            </div>
          )}

          <div className="dialog-actions">
            <button type="button" onClick={() => setLicences(!licences)}>
              {licences ? "Back" : "Third-party licences"}
            </button>
            <Dialog.Close asChild>
              <button type="button" data-variant="primary">
                Close
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The build, in one line somebody can paste into a support email.
 *
 * Version and commit are both allowed to be missing, and the line says what is
 * left rather than printing a blank: an unpackaged build has no version of its
 * own — `app.getVersion()` answers with *Electron's* if it is asked anyway —
 * and a build nobody handed a commit to cannot invent one. **Development
 * build** is therefore a fact about this window, not a placeholder.
 */
function describe(build: WireAbout | undefined): string {
  if (build === undefined) return "";
  const named = build.version === null ? "Development build" : `Version ${build.version}`;
  const commit = build.commit === null ? "" : ` · ${build.commit}`;
  return `${named}${commit} · Electron ${build.electron} · Chromium ${build.chromium}`;
}
