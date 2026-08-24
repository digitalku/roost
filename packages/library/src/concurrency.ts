/**
 * Runs `work` over `items` with at most `limit` in flight.
 *
 * Results come back in the order of `items`, not of completion, so a caller can
 * pair them with their inputs — which the import pipeline needs, because the
 * journal is an ordered log and a concurrent walk must not reorder it.
 *
 * A worker that throws would abandon the rest, so `work` is expected to catch
 * its own failures and return them as values. Every caller here does.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await work(item, index);
    }
  });

  await Promise.all(workers);
  return results;
}
