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

import { SCHEMA_VERSION, hash8 } from './util.js';
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
  'user', 'user-confirmed', 'web', 'reasoning', 'staging', 'archive', 'context', 'decision', 'incident', 'unknown',
]);

/**
 * Whether a document is a user fact, a model claim, or explicitly authored.
 *
 * `model` means the text came out of the model's own process log or decision
 * review. It is not a project fact until the user confirms it, so retrieval
 * treats it as a low-confidence claim instead of injecting it as knowledge.
 */
export const KNOWLEDGE_PROVENANCE = Object.freeze(['authored', 'user', 'model']);

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

/** Structured records (especially error logs) may legitimately be longer. */
const MAX_RECORD_CHARS = 1200;

/** Shorter than this is a fragment ("好的", "继续"), not a fact. */
const MIN_FACT_CHARS = 8;

/** Clip an over-long fact without silently losing the fact that it was cut. */
function clipFact(text, maxChars = MAX_FACT_CHARS) {
  const marker = `…（已截断，原 ${text.length} 字符）`;
  const room = Math.max(0, maxChars - marker.length);
  return `${text.slice(0, room).trimEnd()}${marker}`;
}

/** Near-duplicate threshold over content tokens. */
const DUPLICATE_JACCARD = 0.85;

/**
 * A near-duplicate whose value-bearing part changed is an **update**, not a
 * restatement. Numbers cover ports, thresholds, versions, dates and counts —
 * the common "one character changed" case that plain Jaccard would otherwise
 * merge silently.
 */
const NUMBER_RE = /\d+(?:[.,]\d+)*/g;
const URL_RE = /https?:\/\/[^\s"'<>）)】]+/g;

/** Opposite pairs that change the meaning even when almost every token matches. */
const POLARITY_PAIRS = Object.freeze([
  ['开启', '关闭'],
  ['打开', '关闭'],
  ['打开', '关掉'],
  ['启用', '禁用'],
  ['允许', '禁止'],
  ['必须', '不必'],
  ['保留', '删除'],
  ['内网', '公网'],
  ['true', 'false'],
  ['on', 'off'],
]);

/**
 * Finite phrase pairs for the weak 是/否 family. Bare 是/否 are morphemes in
 * Chinese (就是、只是、总是、是否、算是), so `includes('是')` invents polarity
 * changes. Only these complete phrases are safe to compare as opposites.
 */
const POLARITY_PATTERNS = Object.freeze([
  { left: /是正确的/, right: /是错误的/ },
  { left: /是对的/, right: /是错的/ },
]);

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
 * Normalize provenance, inferring it from a legacy `source` when absent.
 *
 * `source=staging|archive|reasoning|incident` is the model's own process log
 * or prose, and `source=decision` is its review output; all are claims. Only a
 * context turn carries the user's own words. An absent or misspelled source is
 * `unknown` (see {@link normalizeSource}) and must be the least trusted bucket:
 * the only caller of the write tool is the model, so defaulting it to
 * `authored`/verified would let a missing argument launder a claim into a fact.
 * Existing knowledge files had no `provenance` field, so this inference also
 * retroactively labels old promoted documents.
 *
 * @param {unknown} raw
 * @param {unknown} source
 * @returns {'authored'|'user'|'model'}
 */
export function normalizeProvenance(raw, source = '') {
  const value = normalizeText(raw).toLowerCase();
  const from = normalizeSource(source);
  // An explicit "authored" cannot establish trust when the source is missing
  // or misspelled: old documents wrote that pair for a bare `remember()` call.
  if (value === 'authored' && from === 'unknown') return 'model';
  if (KNOWLEDGE_PROVENANCE.includes(value)) return value;
  if (from === 'context' || from === 'user-confirmed') return 'user';
  if (from === 'staging' || from === 'archive' || from === 'decision'
    || from === 'reasoning' || from === 'incident' || from === 'model'
    || from === 'unknown') return 'model';
  return 'authored';
}

/**
 * Remove harness-injected envelope text from a conversation excerpt.
 *
 * User messages in a context archive can carry runtime reminder blocks. Their
 * structure is stable; the prose prefixes of individual harness lines are not,
 * so those are opt-in via `prefixes` instead of hard-coded guesses. Default is
 * intentionally conservative: missing a noisy line is preferable to deleting
 * something the user actually said.
 *
 * @param {string} text
 * @param {{prefixes?: string[]}} [options]
 * @returns {string}
 */
export function stripInjectedText(text, options = {}) {
  const prefixes = Array.isArray(options?.prefixes)
    ? options.prefixes
      .filter((prefix) => typeof prefix === 'string' && prefix.trim() !== '')
      .map((prefix) => prefix.trim())
    : [];
  return String(text ?? '')
    .replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder\s*>/gi, ' ')
    .split('\n')
    .filter((line) => !prefixes.some((prefix) => line.trimStart().startsWith(prefix)))
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
  return splitSentenceDetails(text).map((detail) => detail.text);
}

/** Extract a short subject from the first clause of a split paragraph. */
function subjectPrefixOf(clause) {
  const value = String(clause ?? '').trim();
  if (value === '') return '';
  // Cut before the predicate when it is recognizable: "这个网关的超时默认是"
  // becomes "这个网关的超时", which is useful as a prefix for later clauses.
  const predicate = /(默认|通常|一般|目前|现在|已经|必须|需要|应该|是|为|有|支持|使用|允许|禁止)/;
  const match = predicate.exec(value);
  if (match !== null && match.index >= 2) {
    return value.slice(0, match.index).trim().replace(/[，,、：:]+$/, '');
  }
  return '';
}

/**
 * Whether a clause already has a subject-like phrase before its predicate.
 *
 * The old code prefixed every later clause with the first clause's subject,
 * which invented associations like "网关超时，重试次数必须为 3". A clause that
 * names a noun before its predicate ("重试次数必须为 3", "日志格式统一为 JSON")
 * must keep its own subject; only a predicate-first clause may inherit one.
 */
function hasSubjectBeforePredicate(clause) {
  const value = String(clause ?? '').trim();
  if (value === '') return false;
  const predicate = /(默认|通常|一般|目前|现在|已经|必须|需要|应该|是|为|有|支持|使用|允许|禁止|统一|保留|清理|开启|关闭)/;
  const match = predicate.exec(value);
  return match !== null && match.index >= 2;
}

/**
 * Split with metadata: `clause: true` marks a fragment produced by breaking a
 * >MAX_FACT_CHARS paragraph on commas. Callers tag and down-rank those so a
 * subjectless "必须改成 120 秒" cannot look like a standalone project rule.
 *
 * @param {string} text
 * @returns {Array<{text: string, clause: boolean, truncated?: boolean}>}
 */
export function splitSentenceDetails(text) {
  // Newlines are kept as separators: one line of prose is usually one fact.
  const value = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (value === '') return [];
  const parts = value
    .split(/[。！？!?；;\n]+/)
    .map((part) => part.replace(/^[\s\-*•·\d.、)）]+/, '').trim());
  // A very long sentence is a paragraph: break it on clauses so one clause can
  // still become a fact. The first fragment is used to restore a subject for
  // the immediately following clause only; later clauses keep their own text.
  const out = [];
  for (const part of parts) {
    if (part.length <= MAX_FACT_CHARS) {
      if (part.length >= MIN_FACT_CHARS) out.push({ text: part, clause: false });
      continue;
    }
    const clauses = part.split(/[，,、]+/).map((clause) => clause.trim()).filter(Boolean);
    const first = clauses[0] ?? '';
    const subject = subjectPrefixOf(first);
    for (let index = 0; index < clauses.length; index += 1) {
      const original = clauses[index];
      let text = original;
      let truncated = false;
      // Judge the atomic clause first. If adding the prefix would push a
      // 395-character clause over 400, keep the clause rather than silently
      // dropping the whole fact.
      if (original.length > MAX_FACT_CHARS) {
        text = clipFact(original);
        truncated = true;
      } else if (index === 1 && subject !== ''
        && !original.startsWith(subject)
        && !hasSubjectBeforePredicate(original)) {
        const prefixed = `${subject}，${original}`;
        if (prefixed.length <= MAX_FACT_CHARS) text = prefixed;
      }
      if (text.length >= MIN_FACT_CHARS && text.length <= MAX_FACT_CHARS) {
        out.push({ text, clause: true, ...(truncated ? { truncated: true } : {}) });
      }
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
 * Extract the values that make two otherwise-identical sentences different.
 *
 * A single changed number is not a paraphrase. The tokens around it usually
 * still overlap by more than 0.85, so the plain duplicate check would merge the
 * fact without asking and lose the fact that its value changed. Numbers cover
 * ports, thresholds, versions, dates and counts; URLs are compared the same way
 * so a changed endpoint is not silently folded.
 *
 * @param {string} previousText
 * @param {string} nextText
 * @returns {{kind: 'number'|'url'|'polarity', before: string[], after: string[]}|null}
 */
export function materialChange(previousText, nextText) {
  const beforeText = normalizeText(previousText);
  const afterText = normalizeText(nextText);
  if (beforeText === '' || afterText === '' || beforeText === afterText) return null;

  const numbersOf = (text) => (text.match(NUMBER_RE) ?? []).slice().sort();
  const beforeNumbers = numbersOf(beforeText);
  const afterNumbers = numbersOf(afterText);
  if (beforeNumbers.join('\u0001') !== afterNumbers.join('\u0001')) {
    return { kind: 'number', before: beforeNumbers, after: afterNumbers };
  }

  const urlsOf = (text) => (text.match(URL_RE) ?? []).slice().sort();
  const beforeUrls = urlsOf(beforeText);
  const afterUrls = urlsOf(afterText);
  if (beforeUrls.join('\u0001') !== afterUrls.join('\u0001')) {
    return { kind: 'url', before: beforeUrls, after: afterUrls };
  }

  // Opposite words are a meaning change even when the sentence skeleton is
  // identical ("默认开启" → "默认关闭"). Only count a clean one-sided flip, so
  // a sentence that discusses both sides is not forced through the gate.
  for (const [left, right] of POLARITY_PAIRS) {
    const has = (text, word) => (/^[a-z]+$/i.test(word)
      ? new RegExp(`\\b${word}\\b`, 'i').test(text)
      : text.includes(word));
    if (has(beforeText, left) && !has(beforeText, right)
      && has(afterText, right) && !has(afterText, left)) {
      return { kind: 'polarity', before: [left], after: [right] };
    }
    if (has(beforeText, right) && !has(beforeText, left)
      && has(afterText, left) && !has(afterText, right)) {
      return { kind: 'polarity', before: [right], after: [left] };
    }
  }
  for (const { left, right } of POLARITY_PATTERNS) {
    const has = (text, pattern) => pattern.test(text);
    if (has(beforeText, left) && !has(beforeText, right)
      && has(afterText, right) && !has(afterText, left)) {
      return { kind: 'polarity', before: [left.source], after: [right.source] };
    }
    if (has(beforeText, right) && !has(beforeText, left)
      && has(afterText, left) && !has(afterText, right)) {
      return { kind: 'polarity', before: [right.source], after: [left.source] };
    }
  }
  return null;
}

/**
 * Find an existing document that already states this fact.
 *
 * Exact-key matches catch rephrasing-free repeats; the token comparison catches
 * the same fact written in a slightly different order or with a new prefix.
 *
 * @param {string} text
 * @param {Array<{doc_id: string, text: string, tokens?: Set<string>}>} docs
 * @param {{tokens?: Set<string>}} [options] - reuse a pre-tokenized candidate.
 * @returns {{doc: object, score: number}|null}
 */
export function findDuplicateMatch(text, docs, options = {}) {
  const key = knowledgeKey(text);
  // Callers that already tokenized the candidate (RRF duplicate folding) can
  // pass that Set instead of re-tokenizing the same sentence for every kept row.
  const tokens = options.tokens instanceof Set ? options.tokens : contentTokens(text);
  let best = null;
  let bestScore = 0;
  for (const doc of docs ?? []) {
    if (doc.doc_id === key) return { doc, score: 1 };
    const other = doc.tokens ?? contentTokens(doc.text);
    const score = jaccard(tokens, other);
    if (score >= DUPLICATE_JACCARD && score > bestScore) {
      best = doc;
      bestScore = score;
    }
  }
  return best ? { doc: best, score: bestScore } : null;
}

/**
 * Backwards-compatible wrapper returning only the duplicate document.
 *
 * @param {string} text
 * @param {Array<{doc_id: string, text: string, tokens?: Set<string>}>} docs
 * @returns {{doc_id: string}|null}
 */
export function findDuplicate(text, docs, options = {}) {
  return findDuplicateMatch(text, docs, options)?.doc ?? null;
}

/**
 * Find existing documents that may contradict a new fact.
 *
 * A near-duplicate (≥ {@link DUPLICATE_JACCARD}) with the same values is the
 * same fact and merges silently; if its value-bearing part changed,
 * `store.remember` turns it into an explicit update before this function is
 * consulted. A *related* document (≥ {@link CONFLICT_FLOOR}) that is worded
 * differently is reported here so the caller can ask the user before
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
export function candidatesFromRecord(record, origin = 'staging', options = {}) {
  // Process records are written by the model, not by the user. Only a record
  // whose verification step actually passed may be mined; otherwise a model
  // could stage `kind=state`, promote it, and later retrieve its own guess as a
  // project fact. Even verified records stay labeled as model claims below.
  if (record?.verify !== 'pass') return [];
  const content = stripInjectedText(normalizeText(record?.content), options);
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
    // One statement per record. Long bodies (typically an error log) are kept
    // but clipped and marked, rather than silently dropped: the long log is
    // often the most useful record.
    const truncated = content.length > MAX_RECORD_CHARS;
    const text = truncated ? clipFact(content, MAX_RECORD_CHARS) : content;
    return [{
      text,
      category: structured,
      source: origin,
      source_ref: ref,
      url,
      tags: truncated ? [kind, 'truncated'] : [kind],
      confidence: truncated ? 0.35 : (kind === 'error' ? 0.55 : 0.4),
      provenance: 'model',
      verified: false,
    }];
  }

  const out = [];
  const seen = new Set();
  for (const detail of splitSentenceDetails(content)) {
    if (!isDurableRule(detail.text)) continue;
    const key = knowledgeKey(detail.text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      text: detail.text,
      category: 'workflow_rules',
      source: origin,
      source_ref: `${ref}#${out.length}`,
      url: '',
      tags: detail.clause
        ? [kind, 'user-rule', 'clause', ...(detail.truncated ? ['truncated'] : [])]
        : [kind, 'user-rule'],
      confidence: detail.clause ? 0.35 : 0.45,
      provenance: 'model',
      verified: false,
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
export function candidatesFromTurn(turn, contextId, options = {}) {
  const user = stripInjectedText(turn?.user, options);
  if (user === '') return [];
  const out = [];
  const seen = new Set();
  for (const detail of splitSentenceDetails(user)) {
    if (!isDurableRule(detail.text)) continue;
    const key = knowledgeKey(detail.text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      text: detail.text,
      category: 'workflow_rules',
      source: 'context',
      source_ref: `context:${contextId}#turn${turn?.turn ?? '?'}`,
      url: '',
      tags: detail.clause
        ? ['user-rule', 'clause', ...(detail.truncated ? ['truncated'] : [])]
        : ['user-rule'],
      confidence: detail.clause ? 0.6 : 0.75,
      provenance: 'user',
      verified: true,
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
  let text = reason === '' ? decision : `决策：${decision}｜理由：${reason}`;
  const truncated = text.length > MAX_FACT_CHARS;
  if (truncated) text = clipFact(text);
  return [{
    text,
    category: 'decisions_reasoning',
    source: 'decision',
    source_ref: `decision:${String(record?.decision_id ?? '')}`,
    url: '',
    tags: truncated ? ['decision', String(record?.risk_level ?? 'low'), 'truncated'] : ['decision', String(record?.risk_level ?? 'low')],
    confidence: 0.4,
    provenance: 'model',
    verified: false,
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
  const provenance = normalizeProvenance(input?.provenance, source);
  // A missing/misspelled source is untraceable, even if a caller also sent
  // `verified: true` or an old `authored` record says otherwise.
  const verified = (source === 'unknown' && provenance === 'model')
    ? false
    : (typeof input?.verified === 'boolean' ? input.verified : provenance !== 'model');
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
  // Importing an exported knowledge document may carry its change audit. Normal
  // writes do not pass this field; preserving it here makes export → re-import
  // lossless without exposing it to the model-facing remember tool.
  const changes = Array.isArray(input?.changes)
    ? input.changes
      .filter((item) => item && typeof item === 'object')
      .slice(-5)
    : [];
  // A document without provenance is untraceable; authored facts keep at least
  // the producer that wrote them. Do not invent an `authored:unknown` row: a
  // blank source would look like evidence while establishing nothing.
  if (evidence.length === 0 && source !== 'unknown') {
    evidence.push({ kind: 'authored', ref: source, at: new Date().toISOString() });
  }
  const docId = normalizeText(input?.doc_id) || knowledgeKey(text);

  const result = {
    doc_id: docId,
    schema_version: Number.isInteger(input?.schema_version) ? input.schema_version : SCHEMA_VERSION,
    text,
    category,
    tags,
    source,
    url,
    confidence,
    provenance,
    verified,
    evidence,
  };
  // Keep the historical shape when there is no audit yet; an export/import
  // round-trip that carries changes still preserves them.
  if (changes.length > 0) result.changes = changes;
  return result;
}
