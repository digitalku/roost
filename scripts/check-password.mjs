/**
 * A password on a library, asserted against a **running window** (ADR-0071).
 *
 *     node scripts/check-password.mjs
 *
 * The component tests drive both dialogs against a fake engine. What only a
 * window can say is everything between the processes: that the engine writes
 * version 3 and the field, that a library with a password is refused at the
 * picker until it is given, that main's byte server still reaches the pictures
 * once it opens, that a rename opens it again without asking, and that the
 * password typed appears in nothing the application logs.
 *
 * **It builds its own library** in a temporary directory, and deletes it again.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ledger } from "./lib/checks.mjs";
import { imageLibrary, scratch } from "./lib/fixtures.mjs";
import { launch } from "./lib/window.mjs";

const PASSWORD = "kata-sandi-7731";
const WRONG = "kata-sandi-0000";

const centreOf = (cdp, selector, text) =>
  cdp.evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((node) => ${text === undefined ? "true" : `node.textContent.trim() === ${JSON.stringify(text)}`});
    if (el === undefined) return null;
    const box = el.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);

const click = async (cdp, selector, text) => {
  const at = await cdp.settle(
    `(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((node) => ${text === undefined ? "true" : `node.textContent.trim() === ${JSON.stringify(text)}`});
      return el !== undefined && !el.disabled;
    })()`,
    (ready) => ready === true,
  );
  if (at !== true) throw new Error(`no ${selector} saying ${text}`);
  const centre = await centreOf(cdp, selector, text);
  await cdp.mouse.click(centre.x, centre.y);
};

const openMenuItem = async (cdp, label) => {
  await click(cdp, ".app-menu-trigger");
  await click(cdp, '[role="menuitem"]', label);
};

/** Types into a field by id, as a person would after clicking it. */
const typeInto = async (cdp, id, text) => {
  await cdp.settle(`document.querySelector("#${id}") !== null`, (seen) => seen === true);
  await cdp.evaluate(`document.querySelector("#${id}").focus()`);
  await cdp.send("Input.insertText", { text });
};

const heading = (cdp, name) =>
  cdp.settle(`document.querySelector(".bar-title")?.textContent ?? null`, (seen) => seen === name);

const picturesDrawn = (cdp) =>
  cdp.settle(
    `[...document.querySelectorAll(".grid img")].filter((img) => img.complete && img.naturalWidth > 0).length`,
    (count) => typeof count === "number" && count >= 3,
    { attempts: 150 },
  );

const statusSays = (cdp, line) =>
  cdp.settle(
    `document.body.textContent.includes(${JSON.stringify(line)})`,
    (seen) => seen === true,
  );

const manifestOf = async (root) => JSON.parse(await readFile(join(root, "library.json"), "utf8"));

const { dir, dispose } = await scratch("check-password");
const root = await imageLibrary(dir, { count: 3, size: 64, name: "pribadi" });
const window = await launch({ library: root });
const { cdp } = window;
const { check, section, report } = ledger();

try {
  section("Set password… from the ☰");
  await heading(cdp, "pribadi");
  await picturesDrawn(cdp);
  await openMenuItem(cdp, "Set password…");
  await typeInto(cdp, "password-next", PASSWORD);
  await typeInto(cdp, "password-again", PASSWORD);
  await click(cdp, "button", "Save");
  check("the status bar says so", await statusSays(cdp, "Set a password on the library"));
  const locked = await manifestOf(root);
  check(
    "library.json is version 3",
    locked.roost_library_version === 3,
    locked.roost_library_version,
  );
  check("and carries the scrypt record", locked.password?.kdf === "scrypt", locked.password);
  check("and not the password itself", !JSON.stringify(locked).includes(PASSWORD));

  section("opening it again from the picker");
  await openMenuItem(cdp, "Close library");
  await click(cdp, 'button[aria-label="Open pribadi"]');
  const asked = await cdp.settle(
    `document.querySelector(".dialog-title")?.textContent ?? null`,
    (title) => typeof title === "string",
  );
  check("the picker asks for the password", asked === "pribadi has a password", asked);

  await typeInto(cdp, "library-password", WRONG);
  await click(cdp, "button", "Open");
  const wrong = await cdp.settle(
    `document.querySelector(".dialog-problem")?.textContent ?? null`,
    (text) => typeof text === "string",
  );
  check("a wrong one is refused, and said", wrong === "That is not the password.", wrong);
  check(
    "and the library stays closed",
    (await cdp.evaluate(`document.querySelector(".bar-title")`)) === null,
  );

  await typeInto(cdp, "library-password", PASSWORD);
  await click(cdp, "button", "Open");
  await heading(cdp, "pribadi");
  check("the right one opens it", true);
  check("and its pictures arrive through roost://", (await picturesDrawn(cdp)) >= 3);

  section("Rename library… while it has a password");
  await openMenuItem(cdp, "Rename library…");
  await cdp.settle(`document.querySelector("#library-rename") !== null`, (seen) => seen === true);
  await cdp.evaluate(`document.querySelector("#library-rename").select()`);
  await cdp.send("Input.insertText", { text: "rahasia" });
  await click(cdp, "button", "Rename");
  await heading(cdp, "rahasia");
  const prompted = await cdp.evaluate(`document.querySelector("#library-password") !== null`);
  check("it opens again without asking", prompted === false);
  const renamed = join(dir, "rahasia.roost");
  check("and keeps its password", (await manifestOf(renamed)).roost_library_version === 3);

  section("Remove password…");
  await openMenuItem(cdp, "Remove password…");
  await typeInto(cdp, "password-current", PASSWORD);
  await click(cdp, "button", "Remove");
  check("the status bar says so", await statusSays(cdp, "Removed the password"));
  const plain = await manifestOf(renamed);
  check("library.json is version 2 again", plain.roost_library_version === 2, plain);
  check("without the field", !("password" in plain));

  section("nothing logged it");
  const noise = window.noise();
  check("the password is in no output of any process", !noise.includes(PASSWORD));
  check("nor the wrong one", !noise.includes(WRONG));
} catch (error) {
  console.error(error);
  console.error(window.noise().slice(-4000));
  process.exitCode = 2;
} finally {
  await window.close();
  await dispose();
  report();
}
