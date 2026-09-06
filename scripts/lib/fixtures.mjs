/**
 * Throwaway libraries for the checks that drive a window.
 *
 * Each of these scripts builds its own library in a temporary directory and
 * deletes it again, so none of them can ever touch anything of yours. That was
 * already true of `check-trash.mjs` and `check-transport.mjs` separately; this
 * is the same guarantee written once.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToFolder, createFolder, importInto, Library, pageOf } from "@roost/library";
import { gradient } from "@roost/media";

/** A temporary directory and the promise that it goes away again. */
export async function scratch(prefix) {
  const dir = await mkdtemp(join(tmpdir(), `roost-${prefix}-`));
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * A library with `count` real images in it.
 *
 * Real images rather than random bytes: a grid check is about thumbnails, and
 * an asset with no thumbnail draws a placeholder that has its own layout.
 */
export async function imageLibrary(dir, { count = 12, name = "Check", size = 64 } = {}) {
  const source = join(dir, "pictures");
  await mkdir(source, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    await writeFile(
      join(source, `shot-${index}.png`),
      await gradient(size, size, index + 1, "png"),
    );
  }
  const root = join(dir, `${name}.roost`);
  const library = await Library.create(root, name);
  try {
    await importInto(library, [source]);
  } finally {
    await library.close();
  }
  return root;
}

/**
 * Files an existing library's assets into a folder tree.
 *
 * `tree` is a list of `{ name, parent, assets }`, parents named by their own
 * name — the tree is three folders deep at most in a fixture, and ids the
 * caller would have to thread through are worse to read than names.
 *
 * **The names matter to the check that uses this.** A child whose name sorts
 * before its parent's is what tells a real tree from an alphabetical run
 * indented to look like one (ADR-0033 §2), so a fixture built for that has to
 * pick names that sort the wrong way on purpose.
 */
export async function foldersInto(root, tree) {
  const library = await Library.open(root);
  try {
    const ids = new Map();
    const hashes = pageOf(library, "", { limit: 100 }).map((hit) => hit.hash);
    for (const { name, parent, assets = 0 } of tree) {
      const id = await createFolder(library, name, parent === undefined ? null : ids.get(parent));
      ids.set(name, id);
      if (assets > 0) await addToFolder(library, hashes.slice(0, assets), id);
    }
    return ids;
  } finally {
    await library.close();
  }
}

/**
 * A small Eagle library, of the shape a real one has (ADR-0032 §2).
 *
 * Written by hand rather than copied from anybody's Eagle: the format is
 * `images/<id>.info/` holding the original, Eagle's own thumbnail, and a
 * `metadata.json`, with the folder tree and the tag groups in a `metadata.json`
 * at the root. Two conventions here are load-bearing and both are deliberate —
 * `star` is **omitted** on the unrated item, because Eagle omits it and absent
 * is not zero; and a `.srt` sits beside one file mentioned by no metadata at
 * all, which is how a caption travels in Eagle.
 */
export async function eagleLibrary(dir, { name = "Sample" } = {}) {
  const root = join(dir, `${name}.library`);
  await mkdir(join(root, "images"), { recursive: true });

  await writeFile(
    join(root, "metadata.json"),
    JSON.stringify({
      folders: [
        { id: "f-gym", name: "gym", children: [] },
        {
          id: "f-set",
          name: "majorette",
          children: [{ id: "f-deep", name: "Deep", children: [] }],
        },
      ],
      smartFolders: [],
      tagsGroups: [],
      quickAccess: [],
      applicationVersion: "4.0.0",
    }),
  );
  await writeFile(join(root, "tags.json"), JSON.stringify({ historyTags: [], starredTags: [] }));
  await writeFile(join(root, "mtime.json"), JSON.stringify({ all: 3 }));

  const items = [
    { id: "a1", ext: "png", tags: ["blue"], folders: ["f-gym"], star: 4, annotation: "a note" },
    { id: "a2", ext: "png", tags: [], folders: ["f-set", "f-deep"], url: "https://example.test/1" },
    // An `.mp4` because that is what a caption sits beside. The bytes are not a
    // video and nothing here plays it — attachment is decided by the name, and
    // a probe that fails leaves the asset without dimensions rather than
    // without a row (ADR-0025 §3).
    { id: "a3", ext: "mp4", tags: ["blue"], folders: [], srt: true },
  ];

  for (const [index, item] of items.entries()) {
    const info = join(root, "images", `${item.id}.info`);
    await mkdir(info, { recursive: true });
    // Seeded away from `imageLibrary`'s own gradients: identical bytes are one
    // asset (invariant 1), so a fixture that shares them would count an import
    // as a duplicate and prove the opposite of what it meant to.
    await writeFile(
      join(info, `${item.id}.${item.ext}`),
      item.ext === "png" ? await gradient(64, 64, index + 100, "png") : `not a video ${index}`,
    );
    await writeFile(join(info, `${item.id}_thumbnail.png`), await gradient(16, 16, 9, "png"));
    if (item.srt === true) {
      await writeFile(join(info, `${item.id}.srt`), "1\n00:00:01,000 --> 00:00:02,000\nhi\n");
    }
    await writeFile(
      join(info, "metadata.json"),
      JSON.stringify({
        id: item.id,
        name: item.id,
        size: 0,
        btime: 1_700_000_000_000,
        mtime: 1_600_000_000_000,
        ext: item.ext,
        tags: item.tags,
        folders: item.folders,
        isDeleted: false,
        url: item.url ?? "",
        annotation: item.annotation ?? "",
        comments: [{ id: "c1", duration: 1.5, annotation: "a comment" }],
        ...(item.star === undefined ? {} : { star: item.star }),
      }),
    );
  }

  return root;
}

/**
 * A playable clip.
 *
 * **Not ffmpeg's default encoder for `.mp4`**, which is MPEG-4 Part 2 here:
 * Chromium refuses it with error 4 and it reads exactly like a broken protocol
 * handler — the content type is right and the bytes are right. This build has
 * no `libx264` either, so `libopenh264` is the spelling that works. Any fixture
 * meant to be *played* has to say so explicitly (`TODO.md` §2).
 */
export async function videoClip(path, { seconds = 20, size = "320x240", rate = 10 } = {}) {
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=${size}:rate=${rate}:duration=${seconds}`,
    "-c:v",
    "libopenh264",
    "-pix_fmt",
    "yuv420p",
    path,
  ]);
  return path;
}

/** A child process, resolved on a zero exit and rejected with its stderr. */
export function run(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    proc.stderr.on("data", (chunk) => {
      error += chunk;
    });
    proc.on("error", reject);
    proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(error))));
  });
}
