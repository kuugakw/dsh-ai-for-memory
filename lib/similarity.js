/**
 * Topic similarity for similarity-aware context clearing.
 *
 * Context clearing must not be recency-only: a long conversation hops between
 * topics, and the older turns that still belong to the current topic are the
 * cheapest context to keep verbatim. This module answers one question for one
 * finished turn:
 *
 *   how much does this turn share a topic with the current turn (and the one
 *   before it), compared with where the conversation has moved since?
 *
 * The metric is deliberately dependency-free and deterministic, reusing the
 * local BM25/hashing vocabulary in `retrieval.js`:
 *
 * - **lexical overlap** — shared content tokens (CJK bigrams and Latin words of
 *   three or more characters; single Han characters are function words and are
 *   dropped). This dominates the score because it is the signal that actually
 *   separates topics: unrelated turns in the calibration corpus score 0.00,
 *   same-topic paraphrases score 0.08–0.30.
 * - **hashed-vector cosine** — a small tie-breaker for paraphrases that share
 *   few exact tokens. Long *unrelated* Chinese texts still reach cosine ≈ 0.58
 *   from shared unigrams and function-word bigrams, so the cosine term only
 *   counts above 0.60; below that it would add a near-constant floor to every
 *   pair and make every old turn look “related”.
 *
 * The result is a number in roughly `[0, 0.9]`; `SIMILARITY_DEFAULT` is the
 * keep/clear threshold.
 */

import { buildVector, cosine, tokenize } from './retrieval.js';

/**
 * Default threshold: below it a turn counts as a different topic.
 *
 * Calibrated on long, realistic Chinese turns (each side 80–120 content
 * tokens): same-topic pairs score ≈ 0.06–0.17, unrelated pairs ≈ 0.01–0.07.
 */
export const SIMILARITY_DEFAULT = 0.05;

const HAN = /[\u3400-\u9fff\uf900-\ufaff]/;

/** Cosine below this floor carries no topical signal for long texts. */
const COSINE_FLOOR = 0.6;

/** Cosine span above the floor that maps to a full-strength tie-breaker. */
const COSINE_SPAN = 0.4;

/** Weight of the cosine tie-breaker inside the final score. */
const COSINE_WEIGHT = 0.15;

/**
 * Content tokens of one text: CJK bigrams and Latin words of at least three
 * characters. Single Han characters and short Latin words are dropped because
 * they are shared by every topic.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function contentTokens(text) {
  const out = new Set();
  for (const token of tokenize(text)) {
    if (HAN.test(token) ? token.length < 2 : token.length < 3) continue;
    out.add(token);
  }
  return out;
}

/**
 * Clamp a number into `[low, high]`, tolerating `undefined`/`NaN`.
 *
 * @param {number} value
 * @param {number} low
 * @param {number} high
 * @param {number} fallback
 */
function clamp(value, low, high, fallback) {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(high, Math.max(low, number));
}

/**
 * Share of content tokens that two texts have in common (Sørensen–Dice).
 *
 * Dice is symmetric and cannot be inflated by a very short side, which matters
 * because short acknowledgements ("继续", "好的") sit next to every topic.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number} `0` when either side has no content token.
 */
export function lexicalOverlap(left, right) {
  const a = contentTokens(left);
  const b = contentTokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/**
 * Topical similarity of two texts, in roughly `[0, 0.9]`.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number} `0` when either side is empty.
 */
export function topicSimilarity(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  if (a.trim() === '' || b.trim() === '') return 0;
  const lexical = lexicalOverlap(a, b);
  const cos = cosine(buildVector(a), buildVector(b));
  const cosineTerm = cos <= COSINE_FLOOR ? 0 : Math.min(1, (cos - COSINE_FLOOR) / COSINE_SPAN);
  return lexical + COSINE_WEIGHT * cosineTerm;
}

/** Text a turn contributes to the topic comparison. */
function textOfTurn(turn) {
  if (!turn) return '';
  if (typeof turn.text === 'string') return turn.text;
  const parts = [];
  if (turn.user) parts.push(String(turn.user));
  if (turn.assistant) parts.push(String(turn.assistant));
  return parts.join('\n');
}

/**
 * Split finished turns into the ones that still match the current topic and
 * the ones the conversation has moved away from.
 *
 * The last `keepRecent` turns are always kept: they are the current topic and
 * its immediate predecessor, and clearing them is exactly the behaviour this
 * policy exists to avoid. Every older turn is scored against the last
 * `anchorTurns` turns (the current one and the previous one by default) and
 * kept when its best score reaches `threshold`.
 *
 * @param {Array<{turn: number, user?: string, assistant?: string, text?: string,
 *   chars?: number, seqs?: number[]}>} turns - oldest first.
 * @param {{threshold?: number, keepRecent?: number, anchorTurns?: number}} [options]
 * @returns {{keep: Array<object>, clear: Array<object>, anchors: number[],
 *   threshold: number, keepRecent: number}}
 *   `keep` and `clear` hold shallow copies carrying `similarity`, so callers
 *   can log why one turn survived and another did not.
 */
export function selectTurnsByTopic(turns, options = {}) {
  const list = Array.isArray(turns) ? turns.filter((turn) => turn && typeof turn === 'object') : [];
  const threshold = clamp(options.threshold, 0.01, 0.95, SIMILARITY_DEFAULT);
  const keepRecent = Math.round(clamp(options.keepRecent, 1, 50, 2));
  const anchorTurns = Math.round(clamp(options.anchorTurns, 1, 10, 2));
  const anchorStart = Math.max(0, list.length - Math.min(anchorTurns, list.length));
  const anchors = list.slice(anchorStart).map((turn) => turn.turn);
  const anchorTexts = list.slice(anchorStart).map(textOfTurn).filter((text) => text !== '');
  const keepEdge = Math.max(0, list.length - keepRecent);

  const keep = [];
  const clear = [];
  for (let index = 0; index < list.length; index += 1) {
    const turn = list[index];
    if (index >= keepEdge) {
      keep.push({ ...turn, similarity: 1, keptBy: 'recent' });
      continue;
    }
    const text = textOfTurn(turn);
    let score = 0;
    for (const anchor of anchorTexts) {
      const candidate = topicSimilarity(text, anchor);
      if (candidate > score) score = candidate;
    }
    if (score >= threshold) keep.push({ ...turn, similarity: score, keptBy: 'topic' });
    else clear.push({ ...turn, similarity: score, keptBy: 'topic' });
  }

  return { keep, clear, anchors, threshold, keepRecent };
}

/**
 * Human-readable reason for one cleared run, used in the model-facing note that
 * replaces it.
 *
 * @param {Array<{turn: number}>} turns - cleared turns, oldest first.
 * @param {number} similarity - best similarity of the run (the highest score
 *   inside it, so the note never claims more distance than the run has).
 * @returns {string}
 */
export function describeTurns(turns, similarity) {
  const numbers = turns.map((turn) => turn.turn).filter((turn) => Number.isInteger(turn));
  if (numbers.length === 0) return '更早的若干轮';
  const first = numbers[0];
  const last = numbers[numbers.length - 1];
  const span = first === last ? `第 ${first} 轮` : `第 ${first}-${last} 轮`;
  const score = Number.isFinite(similarity) ? similarity.toFixed(2) : '0.00';
  return `${span}（与当前话题相似度 ${score}）`;
}
