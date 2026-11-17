/**
 * Text knowledge: what this project knows, written as short reusable facts.
 *
 * Knowledge has two halves. This module owns the **text** half; the RAG half is
 * deliberately absent until the text corpus exists and can be indexed.
 *
 * The text corpus is fed from both ends:
 *
 * - **producers** — the model (a fact read on the web, or derived by reasoning)
 *   and the user (a rule, a preference, a convention). Those are written with
 *   `remember` / `learn`, and carry an explicit source.
 * - **the three layers** — process records, the categorized archive and
 *   archived conversation contexts. `promote` mines them for the statements
 *   that are worth keeping beyond the moment: user rules, error→fix pairs,
 *   decisions with their reason, and durable state facts.
 *
 * Everything is deterministic: no network, no model call, no embedding. A later
 * RAG index can be built straight from the documents this layer writes, which
 * is why each document is one fact, classified, deduplicated and traceable to
 * the record or turn it came from.
 */

import { hash8 } from './util.js';
import { contentTokens } from './similarity.js';

/** The knowledge taxonomy. One fact belongs to exactly one category. */
export const KNOWLEDGE_CATEGORIES = Object.freeze([
  'project_facts',
  'ui_facts',
  'errors_fixes',
  'decisions_reasoning',
  'tools_apis',
  'workflow_rules',
  'external_sources',
  'open_questions',
  'incidents',
]);

/** Who produced a fact. `staging`/`archive`/`context` mean "mined from a layer". */
export const KNOWLEDGE_SOURCES = Object.freeze([
  'user', 'web', 'reasoning', 'staging', 'archive', 'context', 'decision', 'incident', 'unknown',
]);

/** Older archive categories and earlier free-form names mapped onto the set. */
const CATEGORY_ALIASES = Object.freeze({
  behavior_tristate: 'project_facts',
  ui_maps: 'ui_facts',
  action_logs: 'project_facts',
  snapshots: 'project_facts',
  digest: 'project_facts',
  architecture: 'project_facts',
  conventions: 'workflow_rules',
  rules: 'workflow_rules',
  ui: 'ui_facts',
  tools: 'tools_apis',
  api: 'tools_apis',
  errors: 'errors_fixes',
  bugs: 'errors_fixes',
  decisions: 'decisions_reasoning',
  sources: 'external_sources',
  web: 'external_sources',
  incident: 'incidents',
  incidents: 'incidents',
  accident: 'incidents',
  accidents: 'incidents',
  postmortem: 'incidents',
  '事故': 'incidents',
  '事故记录': 'incidents',
});

/** Words that make a sentence a rule the project should keep following. */
const STRONG_RULE_HINTS = Object.freeze([
  '记住', '记得', '以后', '统一', '必须', '不要', '不能', '禁止', '一律', '只允许', '务必', '约定',
  '别再', '不许', '切记', '千万别', '以后都', '都要',
]);

/** Weaker cues: `默认`, `规则`, `要求` also appear in ordinary status prose. */
const WEAK_RULE_HINTS = Object.freeze(['默认', '规则', '偏好', '要求']);

/** A sentence longer than this is a paragraph, not a fact. */
const MAX_FACT_CHARS = 400;

/** Shorter than this is a fragment ("好的", "继续"), not a fact. */
const MIN_FACT_CHARS = 8;

/** Near-duplicate threshold over content tokens. */
const DUPLICATE_JACCARD = 0.85;

/**
 * Same-topic threshold. A document above this overlap but below
 * {@link DUPLICATE_JACCARD} talks about the same thing in different words, which
 * is exactly the case where a new fact may contradict an old one.
 */
const CONFLICT_FLOOR = 0.55;

/**
 * Normalize a knowledge category, mapping retired names onto the current set.
 *
 * @param {unknown} raw
 * @param {string} [fallback]
 * @returns {string}
 */
export function normalizeCategory(raw, fallback = 'project_facts') {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === '') return fallback;
  if (KNOWLEDGE_CATEGORIES.includes(value)) return value;
  const alias = CATEGORY_ALIASES[value];
  if (alias) return alias;
  return fallback;
}

/**
 * Normalize a knowledge source; unknown producers fall back to `unknown`.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeSource(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  return KNOWLEDGE_SOURCES.includes(value) ? value : 'unknown';
}

/**
 * Version of the extraction rules.
 *
 * The promotion ledger records refs mined at this version; when the rules change
 * the ledger is considered stale, so the corpus is re-evaluated instead of
 * staying captured by an older, worse extractor.
 */
export const EXTRACTION_VERSION = 2;

/** Collapse whitespace so the same fact written twice normalizes to one key. */
export function normalizeText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Remove harness-injected envelope text from a conversation excerpt.
 *
 * User messages in a context archive can carry runtime reminders and sampling
 * timestamps appended by the harness. They are not the user's words, so mining
 * them would turn clock noise into "knowledge".
 *
 * @param {string} text
 * @returns {string}
 */
export function stripInjectedText(text) {
  return String(text ?? '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .split('\n')
    .filter((line) => !/^\s*(time sampled while preparing|browser time zone for this request|elapsed since the preceding)/i.test(line))
    .map((line) => line.replace(/[ \t\u3000]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Stable document id for one fact: derived from its normalized text, so writing
 * the same fact twice lands on the same file instead of a second copy.
 *
 * @param {string} text
 * @returns {string}
 */
export function knowledgeKey(text) {
  return `k_${hash8(normalizeText(text).toLowerCase())}`;
}

/**
 * Split prose into candidate fact sentences.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  // Newlines are kept as separators: one line of prose is usually one fact.
  const value = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (value === '') return [];
  const parts = value
    .split(/[。！？!?；;\n]+/)
    .map((part) => part.replace(/^[\s\-*•·\d.、)）]+/, '').trim());
  // A very long sentence is a paragraph: break it on clauses so one clause can
  // still become a fact instead of the whole blob being discarded.
  const out = [];
  for (const part of parts) {
    if (part.length <= MAX_FACT_CHARS) {
      if (part.length >= MIN_FACT_CHARS) out.push(part);
      continue;
    }
    for (const clause of part.split(/[，,、]+/)) {
      const value2 = clause.trim();
      if (value2.length >= MIN_FACT_CHARS && value2.length <= MAX_FACT_CHARS) out.push(value2);
    }
  }
  return out;
}

/** Whether one sentence states a durable rule, preference or convention. */
export function isDurableRule(sentence) {
  const value = String(sentence ?? '');
  if (STRONG_RULE_HINTS.some((hint) => value.includes(hint))) return true;
  const weak = WEAK_RULE_HINTS.filter((hint) => value.includes(hint)).length;
  return weak >= 2;
}

/** Jaccard similarity of two token sets. */
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Attach cached content tokens to documents so duplicate checks stay linear in
 * the number of comparisons instead of re-tokenizing on every pass.
 *
 * @param {Array<{text: string}>} docs
 * @returns {Array<object>}
 */
export function withTokens(docs) {
  return (docs ?? []).map((doc) => ({ ...doc, tokens: contentTokens(doc.text) }));
}

/**
 * Find an existing document that already states this fact.
 *
 * Exact-key matches catch rephrasing-free repeats; the token comparison catches
 * the same fact written in a slightly different order or with a new prefix.
 *
 * @param {string} text
 * @param {Array<{doc_id: string, text: string, tokens?: Set<string>}>} docs
 * @returns {{doc_id: string}|null}
 */
export function findDuplicate(text, docs) {
  const key = knowledgeKey(text);
  const tokens = contentTokens(text);
  let best = null;
  let bestScore = 0;
  for (const doc of docs ?? []) {
    if (doc.doc_id === key) return doc;
    const other = doc.tokens ?? contentTokens(doc.text);
    const score = jaccard(tokens, other);
    if (score >= DUPLICATE_JACCARD && score > bestScore) {
      best = doc;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Find existing documents that may contradict a new fact.
 *
 * A near-duplicate (≥ {@link DUPLICATE_JACCARD}) is the same fact and merges
 * silently; a *related* document (≥ {@link CONFLICT_FLOOR}) that is worded
 * differently is reported instead, so the caller can ask the user before
 * overwriting what is already believed.
 *
 * @param {string} text - the fact about to be stored.
 * @param {Array<{doc_id: string, text: string, category?: string, tokens?: Set<string>}>} docs
 * @returns {Array<{doc_id: string, text: string, category: string, similarity: number}>}
 */
export function findConflicts(text, docs) {
  const key = knowledgeKey(text);
  const normalized = normalizeText(text);
  const tokens = contentTokens(text);
  const conflicts = [];
  for (const doc of docs ?? []) {
    if (!doc || typeof doc.text !== 'string') continue;
    // Incidents are dated evidence, not claims about the project: a new
    // incident never needs confirmation and never conflicts with old facts.
    if (doc.category === 'incidents') continue;
    if (doc.doc_id === key || normalizeText(doc.text) === normalized) continue;
    const other = doc.tokens ?? contentTokens(doc.text);
    const score = jaccard(tokens, other);
    if (score < CONFLICT_FLOOR || score >= DUPLICATE_JACCARD) continue;
    conflicts.push({
      doc_id: doc.doc_id,
      text: doc.text,
      category: typeof doc.category === 'string' ? doc.category : '',
      similarity: Number(score.toFixed(3)),
    });
  }
  return conflicts
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, 3);
}

/** First `http(s)` URL inside a text, if any. */
function urlOf(text) {
  const match = String(text ?? '').match(/https?:\/\/[^\s"'<>）)】]+/);
  return match ? match[0] : '';
}

/**
 * Turn one process record (staging or archive entry) into knowledge candidates.
 *
 * Structured kinds (error, decision, state, screenshot) each carry one fact and
 * become one document. Free-form kinds are only mined sentence by sentence, and
 * only for sentences that state a rule — a process log is not knowledge.
 *
 * @param {{dedup_id?: string, content?: string, kind?: string, source?: string,
 *   verify?: string, timestamp?: string}} record
 * @param {'staging'|'archive'} origin
 * @returns {Array<object>} zero or more candidates
 */
export function candidatesFromRecord(record, origin = 'staging') {
  const content = stripInjectedText(normalizeText(record?.content));
  if (content.length < MIN_FACT_CHARS) return [];
  const kind = String(record?.kind ?? 'unknown');
  // A rolling digest is a summary of the last N turns, not a fact of its own.
  if (kind === 'digest') return [];
  const ref = `${origin}:${String(record?.dedup_id ?? '')}`;
  const url = urlOf(content);

  const structured = {
    error: 'errors_fixes',
    decision: 'decisions_reasoning',
    reasoning: 'decisions_reasoning',
    state: 'project_facts',
    screenshot: 'ui_facts',
  }[kind];

  if (structured) {
    // One statement per record; a longer body is a log dump, not a fact.
    if (content.length > MAX_FACT_CHARS) return [];
    return [{
      text: content,
      category: structured,
      source: origin,
      source_ref: ref,
      url,
      tags: [kind],
      confidence: kind === 'error' ? 0.7 : 0.6,
    }];
  }

  const out = [];
  const seen = new Set();
  for (const sentence of splitSentences(content)) {
    if (!isDurableRule(sentence)) continue;
    const key = knowledgeKey(sentence);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      text: sentence,
      category: 'workflow_rules',
      source: origin,
      source_ref: `${ref}#${out.length}`,
      url: '',
      tags: [kind, 'user-rule'],
      confidence: 0.6,
    });
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * Mine one archived conversation turn for user-stated rules.
 *
 * Only the user's own words are mined: the assistant's prose is the model
 * talking, and treating it as a fact would let a guess become knowledge.
 *
 * @param {{turn?: number, user?: string}} turn
 * @param {string} contextId
 * @returns {Array<object>}
 */
export function candidatesFromTurn(turn, contextId) {
  const user = stripInjectedText(turn?.user);
  if (user === '') return [];
  const out = [];
  const seen = new Set();
  for (const sentence of splitSentences(user)) {
    if (!isDurableRule(sentence)) continue;
    const key = knowledgeKey(sentence);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      text: sentence,
      category: 'workflow_rules',
      source: 'context',
      source_ref: `context:${contextId}#turn${turn?.turn ?? '?'}`,
      url: '',
      tags: ['user-rule'],
      confidence: 0.75,
    });
  }
  return out;
}

/**
 * Turn one decision review into a knowledge candidate: the decision plus the
 * reason it was made, which is the part worth remembering.
 *
 * @param {{decision_id?: string, decision?: string, reason?: string,
 *   risk_level?: string, timestamp?: string}} record
 * @returns {Array<object>}
 */
export function candidatesFromDecision(record) {
  const decision = normalizeText(record?.decision);
  if (decision.length < MIN_FACT_CHARS) return [];
  const reason = normalizeText(record?.reason);
  const text = reason === '' ? decision : `决策：${decision}｜理由：${reason}`;
  return [{
    text: text.length > MAX_FACT_CHARS ? text.slice(0, MAX_FACT_CHARS) : text,
    category: 'decisions_reasoning',
    source: 'decision',
    source_ref: `decision:${String(record?.decision_id ?? '')}`,
    url: '',
    tags: ['decision', String(record?.risk_level ?? 'low')],
    confidence: 0.65,
  }];
}

/**
 * Normalize an authored knowledge input into the stored document shape.
 *
 * @param {{text: unknown, category?: unknown, source?: unknown, tags?: unknown,
 *   url?: unknown, confidence?: unknown, doc_id?: unknown, evidence?: unknown}} input
 * @returns {object} the document, without timestamps
 */
export function normalizeKnowledge(input) {
  const text = normalizeText(input?.text);
  if (text === '') throw new Error('text 必须为非空字符串');
  if (text.length > MAX_FACT_CHARS * 5) throw new Error(`text 过长（上限 ${MAX_FACT_CHARS * 5} 字符）`);

  const tags = Array.isArray(input?.tags)
    ? [...new Set(input.tags.map((tag) => normalizeText(tag)).filter((tag) => tag !== ''))].slice(0, 8)
    : [];
  const url = urlOf(input?.url) || urlOf(text);
  const source = normalizeSource(input?.source);
  const category = normalizeCategory(input?.category, url !== '' ? 'external_sources' : 'project_facts');
  const confidenceRaw = Number(input?.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.min(1, Math.max(0, confidenceRaw))
    : 0.8;
  const evidence = Array.isArray(input?.evidence)
    ? input.evidence
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        kind: normalizeText(item.kind) || 'authored',
        ref: normalizeText(item.ref),
        at: normalizeText(item.at) || new Date().toISOString(),
      }))
      .slice(0, 20)
    : [];
  // A document without provenance is untraceable; authored facts keep at least
  // the producer that wrote them.
  if (evidence.length === 0) evidence.push({ kind: 'authored', ref: source, at: new Date().toISOString() });
  const docId = normalizeText(input?.doc_id) || knowledgeKey(text);

  return {
    doc_id: docId,
    text,
    category,
    tags,
    source,
    url,
    confidence,
    evidence,
  };
}
