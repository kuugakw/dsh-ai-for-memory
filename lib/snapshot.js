/**
 * Automatic snapshot retention.
 *
 * `aim_memory action=snapshot` stores exact state objects in `snapshots/`.
 * The automatic pass stores the newest context window there every N turns, so
 * a conversation always has recent checkpoints. When the number grows past the
 * configured cap, retention removes the **most similar** older snapshots first:
 * near-duplicates add little, while a snapshot that covers a genuinely
 * different topic is worth keeping.
 *
 * The functions here are pure so the pruning policy can be tested without a
 * filesystem. `lib/store.js` does the actual deletion.
 */

import { topicSimilarity } from './similarity.js';

export const AUTO_SNAPSHOT_PREFIX = 'auto-snapshot-';

/** Snapshots at or above this similarity are treated as near-duplicates. */
export const AUTO_SNAPSHOT_SIMILARITY = 0.82;

/** True when a snapshot row was created by the automatic turn trigger. */
export function isAutoSnapshot(row) {
  if (!row || typeof row !== 'object') return false;
  if (typeof row.name === 'string' && row.name.startsWith(AUTO_SNAPSHOT_PREFIX)) return true;
  return row.metadata?.kind === 'auto-snapshot';
}

/** The text used for similarity: the archived window, or the state as JSON. */
export function snapshotText(row) {
  const state = row?.state;
  if (state && typeof state.text === 'string') return state.text;
  if (typeof row?.text === 'string') return row.text;
  return JSON.stringify(state ?? {});
}

/**
 * Decide which automatic snapshots to delete so at most `max` remain.
 *
 * Entries must be oldest-first. While over the cap:
 *  - find the most similar pair; if its similarity reaches `threshold`, delete
 *    the older member and keep the newer one (the old state is superseded);
 *  - otherwise delete the oldest entry, because even a diverse snapshot cannot
 *    stay once the hard cap is reached.
 *
 * @param {Array<{snapshot_id: string, text: string}>} entries oldest first
 * @param {{max?: number, threshold?: number}} [options]
 * @returns {{keep: object[], removed: Array<object & {similarity: number,
 *   reason: 'similar'|'oldest'}>}}
 */
export function planSnapshotPrune(entries, options = {}) {
  const max = Number.isInteger(options.max) && options.max > 0 ? options.max : 10;
  const threshold = typeof options.threshold === 'number'
    && Number.isFinite(options.threshold) ? options.threshold : AUTO_SNAPSHOT_SIMILARITY;
  const list = Array.isArray(entries)
    ? entries.filter((entry) => entry && typeof entry === 'object').slice()
    : [];
  const removed = [];

  while (list.length > max) {
    let best = null;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const score = topicSimilarity(snapshotText(list[i]), snapshotText(list[j]));
        if (!best || score > best.score) best = { i, j, score };
      }
    }
    if (best && best.score >= threshold) {
      const [dropped] = list.splice(best.i, 1);
      removed.push({
        ...dropped,
        similarity: Number(Math.min(1, best.score).toFixed(4)),
        reason: 'similar',
      });
    } else {
      const [dropped] = list.splice(0, 1);
      removed.push({ ...dropped, similarity: 0, reason: 'oldest' });
    }
  }

  return { keep: list, removed };
}
