import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INDEX_FILE } from "@roost/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Library } from "../src/library.js";
import { readManifest } from "../src/manifest.js";
import { hashPassword, parsePasswordRecord, passwordMatches } from "../src/password.js";

/**
 * A password on a library (RL-5c, RL-5d, ADR-0071).
 *
 * It encrypts nothing, so what these check is the gate: that a library with a
 * password opens for that password and for nothing else, that nothing in the
 * folder is touched before it does, and that the version follows the field.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "roost-password-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function manifestOf(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, "library.json"), "utf8")) as Record<string, unknown>;
}

/** A library with `secret` as its password, closed. */
async function lockedLibrary(name = "locked"): Promise<string> {
  const root = join(dir, `${name}.roost`);
  const library = await Library.create(root, name);
  await library.changePassword(undefined, "secret");
  await library.close();
  return root;
}

describe("the password record", () => {
  it("matches the password it was made from, and no other", async () => {
    const record = await hashPassword("correct horse");
    expect(record).toMatchObject({ kdf: "scrypt", n: 2 ** 17, r: 8, p: 1 });
    expect(record.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await passwordMatches(record, "correct horse")).toBe(true);
    expect(await passwordMatches(record, "correct horse ")).toBe(false);
    // A fresh salt every time, so two libraries with one password do not share a hash.
    expect((await hashPassword("correct horse")).hash).not.toBe(record.hash);
  });

  it("compares the password composed, so two keyboards type the same one", async () => {
    const record = await hashPassword("café");
    expect(await passwordMatches(record, "café")).toBe(true);
  });

  it("refuses an empty password", async () => {
    await expect(hashPassword("")).rejects.toMatchObject({ code: "empty_password" });
  });

  it("reads only what RL-5c allows", async () => {
    const good = await hashPassword("x");
    expect(parsePasswordRecord(good)).toEqual(good);
    const broken: Record<string, unknown>[] = [
      { ...good, kdf: "argon2id" },
      { ...good, n: 3 * 2 ** 14 },
      { ...good, n: 2 ** 13 },
      { ...good, n: 2 ** 21 },
      // Within each bound, and over the memory a check may cost.
      { ...good, n: 2 ** 20, r: 8 },
      { ...good, r: 0 },
      { ...good, p: 17 },
      { ...good, salt: "abc" },
      { ...good, salt: good.salt.toUpperCase() },
      { ...good, hash: good.hash.slice(2) },
      { ...good, hash: Buffer.from(good.hash, "hex").toString("base64") },
    ];
    for (const record of broken) expect(typeof parsePasswordRecord(record)).toBe("string");
    expect(typeof parsePasswordRecord(null)).toBe("string");
    expect(typeof parsePasswordRecord([good])).toBe("string");
  });
});

describe("setting and removing a password", () => {
  it("writes version 3 with the field, and version 2 without it", async () => {
    const root = join(dir, "toggle.roost");
    const library = await Library.create(root, "toggle");
    try {
      expect(library.hasPassword).toBe(false);
      expect((await manifestOf(root))["roost_library_version"]).toBe(2);

      await library.changePassword(undefined, "secret");
      const locked = await manifestOf(root);
      expect(locked["roost_library_version"]).toBe(3);
      expect(locked["password"]).toMatchObject({ kdf: "scrypt" });
      expect(library.hasPassword).toBe(true);
      expect(library.manifest.roost_library_version).toBe(3);

      await library.changePassword("secret", null);
      const plain = await manifestOf(root);
      expect(plain["roost_library_version"]).toBe(2);
      expect("password" in plain).toBe(false);
      expect(library.hasPassword).toBe(false);
    } finally {
      await library.close();
    }
  });

  it("asks for the current password before changing or removing it", async () => {
    const root = await lockedLibrary();
    const library = await Library.open(root, { password: "secret" });
    try {
      const before = await readFile(join(root, "library.json"), "utf8");
      await expect(library.changePassword(undefined, "other")).rejects.toMatchObject({
        code: "password_required",
      });
      await expect(library.changePassword("guess", null)).rejects.toMatchObject({
        code: "password_wrong",
      });
      expect(await readFile(join(root, "library.json"), "utf8")).toBe(before);

      await library.changePassword("secret", "other");
    } finally {
      await library.close();
    }
    await expect(Library.open(root, { password: "secret" })).rejects.toMatchObject({
      code: "password_wrong",
    });
    const reopened = await Library.open(root, { password: "other" });
    await reopened.close();
  });

  it("keeps the fields it does not recognise either way (RL-5a)", async () => {
    const root = join(dir, "extras.roost");
    await (await Library.create(root, "extras")).close();
    await writeFile(
      join(root, "library.json"),
      JSON.stringify({ ...(await manifestOf(root)), win_last_opened: 1789344200 }),
      "utf8",
    );
    const library = await Library.open(root);
    try {
      await library.changePassword(undefined, "secret");
      expect((await manifestOf(root))["win_last_opened"]).toBe(1789344200);
      await library.changePassword("secret", null);
      expect((await manifestOf(root))["win_last_opened"]).toBe(1789344200);
    } finally {
      await library.close();
    }
  });

  it("writes library.json by renaming, and leaves nothing beside it (RL-3, RL-5d)", async () => {
    const root = await lockedLibrary();
    expect(await readdir(join(root, "staging"))).toEqual([]);
    expect((await readdir(root)).filter((name) => name.includes("manifest"))).toEqual([]);
  });
});

describe("opening a library with a password (RL-5d)", () => {
  it("refuses it without the password, and touches nothing in the folder", async () => {
    const root = await lockedLibrary();
    // With no index, an open that got any further would make one.
    await rm(join(root, INDEX_FILE), { force: true });
    await rm(join(root, `${INDEX_FILE}-wal`), { force: true });
    await rm(join(root, `${INDEX_FILE}-shm`), { force: true });
    const before = (await readdir(root)).sort();

    await expect(Library.open(root)).rejects.toMatchObject({ code: "password_required" });
    await expect(Library.open(root, { password: "guess" })).rejects.toMatchObject({
      code: "password_wrong",
    });
    // Exclusive too: a refused open leaves no lock behind to say it is busy.
    await expect(Library.open(root, { exclusive: true })).rejects.toMatchObject({
      code: "password_required",
    });

    expect((await readdir(root)).sort()).toEqual(before);
    expect(existsSync(join(root, INDEX_FILE))).toBe(false);

    const opened = await Library.open(root, { exclusive: true, password: "secret" });
    await opened.close();
  });

  it("opens again for the unlock an earlier open issued, until the password changes", async () => {
    const root = await lockedLibrary();
    const first = await Library.open(root, { exclusive: true, password: "secret" });
    const unlock = first.unlock;
    expect(unlock).toBeDefined();
    await first.close();

    const again = await Library.open(root, { exclusive: true, ...(unlock && { unlock }) });
    await again.changePassword("secret", "changed");
    await again.close();

    await expect(Library.open(root, { ...(unlock && { unlock }) })).rejects.toMatchObject({
      code: "password_required",
    });
  });

  it("issues no unlock for a library without a password", async () => {
    const root = join(dir, "plain.roost");
    const library = await Library.create(root, "plain");
    try {
      expect(library.unlock).toBeUndefined();
    } finally {
      await library.close();
    }
    // A password offered to a library without one is not a mistake.
    const opened = await Library.open(root, { password: "anything" });
    await opened.close();
  });
});

describe("the version and the field agree (RL-5c)", () => {
  const base = {
    id: "e0ec4720-c791-4a56-84a5-2c7fc11bb00e",
    name: "Fixture",
    created_at: 1789344118,
  };

  async function manifestFile(name: string, body: unknown): Promise<string> {
    const root = join(dir, name);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "library.json"), JSON.stringify(body), "utf8");
    return root;
  }

  it("refuses version 3 without a password, and version 2 with one", async () => {
    const record = await hashPassword("x");
    const three = await manifestFile("three", { roost_library_version: 3, ...base });
    await expect(readManifest(three)).rejects.toMatchObject({
      code: "not_a_library",
      detail: { reason: "version 3 without a password" },
    });
    const two = await manifestFile("two", {
      roost_library_version: 2,
      ...base,
      password: record,
    });
    await expect(readManifest(two)).rejects.toMatchObject({
      code: "not_a_library",
      detail: { reason: "a password in a version 2 library" },
    });
    const both = await manifestFile("both", {
      roost_library_version: 3,
      ...base,
      password: record,
    });
    expect((await readManifest(both)).password).toEqual(record);
  });

  it("refuses a password record it cannot check", async () => {
    const record = await hashPassword("x");
    const root = await manifestFile("bad", {
      roost_library_version: 3,
      ...base,
      password: { ...record, n: 2 ** 22 },
    });
    await expect(readManifest(root)).rejects.toMatchObject({ code: "not_a_library" });
  });
});
