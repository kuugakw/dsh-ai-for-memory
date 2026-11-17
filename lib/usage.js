/**
 * Conversation-scoped knowledge usage weights.
 *
 * Every knowledge store (one conversation, or the shared layer) keeps its own
 * usage log at `knowledge/_usage.json`: `doc_id -> { at, count }`. The weight
 * decays with the time since the document was last used, so ranking is
 * "recently used first, long unused lower" **inside that conversation** — the
 * same document can carry a different weight in another conversation, which is
 * exactly the isolation the memory layer wants.
 *
 * Unused documents get weight 0 and keep their original relevance score; the
 * boost is additive in spirit (`score * (1 + 0.25 * weight)`), so a brand-new
 * highly relevant document is never pushed down merely because the
 * conversation has not used it yet.
 */

/** Weight halves for every 14 days without use. */
export const USAGE_HALF_LIFE_DAYS = 14;

/** Maximum relative boost for a just-used document (+25%). */
export const USAGE_BOOST = 0.25;

/** File name inside `knowledge/`; never treated as a knowledge document. */
export const USAGE_FILE = '_usage.json';

/** Cap the usage log so it cannot grow without bound. */
export const USAGE_MAX_ENTRIES = 1000;

const HALF_LIFE_MS = USAGE_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Recency weight in `[0, 1]`: 1 when used right now, 0.5 after 14 days,
 * approaching 0 for long-unused documents.
 */
export function recencyWeight(usedAt, now = Date.now()) {
  if (typeof usedAt !== 'string' || usedAt === '') return 0;
  const used = Date.parse(usedAt);
  if (!Number.isFinite(used)) return 0;
  const age = Math.max(0, Number(now) - used);
  return 0.5 ** (age / HALF_LIFE_MS);
}

/** Apply the recency weight to one relevance score. */
export function boostScore(score, weight) {
  const value = Number(score);
  if (!Number.isFinite(value)) return 0;
  const w = Number.isFinite(weight) ? Math.min(1, Math.max(0, weight)) : 0;
  return value * (1 + USAGE_BOOST * w);
}

/** Short human label, e.g. `权重 0.87（最近使用）`. */
export function weightLabel(weight) {
  const value = Math.min(1, Math.max(0, Number(weight) || 0));
  if (value >= 0.75) return `权重 ${value.toFixed(2)}（最近使用）`;
  if (value >= 0.2) return `权重 ${value.toFixed(2)}`;
  if (value > 0) return `权重 ${value.toFixed(2)}（较久未用）`;
  return '权重 0.00（未使用）';
}
