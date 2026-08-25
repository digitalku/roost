import {
  createTagGroup,
  deleteTagGroup,
  type Library,
  renameTagGroup,
  resolveTagGroup,
  setTagGroup,
  tagAdd,
  tagRemove,
  tagRename,
} from "@roost/library";
import { assets, resolveAll } from "../assets.js";
import { EXIT, type Streams, usage } from "../io.js";
import { withLibrary } from "../open.js";

/**
 * `roost tag <add|remove|rename|list|group>`.
 *
 * Argument shapes and printing only. Every mutation goes through
 * `@roost/library`'s edit service, which journals before it indexes — the CLI
 * has no path to the database that skips that.
 */
export async function tag(
  root: string,
  args: readonly string[],
  tags: readonly string[],
  streams: Streams,
): Promise<number> {
  const [sub, ...rest] = args;

  switch (sub) {
    case "add":
    case "remove": {
      if (tags.length === 0) return usage(streams, "tag", `tag ${sub} needs at least one --tag`);
      if (rest.length === 0) return usage(streams, "tag", `tag ${sub} needs at least one asset`);
      return withLibrary(root, async (library) => {
        const hashes = resolveAll(library, rest);
        if (sub === "add") {
          await tagAdd(library, hashes, tags);
          streams.out(`Tagged ${assets(hashes.length)} with ${tags.join(", ")}`);
        } else {
          await tagRemove(library, hashes, tags);
          streams.out(`Removed ${tags.join(", ")} from ${assets(hashes.length)}`);
        }
        return EXIT.ok;
      });
    }

    case "rename": {
      const [from, to] = rest;
      if (from === undefined || to === undefined) {
        return usage(streams, "tag", "tag rename needs a name and a new name");
      }
      return withLibrary(root, async (library) => {
        // Read before the rename: afterwards the two tags are one, and there is
        // no way back to the question of whether they started that way.
        const merging = mergesInto(library, from, to);
        await tagRename(library, from, to);
        streams.out(
          merging ? `Merged ${from} into the existing tag ${to}` : `Renamed ${from} to ${to}`,
        );
        return EXIT.ok;
      });
    }

    case "list":
      return withLibrary(root, async (library) => {
        const rows = library.db.repo.tags();
        if (rows.length === 0) streams.out("No tags yet.");

        let group: string | null | undefined;
        for (const row of rows) {
          if (row.group !== group) {
            streams.out("");
            streams.out(row.group ?? "Ungrouped");
            group = row.group;
          }
          streams.out(`${String(row.count).padStart(7)}  ${row.name}`);
        }
        return EXIT.ok;
      });

    case "group":
      return group(root, rest, streams);

    default:
      return usage(streams, "tag", "tag needs add, remove, rename, list, or group");
  }
}

/** Whether renaming `from` to `to` will merge into a tag that already exists. */
function mergesInto(library: Library, from: string, to: string): boolean {
  const fold = (name: string) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  return library.db.repo
    .tags()
    .some((row) => fold(row.name) === fold(to) && fold(row.name) !== fold(from));
}

async function group(root: string, args: readonly string[], streams: Streams): Promise<number> {
  const [sub, ...rest] = args;

  switch (sub) {
    case "create": {
      const [name] = rest;
      if (name === undefined) return usage(streams, "tag", "tag group create needs a name");
      return withLibrary(root, async (library) => {
        const id = await createTagGroup(library, name);
        streams.out(`Created tag group ${name} (id ${id})`);
        return EXIT.ok;
      });
    }

    case "rename": {
      const [name, renamed] = rest;
      if (name === undefined || renamed === undefined) {
        return usage(streams, "tag", "tag group rename needs a name and a new name");
      }
      return withLibrary(root, async (library) => {
        await renameTagGroup(library, resolveTagGroup(library, name), renamed);
        streams.out(`Renamed ${name} to ${renamed}`);
        return EXIT.ok;
      });
    }

    case "delete": {
      const [name] = rest;
      if (name === undefined) return usage(streams, "tag", "tag group delete needs a name");
      return withLibrary(root, async (library) => {
        await deleteTagGroup(library, resolveTagGroup(library, name));
        streams.out(`Deleted the group ${name}. Its tags are still there, ungrouped.`);
        return EXIT.ok;
      });
    }

    case "add": {
      const [name, ...names] = rest;
      if (name === undefined || names.length === 0) {
        return usage(streams, "tag", "tag group add needs a group and at least one tag");
      }
      return withLibrary(root, async (library) => {
        await setTagGroup(library, names, resolveTagGroup(library, name));
        streams.out(`Put ${names.join(", ")} into ${name}`);
        return EXIT.ok;
      });
    }

    case "remove": {
      if (rest.length === 0) {
        return usage(streams, "tag", "tag group remove needs at least one tag");
      }
      return withLibrary(root, async (library) => {
        await setTagGroup(library, rest, null);
        streams.out(`Took ${rest.join(", ")} out of their groups`);
        return EXIT.ok;
      });
    }

    case "list":
      return withLibrary(root, async (library) => {
        const groups = library.db.repo.tagGroups();
        if (groups.length === 0) {
          streams.out("No tag groups yet. Create one with `roost tag group create`.");
        }
        for (const row of groups) streams.out(`${String(row.id).padStart(5)}  ${row.name}`);
        return EXIT.ok;
      });

    default:
      return usage(streams, "tag", "tag group needs create, rename, delete, add, remove, or list");
  }
}
