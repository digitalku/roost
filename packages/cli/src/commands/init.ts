import { basename, resolve } from "node:path";
import { Library } from "@roost/library";
import { row } from "../format.js";

export interface InitArgs {
  readonly path: string;
  readonly name?: string;
}

export async function init(args: InitArgs, out: (line: string) => void): Promise<void> {
  const root = resolve(args.path);
  const library = await Library.create(root, args.name ?? basename(root));
  try {
    out(`Created library "${library.manifest.name}"`);
    out(row("path", root));
    out(row("id", library.manifest.id));
  } finally {
    await library.close();
  }
}
