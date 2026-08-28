// A bounded worker pool, used by every place that has more than one file to send.
//
// Uploads run concurrently, but the OUTPUT they produce must still read in file order, so the
// pool settles each item in place and hands it back through `onSettled` in index order — item 3
// waits for items 1 and 2 to be reported even when it finished first. That is what lets a
// concurrent upload keep the per-file transaction log this app exists to show.
//
// Nothing here throws: a worker that rejects settles as { status: 'rejected' }, so one failed
// upload never cancels the others.

/**
 * Run `worker` over `items` with at most `limit` in flight.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit                       max concurrent workers (coerced to >= 1)
 * @param {(item: T, index: number) => Promise<R>} worker
 * @param {(outcome: { status: 'fulfilled', value: R } | { status: 'rejected', reason: any },
 *          item: T, index: number) => void|Promise<void>} [onSettled]
 *   Called once per item, in index order, as soon as that item AND every item before it settled.
 * @returns {Promise<Array<{ status: 'fulfilled', value: R } | { status: 'rejected', reason: any }>>}
 *   One outcome per item, in input order.
 */
export async function mapWithConcurrency(items, limit, worker, onSettled) {
  const list = Array.from(items);
  const outcomes = new Array(list.length);

  // One gate per item, opened the moment that item settles. The reporting loop below awaits
  // them in order, which is what turns "finished in any order" into "reported in file order".
  const gates = list.map(() => {
    let open;
    const opened = new Promise((resolve) => {
      open = resolve;
    });
    return { opened, open };
  });

  const workers = Math.max(1, Math.min(toPositiveInt(limit, 1), list.length || 1));
  let next = 0;

  const pool = Array.from({ length: workers }, async () => {
    for (let i = next++; i < list.length; i = next++) {
      try {
        outcomes[i] = { status: 'fulfilled', value: await worker(list[i], i) };
      } catch (reason) {
        outcomes[i] = { status: 'rejected', reason };
      }
      gates[i].open();
    }
  });

  const report = (async () => {
    if (!onSettled) return;
    for (let i = 0; i < list.length; i++) {
      await gates[i].opened;
      await onSettled(outcomes[i], list[i], i);
    }
  })();

  await Promise.all([...pool, report]);
  return outcomes;
}

/** Coerce a config/CLI value to a positive integer, falling back when it is unusable. */
export function toPositiveInt(value, fallback) {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
