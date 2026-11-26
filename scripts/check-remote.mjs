/**
 * Sharing a library with a phone, asserted against a **running window**
 * (ADR-0072).
 *
 *     node scripts/check-remote.mjs
 *
 * The package's own tests drive the routes against a stand-in for main. What
 * only a window can say is the whole path a phone's request takes: the box
 * ticked in the dialog, main listening, a pairing checked by the engine, a
 * request answered by the same engine the window asks, a tag a phone added
 * landing in the journal and reaching the window, a thumbnail served by the
 * same byte server, and nothing listening once the box is unticked.
 *
 * It plays the phone itself, with `fetch` on loopback. **It builds its own
 * library and its own state directory**, so no paired device and no recent
 * entry of yours is touched, and deletes both again.
 */
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { Library } from "@roost/library";
import { ledger } from "./lib/checks.mjs";
import { imageLibrary, scratch } from "./lib/fixtures.mjs";
import { launch } from "./lib/window.mjs";

const PASSWORD = "kata-sandi-5513";

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const click = async (cdp, selector, text) => {
  const found = await cdp.settle(
    `(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((node) => ${text === undefined ? "true" : `node.textContent.trim() === ${JSON.stringify(text)}`});
      if (el === undefined || el.disabled) return null;
      const box = el.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`,
    (at) => at !== null,
  );
  if (found === null) throw new Error(`no ${selector} saying ${text}`);
  await cdp.mouse.click(found.x, found.y);
};

const { dir, dispose } = await scratch("check-remote");
const root = await imageLibrary(dir, { count: 3, size: 64, name: "rumah" });
{
  const library = await Library.open(root);
  await library.changePassword(undefined, PASSWORD);
  await library.close();
}
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const state = join(dir, "state");
const window = await launch({
  open: false,
  env: { ROOST_REMOTE_PORT: String(port), XDG_STATE_HOME: state },
});
const { cdp } = window;
const { check, section, report } = ledger();

const post = (path, body, token) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

try {
  const opened = await cdp.evaluate(
    `window.roost.invoke({ type: "library:open", path: ${JSON.stringify(root)}, password: ${JSON.stringify(PASSWORD)} })`,
  );
  if (opened?.ok !== true) throw new Error(`could not open: ${JSON.stringify(opened)}`);
  await cdp.evaluate("location.reload()").catch(() => {});
  await cdp.settle(`document.querySelector(".bar-title")?.textContent`, (name) => name === "rumah");
  const thumb = await cdp.settle(
    `[...document.querySelectorAll(".grid img")].find((img) => img.complete && img.naturalWidth > 0)?.getAttribute("src") ?? null`,
    (src) => typeof src === "string",
    { attempts: 150 },
  );

  section("nothing listens until the box is ticked");
  const before = await fetch(`${base}/api/1/hello`).then(
    () => "answered",
    () => "refused",
  );
  check("a window that never ticks it opens no socket", before === "refused", before);

  section("Share on this network… from the ☰");
  await click(cdp, ".app-menu-trigger");
  await click(cdp, '[role="menuitem"]', "Share on this network…");
  await click(cdp, '.dialog input[type="checkbox"]');
  const addresses = await cdp.settle(
    `document.querySelector(".share-addresses")?.textContent ?? null`,
    (text) => typeof text === "string",
  );
  check("the dialog says what to type into the phone", addresses.includes(`:${port}`), addresses);

  section("a phone pairs");
  const hello = await (await fetch(`${base}/api/1/hello`)).json();
  check("hello names the library", hello.library?.name === "rumah", hello);
  const wrong = await post("/api/1/pair", { password: "salah", device: "Pixel" });
  check("a wrong password is refused by the engine's check", wrong.status === 403, wrong.status);
  const paired = await post("/api/1/pair", { password: PASSWORD, device: "Pixel" });
  const { token } = await paired.json();
  check("the right one pairs, with a token", /^[0-9a-f]{64}$/.test(token ?? ""));
  const listed = await cdp.settle(
    `document.querySelector(".share-device-name")?.textContent ?? null`,
    (name) => name === "Pixel",
    { attempts: 40 },
  );
  check("the dialog lists the phone without being opened again", listed === "Pixel", listed);

  section("it asks what a window asks");
  const stats = await (await post("/api/1/request", { type: "library:stats" }, token)).json();
  check("library:stats comes from the engine", stats.ok === true && stats.value.assets === 3);
  const page = await (
    await post(
      "/api/1/request",
      { type: "assets:page", query: "", limit: 10, after: null, sort: null },
      token,
    )
  ).json();
  const ids = page.ok ? page.value.assets.map((card) => card.id) : [];
  check("assets:page answers the three", ids.length === 3, ids);
  const refused = await post("/api/1/request", { type: "dialog:openLibrary" }, token);
  check("a dialog is not answered away from the machine", refused.status === 403);

  section("a tag from the phone");
  const controller = new AbortController();
  const events = await fetch(`${base}/api/1/events`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  const reader = events.body.getReader();
  const decoder = new TextDecoder();
  let heard = decoder.decode((await reader.read()).value);
  const tagged = await (
    await post("/api/1/request", { type: "asset:tagAdd", ids: [ids[0]], tags: ["dari-hp"] }, token)
  ).json();
  check("asset:tagAdd is answered", tagged.ok === true, tagged);
  const deadline = Date.now() + 5000;
  while (!heard.includes("library:changed") && Date.now() < deadline) {
    heard += decoder.decode((await reader.read()).value);
  }
  controller.abort();
  check("the phone hears library:changed", heard.includes("event: library:changed"));
  const months = await readdir(join(root, "journal"));
  const journal = (
    await Promise.all(months.map((month) => readFile(join(root, "journal", month), "utf8")))
  ).join("");
  check("the journal holds it", journal.includes('"dari-hp"'));

  section("bytes at the window's own paths");
  const path = thumb.replace(/^roost:\/\//, "/bytes/");
  const picture = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const body = Buffer.from(await picture.arrayBuffer());
  check(
    "a thumbnail the window drew is served to the phone",
    picture.status === 200 && body.length > 0,
    `${picture.status} ${picture.headers.get("content-type")} ${body.length} bytes`,
  );
  const anonymous = await fetch(`${base}${path}`);
  check("and to nobody unpaired", anonymous.status === 401, anonymous.status);

  section("unticked");
  await click(cdp, '.dialog input[type="checkbox"]');
  await cdp.settle(`document.querySelector(".share-addresses") === null`, (gone) => gone === true);
  const after = await fetch(`${base}/api/1/hello`).then(
    () => "answered",
    () => "refused",
  );
  check("nothing listens any more", after === "refused", after);

  section("nothing kept or logged that should not be");
  const devices = await readdir(join(state, "roost", "remote"));
  const stored = await readFile(join(state, "roost", "remote", devices[0]), "utf8");
  check("the device file holds no token", !stored.includes(token));
  check("nor the password", !stored.includes(PASSWORD));
  check("no process printed the password", !window.noise().includes(PASSWORD));
  check("nor the token", !window.noise().includes(token));
} catch (error) {
  console.error(error);
  console.error(window.noise().slice(-4000));
  process.exitCode = 2;
} finally {
  await window.close();
  await dispose();
  report();
}
