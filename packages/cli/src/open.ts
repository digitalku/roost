import { Library } from "@roost/library";

/**
 * Opens a library, runs `body`, and closes it however that ends.
 *
 * Closing is not optional: the journal buffers, and a library dropped without
 * closing loses whatever had not been flushed. Every command that touches one
 * goes through here rather than remembering to write the `finally` itself.
 */
export async function withLibrary<T>(
  root: string,
  body: (library: Library) => Promise<T>,
): Promise<T> {
  const library = await Library.open(root);
  try {
    return await body(library);
  } finally {
    await library.close();
  }
}
