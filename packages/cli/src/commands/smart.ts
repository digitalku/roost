import { toWire } from "@roost/core";
import {
  count,
  createSmartFolder,
  deleteSmartFolder,
  resolveSmartFolder,
  updateSmartFolder,
} from "@roost/library";
import { EXIT, type Streams, usage } from "../io.js";
import { withLibrary } from "../open.js";

/**
 * `roost smart <create|update|delete|list>` — RQL queries saved under a name.
 *
 * A smart folder stores its query, not its results, so it is evaluated every
 * time it is read and can never go stale.
 */
export async function smart(
  root: string,
  args: readonly string[],
  options: { readonly rename: string | undefined; readonly query: string | undefined },
  streams: Streams,
): Promise<number> {
  const [sub, ...rest] = args;

  switch (sub) {
    case "create": {
      const [name, text] = rest;
      if (name === undefined || text === undefined) {
        return usage(streams, "smart", "smart create needs a name and a query");
      }
      return withLibrary(root, async (library) => {
        const id = await createSmartFolder(library, name, text, null);
        streams.out(`Saved smart folder ${name} (id ${id}) — ${count(library, text)} match now`);
        return EXIT.ok;
      });
    }

    case "update": {
      const [name] = rest;
      if (name === undefined) return usage(streams, "smart", "smart update needs a name");
      if (options.rename === undefined && options.query === undefined) {
        return usage(streams, "smart", "smart update needs --rename or --query");
      }
      return withLibrary(root, async (library) => {
        const id = resolveSmartFolder(library, name);
        const existing = library.db.repo.findSmartFolderByName(name.trim());
        await updateSmartFolder(
          library,
          id,
          options.rename ?? existing?.name ?? name,
          options.query ?? existing?.query ?? "",
        );
        streams.out(`Updated ${name}`);
        return EXIT.ok;
      });
    }

    case "delete": {
      const [name] = rest;
      if (name === undefined) return usage(streams, "smart", "smart delete needs a name");
      return withLibrary(root, async (library) => {
        await deleteSmartFolder(library, resolveSmartFolder(library, name));
        streams.out(`Deleted ${name}`);
        return EXIT.ok;
      });
    }

    case "list":
      return withLibrary(root, async (library) => {
        const saved = library.db.repo.smartFolders();
        if (saved.length === 0) {
          streams.out("No smart folders yet. Save one with `roost smart create`.");
        }
        for (const row of saved) {
          // Evaluated on read, so the number is never stale — that is the point
          // of storing the query rather than its results. A query saved by a
          // newer build may not parse here, and that is reported per row rather
          // than failing the listing.
          let matched: string;
          try {
            matched = String(count(library, row.query));
          } catch (error) {
            matched = `error: ${toWire(error).message}`;
          }
          streams.out(`${matched.padStart(7)}  ${row.name}`);
          streams.out(`         ${row.query}`);
        }
        return EXIT.ok;
      });

    default:
      return usage(streams, "smart", "smart needs create, update, delete, or list");
  }
}
