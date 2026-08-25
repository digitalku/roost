import {
  addToFolder,
  createFolder,
  deleteFolder,
  type FolderEntry,
  moveFolder,
  readSidebar,
  removeFromFolder,
  renameFolder,
  resolveFolder,
} from "@roost/library";
import { assets, resolveAll } from "../assets.js";
import { EXIT, type Streams, usage } from "../io.js";
import { withLibrary } from "../open.js";

/**
 * `roost folder <create|rename|move|delete|add|remove|list>`.
 *
 * Folders are collections, not locations: adding an asset to one moves nothing
 * on disk, and deleting one deletes no assets.
 */
export async function folder(
  root: string,
  args: readonly string[],
  parent: string | undefined,
  streams: Streams,
): Promise<number> {
  const [sub, ...rest] = args;

  switch (sub) {
    case "create": {
      const [name] = rest;
      if (name === undefined) return usage(streams, "folder", "folder create needs a name");
      return withLibrary(root, async (library) => {
        const under = parent === undefined ? null : resolveFolder(library, parent);
        const id = await createFolder(library, name, under);
        streams.out(`Created folder ${name} (id ${id})`);
        return EXIT.ok;
      });
    }

    case "rename": {
      const [path, name] = rest;
      if (path === undefined || name === undefined) {
        return usage(streams, "folder", "folder rename needs a path and a new name");
      }
      return withLibrary(root, async (library) => {
        await renameFolder(library, resolveFolder(library, path), name);
        streams.out(`Renamed ${path} to ${name}`);
        return EXIT.ok;
      });
    }

    case "move": {
      const [path] = rest;
      if (path === undefined) return usage(streams, "folder", "folder move needs a path");
      return withLibrary(root, async (library) => {
        const under = parent === undefined ? null : resolveFolder(library, parent);
        await moveFolder(library, resolveFolder(library, path), under);
        streams.out(under === null ? `Moved ${path} to the top level` : `Moved ${path}`);
        return EXIT.ok;
      });
    }

    case "delete": {
      const [path] = rest;
      if (path === undefined) return usage(streams, "folder", "folder delete needs a path");
      return withLibrary(root, async (library) => {
        await deleteFolder(library, resolveFolder(library, path));
        streams.out(`Deleted folder ${path}. The assets in it are still in the library.`);
        return EXIT.ok;
      });
    }

    case "add":
    case "remove": {
      const [path, ...needles] = rest;
      if (path === undefined || needles.length === 0) {
        return usage(streams, "folder", `folder ${sub} needs a path and at least one asset`);
      }
      return withLibrary(root, async (library) => {
        const id = resolveFolder(library, path);
        const hashes = resolveAll(library, needles);
        if (sub === "add") {
          await addToFolder(library, hashes, id);
          streams.out(`Added ${assets(hashes.length)} to ${path}`);
        } else {
          await removeFromFolder(library, hashes, id);
          streams.out(`Removed ${assets(hashes.length)} from ${path}`);
        }
        return EXIT.ok;
      });
    }

    case "list":
      return withLibrary(root, async (library) => {
        const tree = readSidebar(library).folders;
        if (tree.length === 0) streams.out("No folders yet.");
        printTree(tree, null, 0, streams.out);
        return EXIT.ok;
      });

    default:
      return usage(
        streams,
        "folder",
        "folder needs create, rename, move, delete, add, remove, or list",
      );
  }
}

/**
 * Prints the tree depth-first, with each folder's subtree count.
 *
 * Recursion is bounded by a depth a person built by hand; this is not a place
 * where a million-node structure is possible.
 */
function printTree(
  tree: readonly FolderEntry[],
  parent: number | null,
  depth: number,
  out: (line: string) => void,
): void {
  for (const entry of tree.filter((candidate) => candidate.parentId === parent)) {
    out(`${" ".repeat(depth * 2)}${entry.name} (${entry.id}) — ${entry.count}`);
    printTree(tree, entry.id, depth + 1, out);
  }
}
