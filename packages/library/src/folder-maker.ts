import { toNfc } from "@roost/core";
import { createFolder } from "./edit.js";
import type { Library } from "./library.js";

/**
 * Folders found or made by name, one level at a time.
 *
 * For the two runs that bring a tree of folders into a library: a transfer from
 * another library (ADR-0054 §3.4) and a directory imported with its structure
 * (ADR-0058). A level is **reused** where its parent already has a folder of
 * that name, compared as `createFolder` compares siblings — trimmed, NFC, and
 * without regard to case — because creating unconditionally would give a
 * second run a second `Icons` beside the first, and `createFolder` would refuse
 * it anyway.
 *
 * **Creations are made one at a time.** An import works eight files at once,
 * and two of them in one new directory must get one folder. Two in different
 * new directories must not both be handed the next id: `createFolder` reads it
 * before it journals, so two at once would read the same one.
 */
export class FolderMaker {
  readonly #library: Library;
  /** Each folder by parent and name, made here or found, as a promise of its id. */
  readonly #known = new Map<string, Promise<number>>();
  /** The last creation, which the next one waits for. */
  #queue: Promise<unknown> = Promise.resolve();
  /** How many folders this maker made, for the report that says so. */
  created = 0;

  constructor(library: Library) {
    this.#library = library;
    for (const folder of library.db.repo.folders()) {
      this.#known.set(keyOf(folder.parentId, folder.name), Promise.resolve(folder.id));
    }
  }

  /** The folder called `name` under `parent`, made if there is none. */
  child(parent: number | null, name: string): Promise<number> {
    const key = keyOf(parent, name);
    const known = this.#known.get(key);
    if (known !== undefined) return known;

    const made = this.#queue.then(() => createFolder(this.#library, name, parent));
    this.#queue = made.catch(() => undefined);
    const counted = made.then((id) => {
      this.created += 1;
      return id;
    });
    this.#known.set(key, counted);
    // Forgotten when it fails, so the error is not handed to every later file
    // in that directory as though it were a folder.
    counted.catch(() => this.#known.delete(key));
    return counted;
  }
}

/** The comparison `createFolder` refuses a sibling by. */
function keyOf(parent: number | null, name: string): string {
  return `${parent ?? "-"}/${toNfc(name.trim()).toLowerCase()}`;
}
