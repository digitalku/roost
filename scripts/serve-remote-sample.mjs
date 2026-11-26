/**
 * A window sharing a sample library, for trying a phone against it.
 *
 *     node scripts/serve-remote-sample.mjs
 *
 * Builds a library of 60 pictures with tags, two folders and the password
 * `roost-remote`, launches the built window on it with its own state directory,
 * ticks **Share on this network…** and stays up until it is stopped with
 * Ctrl+C, when it deletes everything it made. An emulator reaches it at
 * `10.0.2.2:7387`; no library or paired device of yours is touched.
 */
import { join } from "node:path";
import { Library } from "@roost/library";
import { foldersInto, imageLibrary, scratch, tagsOnto } from "./lib/fixtures.mjs";
import { launch } from "./lib/window.mjs";

const PASSWORD = "roost-remote";
const port = Number(process.env.ROOST_REMOTE_PORT ?? 7387);

const { dir, dispose } = await scratch("serve-remote");
const root = await imageLibrary(dir, { count: 60, size: 320, name: "contoh" });
await tagsOnto(root, ["pantai", "liburan"], 12);
await tagsOnto(root, ["keluarga"], 8, 10);
await foldersInto(root, [
  { name: "Liburan", assets: 20 },
  { name: "Bali", parent: "Liburan", assets: 6 },
]);
{
  const library = await Library.open(root);
  await library.changePassword(undefined, PASSWORD);
  await library.close();
}

const window = await launch({
  open: false,
  env: { ROOST_REMOTE_PORT: String(port), XDG_STATE_HOME: join(dir, "state") },
});
const { cdp } = window;
// Said rather than left to Node's "unsettled top-level await": a window that
// went away on its own is a bug in it, and its last words are what explain it.
window.child.on("exit", async (code, signal) => {
  console.error(`the window exited (${signal ?? code})\n${window.noise().slice(-4000)}`);
  await dispose();
  process.exit(1);
});
const opened = await cdp.evaluate(
  `window.roost.invoke({ type: "library:open", path: ${JSON.stringify(root)}, password: ${JSON.stringify(PASSWORD)} })`,
);
if (opened?.ok !== true) throw new Error(`could not open: ${JSON.stringify(opened)}`);
await cdp.evaluate("location.reload()").catch(() => {});
await cdp.settle(`document.querySelector(".bar-title")?.textContent`, (name) => name === "contoh");
const shared = await cdp.evaluate(`window.roost.invoke({ type: "remote:share", on: true })`);
console.log(JSON.stringify(shared?.value ?? shared));
console.log(`ready: library contoh, password ${PASSWORD}, port ${port}`);

const stop = async () => {
  await window.close();
  await dispose();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise(() => {});
