/**
 * About Roost, asserted against a **running window** (`UI_SPEC.md` §3.12).
 *
 *     node scripts/check-about.mjs
 *
 * The component tests drive this dialog against a fake engine, so they can say
 * what the window draws for a given answer and nothing about the answer itself.
 * **That is the half that was wrong.** `app.getVersion()` falls back to
 * *Electron's* version in an unpackaged build, so the first time this dialog was
 * opened in a real window it said "Version 43.4.1" — a fake engine will never
 * report that, because a fake engine is not Electron.
 *
 * It also checks the notices actually arrived in the bundle. They are compiled
 * in with `?raw` (invariant 7 forbids fetching them), and a build that dropped
 * them would leave an empty panel where a legal obligation is meant to be.
 *
 * **It builds its own library** in a temporary directory and deletes it again,
 * then opens a second window with no library at all — which is the state the
 * picker's credit line exists for.
 */
import { ledger } from "./lib/checks.mjs";
import { imageLibrary, scratch } from "./lib/fixtures.mjs";
import { launch } from "./lib/window.mjs";

/** The middle of an element, in viewport coordinates, for `cdp.mouse`. */
const centreOf = (cdp, selector) =>
  cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return null;
    const box = el.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);

/** The middle of the one element of a kind whose whole text is `text`. */
const centreOfText = (cdp, selector, text) =>
  cdp.evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((node) => node.textContent.trim() === ${JSON.stringify(text)});
    if (el === undefined) return null;
    const box = el.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);

const clickText = async (cdp, selector, text) => {
  const at = await centreOfText(cdp, selector, text);
  if (at === null) throw new Error(`no ${selector} saying ${text}`);
  await cdp.mouse.click(at.x, at.y);
};

const { dir, dispose } = await scratch("check-about");
const root = await imageLibrary(dir, { count: 3, size: 64 });
const window = await launch({ library: root });
const { cdp } = window;
const { check, section, report } = ledger();

try {
  section("the menu");
  const trigger = await centreOf(cdp, ".app-menu-trigger");
  await cdp.mouse.click(trigger.x, trigger.y);
  const items = await cdp.settle(
    `[...document.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent.trim())`,
    (seen) => Array.isArray(seen) && seen.length > 0,
  );
  check("About Roost… is in the ☰", items.includes("About Roost…"), items.join(" · "));

  section("what the build says it is");
  await clickText(cdp, '[role="menuitem"]', "About Roost…");
  const build = await cdp.settle(
    `document.querySelector(".about-build")?.textContent ?? ""`,
    (line) => typeof line === "string" && line.includes("Electron"),
  );
  // The regression this script exists for. An unpackaged run has no version,
  // and the one number it must never print is Electron's.
  check(
    "an unpackaged build calls itself a development build",
    build.startsWith("Development build"),
    build,
  );
  check("and does not report Electron's version as its own", !/^Version 4\d\./.test(build), build);
  check("the runtime versions are named", /Electron \d+\..*Chromium \d+\./.test(build), build);

  section("who owns it, and how to reach them");
  const rights = await cdp.evaluate(`document.querySelector(".about-rights")?.textContent ?? ""`);
  check("the copyright is drawn", rights.includes("© 2026 Digitalku"), rights.slice(0, 48));
  const contact = await cdp.evaluate(`document.querySelector(".about-contact")?.textContent ?? ""`);
  check("the landing page is offered", contact.includes("roost.digitalku.com"));
  check("the support address is offered", contact.includes("roostsupport@digitalku.com"));

  section("the third-party licences");
  await clickText(cdp, "button", "Third-party licences");
  const notices = await cdp.settle(
    `document.querySelector('[aria-label="Third-party licences"]')?.textContent ?? ""`,
    (text) => typeof text === "string" && text.length > 0,
  );
  check("the notices ship in the bundle", notices.length > 2000, `${notices.length} characters`);
  // The three that oblige more than attribution (ADR-0038 §4).
  for (const licence of ["MPL-2.0", "LGPL-3.0", "Apache-2.0"]) {
    check(`${licence} is named`, notices.includes(licence));
  }
  check(
    "they scroll inside the dialog rather than growing it",
    await cdp.evaluate(`(() => {
      const panel = document.querySelector('[aria-label="Third-party licences"]');
      return panel.scrollHeight > panel.clientHeight
        && document.querySelector(".dialog").getBoundingClientRect().bottom <= innerHeight;
    })()`),
  );

  await clickText(cdp, "button", "Back");
  check(
    "Back returns to the dialog it came from",
    await cdp.settle(
      `document.querySelector(".about-contact") !== null`,
      (drawn) => drawn === true,
    ),
  );

  await clickText(cdp, "button", "Close");
  check(
    "Close puts it away",
    await cdp.settle(`document.querySelector(".about") === null`, (gone) => gone === true),
  );
} catch (error) {
  console.error(error);
  console.error(window.noise().slice(-4000));
  process.exitCode = 2;
} finally {
  await window.close();
}

// The picker, with no library at all — the state that has no ☰ (ADR-0038 §5.2).
const picker = await launch({});
try {
  section("the picker, before any library is open");
  const credit = await picker.cdp.settle(
    `document.querySelector(".credit")?.textContent ?? null`,
    (line) => typeof line === "string" && line.length > 0,
  );
  check("the credit is drawn where the ☰ is not", credit.includes("© 2026 Digitalku"), credit);
  check("and carries the support address", credit.includes("roostsupport@digitalku.com"));
  check(
    "the menu it would otherwise be in is not there",
    await picker.cdp.evaluate(`document.querySelector(".app-menu-trigger") === null`),
  );
} catch (error) {
  console.error(error);
  console.error(picker.noise().slice(-4000));
  process.exitCode = 2;
} finally {
  await picker.close();
  await dispose();
  report();
}
