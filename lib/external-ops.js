/**
 * External-model variants of the three deterministic pipelines.
 *
 * The external models here are **embedding and rerank models**, not chat models:
 *
 * - **归档**: each process record is embedded and matched against the fixed set of
 *   archive categories; the top-3 candidates are then scored by the reranker
 *   (cross-encoder) when one is configured, which fixes the "same topic, different
 *   wording" mistakes a pure encoder makes;
 * - **知识**: the source text is split into sentences, embedded, and the most
 *   *central* ones (highest mean similarity to the rest of the text) become facts;
 *   near-duplicates are dropped, and each fact is assigned the nearest knowledge
 *   category by the same embeddings. This is extractive, so it never invents text;
 * - **上下文**: the same extractive pass over the turns that are about to leave
 *   the window produces the replacement note, so a cleared range keeps a summary
 *   instead of only a count.
 *
 * Everything is optional and bounded: no reranker → embeddings only; no embeddings
 * → `{ ok: false }` and the caller falls back to the deterministic local rules.
 * Chat completions are not required for any of these.
 */
import { CATEGORIES } from './util.js';
import { KNOWLEDGE_CATEGORIES } from './knowledge.js';
import { embed, rerank } from './external.js';

export const EXTERNAL_OP_LIMITS = Object.freeze({
  maxInputChars: 12000,
  maxFacts: 10,
  maxFactChars: 200,
  summaryChars: 400,
  summarySentences: 4,
  /** Below this cosine the record does not clearly belong to any category. */
  minCategoryScore: 0.12,
  /** This close to an already picked sentence means "same fact, skip it". */
  nearDuplicate: 0.92,
  maxRerankCandidates: 3,
  maxClassifyChars: 2000,
});

/**
 * One short description per archive category. The descriptions are embedded once
 * per endpoint and reused, which keeps classification to a single request.
 */
export const CATEGORY_PROTOTYPES = Object.freeze({
  ui_facts: '界面事实：面板、按钮、输入框、截图、布局、颜色',
  action_logs: '执行过的动作：命令、脚本、运行日志、操作记录',
  decisions_reasoning: '决策与原因：决定、取舍、权衡、为什么这样做',
  ui_maps: '界面结构：页面层级、导航、菜单、区域划分',
  errors_fixes: '错误与修复：报错、异常、失败、修法、踩坑',
  behavior_tristate: '行为开关：模式、三态、开关、启用禁用',
  snapshots: '快照与状态：存档、还原点、精确状态',
});

/** One short description per knowledge category. */
export const KNOWLEDGE_PROTOTYPES = Object.freeze({
  project_facts: '项目事实：这个项目是什么、约定、目录、架构',
  ui_facts: '界面事实：面板、按钮、布局、显示',
  errors_fixes: '错误修复：报错、原因、怎么修',
  decisions_reasoning: '决策理由：为什么这样设计、取舍',
  tools_apis: '工具与接口：命令、API、依赖、脚本',
  workflow_rules: '工作规则：以后要遵守的做法、必须、不要',
  external_sources: '外部资料：网页、文档、来源链接',
  open_questions: '开放问题：待确认、疑问、未定',
});

/** Words that make a sentence more "rule-like" and therefore worth keeping. */
const RULE_HINTS = ['必须', '不要', '以后', '记住', '改成', '决定', '因为', '结论', '规则', '约定', '原因'];

/** Cosine similarity; returns 0 for mismatched or empty vectors. */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const x = Number(a[index]);
    const y = Number(b[index]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Split text into sentences without pulling in a tokenizer library. */
export function splitSentences(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split(/(?<=[。！？；.!?;])\s*|\n+/u)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length >= 6);
}

/** @param {string} text @param {number} [max] */
function clipText(text, max = EXTERNAL_OP_LIMITS.maxInputChars) {
  const value = String(text ?? '').trim();
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Pick the archive category for one record.
 *
 * Embedding nearest-prototype first, then (when available) rerank the top few
 * candidates against the record text. Returns `{ ok, category, score, via }` or
 * `{ ok: false, error }`; the caller then keeps the local kind→category mapping.
 */
export async function classifyRecord(endpoint, record, fetchImpl = globalThis.fetch) {
  const text = clipText(record?.content, EXTERNAL_OP_LIMITS.maxClassifyChars);
  if (text === '') return { ok: false, error: '记录内容为空，保留本地分类。' };

  const names = Object.keys(CATEGORY_PROTOTYPES);
  // One request: the record plus every prototype.
  const result = await embed(endpoint, [text, ...names.map((name) => CATEGORY_PROTOTYPES[name])], fetchImpl);
  if (!result.ok) return { ok: false, error: result.error };
  const [recordVector, ...categoryVectors] = result.vectors;
  const scored = names.map((name, index) => ({
    category: name,
    score: cosine(recordVector, categoryVectors[index]),
  })).sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < EXTERNAL_OP_LIMITS.minCategoryScore) {
    return {
      ok: false,
      error: `没有明显匹配的分类（最高分 ${(best?.score ?? 0).toFixed(3)}），保留本地分类。`,
    };
  }

  const candidates = scored.slice(0, EXTERNAL_OP_LIMITS.maxRerankCandidates);
  const reranked = await rerank(endpoint, {
    query: text,
    documents: candidates.map((candidate) => CATEGORY_PROTOTYPES[candidate.category]),
    topN: candidates.length,
  }, fetchImpl);
  if (reranked.ok) {
    const winner = reranked.results[0];
    const category = candidates[winner.index]?.category;
    if (category !== undefined) {
      return { ok: true, category, score: winner.score, via: 'rerank' };
    }
  }
  return { ok: true, category: best.category, score: best.score, via: 'embedding' };
}

function centralityScore(vectors, index) {
  let total = 0;
  let count = 0;
  for (let other = 0; other < vectors.length; other += 1) {
    if (other === index) continue;
    total += cosine(vectors[index], vectors[other]);
    count += 1;
  }
  return count === 0 ? 0 : total / count;
}

function nearDuplicateOf(chosen, vector) {
  for (const item of chosen) {
    if (cosine(item.vector, vector) >= EXTERNAL_OP_LIMITS.nearDuplicate) return true;
  }
  return false;
}

/**
 * Extractive fact mining: the most central sentences of the source text, each
 * tagged with the nearest knowledge category.
 */
export async function extractFacts(endpoint, text, fetchImpl = globalThis.fetch) {
  const source = clipText(text);
  if (source === '') return { ok: false, error: '没有可提炼的文本。' };
  const sentences = splitSentences(source)
    .filter((sentence) => sentence.length >= 8)
    .slice(0, 120);
  if (sentences.length === 0) return { ok: false, error: '这段文本里没有可用的句子。' };

  const names = Object.keys(KNOWLEDGE_PROTOTYPES);
  const result = await embed(endpoint, sentences, fetchImpl);
  if (!result.ok) return { ok: false, error: result.error };
  const vectors = result.vectors;

  const scored = sentences.map((sentence, index) => {
    const hint = RULE_HINTS.some((word) => sentence.includes(word)) ? 0.08 : 0;
    return {
      text: sentence.length > EXTERNAL_OP_LIMITS.maxFactChars
        ? sentence.slice(0, EXTERNAL_OP_LIMITS.maxFactChars)
        : sentence,
      index,
      vector: vectors[index],
      score: centralityScore(vectors, index) + hint,
    };
  }).sort((a, b) => b.score - a.score);

  const categoryResult = await embed(endpoint, names.map((name) => KNOWLEDGE_PROTOTYPES[name]), fetchImpl);
  if (!categoryResult.ok) return { ok: false, error: categoryResult.error };
  const categoryVectors = new Map(names.map((name, index) => [name, categoryResult.vectors[index]]));

  const chosen = [];
  const seen = new Set();
  for (const candidate of scored) {
    if (chosen.length >= EXTERNAL_OP_LIMITS.maxFacts) break;
    const key = candidate.text.replace(/\s+/g, '');
    if (seen.has(key)) continue;
    if (nearDuplicateOf(chosen, candidate.vector)) continue;
    let bestName = names[0];
    let bestScore = -1;
    for (const name of names) {
      const score = cosine(candidate.vector, categoryVectors.get(name));
      if (score > bestScore) {
        bestScore = score;
        bestName = name;
      }
    }
    seen.add(key);
    chosen.push({ ...candidate, category: bestName, categoryScore: bestScore });
  }

  if (chosen.length === 0) return { ok: false, error: '没有选出可用的知识句子。' };
  return {
    ok: true,
    items: chosen.map((item) => ({
      text: item.text,
      category: item.category,
      score: Number(item.score.toFixed(4)),
      category_score: Number(item.categoryScore.toFixed(4)),
    })),
  };
}

/**
 * Extractive summary of the turns that are leaving the context window: the most
 * central sentences, in their original order.
 */
export async function summarizeTurns(endpoint, turns, fetchImpl = globalThis.fetch) {
  const rows = Array.isArray(turns) ? turns.slice(0, 12) : [];
  const sentences = [];
  for (const turn of rows) {
    const text = `${String(turn.user ?? '')}\n${String(turn.assistant ?? '')}`;
    for (const sentence of splitSentences(text)) {
      if (sentence.length < 8) continue;
      sentences.push({ text: sentence, turn: Number(turn.turn) || 0 });
    }
  }
  const pool = sentences.slice(0, 160);
  if (pool.length === 0) return { ok: false, error: '没有可总结的轮次。' };

  const result = await embed(endpoint, pool.map((item) => item.text), fetchImpl);
  if (!result.ok) return { ok: false, error: result.error };
  const vectors = result.vectors;

  const top = pool.map((item, index) => ({
    ...item,
    index,
    vector: vectors[index],
    score: centralityScore(vectors, index) + (RULE_HINTS.some((word) => item.text.includes(word)) ? 0.06 : 0),
  })).sort((a, b) => b.score - a.score)
    .slice(0, EXTERNAL_OP_LIMITS.summarySentences)
    .sort((a, b) => a.index - b.index);

  let summary = top.map((item) => item.text.replace(/[。；;]\s*$/u, '')).join('；');
  if (summary.length > EXTERNAL_OP_LIMITS.summaryChars) {
    summary = `${summary.slice(0, EXTERNAL_OP_LIMITS.summaryChars)}…`;
  }
  return { ok: true, summary, topics: [] };
}

/* ------------------------------------------------------------------ *
 * JSON helpers
 *
 * The three pipelines above do not need a chat model, but `aim_ask` can still
 * drive one, and a chat reply is prose with JSON somewhere inside. These
 * helpers recover that JSON defensively; they are exported for tests.
 * ------------------------------------------------------------------ */

/** Recover one JSON value from a model reply (tolerates fences and prose). */
export function extractJsonValue(reply) {
  const text = String(reply ?? '').trim();
  if (text === '') return null;
  const fenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  for (const candidate of [text, fenced]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // fall through to bracket scanning
    }
    const start = candidate.search(/[[{]/);
    if (start === -1) continue;
    const open = candidate[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < candidate.length; index += 1) {
      const char = candidate[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === open) depth += 1;
      else if (char === close) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(start, index + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

/** Snap a model-produced category onto the fixed set, or `null`. */
export function coerceCategory(raw, allowed) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (value === '') return null;
  for (const category of allowed) {
    if (value === category) return category;
  }
  return null;
}

/** Parse one classification reply into a category from `CATEGORIES`. */
export function parseCategoryReply(reply, allowed = CATEGORIES) {
  const value = extractJsonValue(reply);
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const category = coerceCategory(value.category ?? value.store ?? value.layer, allowed);
    if (category !== null) return category;
  }
  if (typeof value === 'string') return coerceCategory(value, allowed);
  const bare = String(reply ?? '').trim();
  return bare.length <= 40 ? coerceCategory(bare, allowed) : null;
}

/** Parse a fact-extraction reply into `{text, category}` rows. */
export function parseKnowledgeReply(reply, allowed = KNOWLEDGE_CATEGORIES) {
  const value = extractJsonValue(reply);
  const rows = Array.isArray(value)
    ? value
    : Array.isArray(value?.items) ? value.items
      : Array.isArray(value?.facts) ? value.facts
        : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const text = typeof row === 'string'
      ? row
      : (typeof row?.text === 'string' ? row.text : '');
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length < 6) continue;
    const clipped = clean.length > EXTERNAL_OP_LIMITS.maxFactChars
      ? clean.slice(0, EXTERNAL_OP_LIMITS.maxFactChars)
      : clean;
    if (seen.has(clipped)) continue;
    seen.add(clipped);
    out.push({
      text: clipped,
      category: coerceCategory(row?.category, allowed) ?? allowed[0],
    });
    if (out.length >= EXTERNAL_OP_LIMITS.maxFacts) break;
  }
  return out;
}

/** Parse a summarise reply into `{summary, topics}`. */
export function parseSummaryReply(reply) {
  const value = extractJsonValue(reply);
  let summary = '';
  let topics = [];
  if (typeof value === 'string') summary = value;
  else if (value && typeof value === 'object') {
    if (typeof value.summary === 'string') summary = value.summary;
    else if (typeof value.text === 'string') summary = value.text;
    if (Array.isArray(value.topics)) {
      topics = value.topics.map((item) => String(item ?? '').trim()).filter(Boolean);
    }
  }
  summary = summary.replace(/\s+/g, ' ').trim();
  if (summary === '' && value === null) {
    const plain = String(reply ?? '').replace(/\s+/g, ' ').trim();
    if (plain.length >= 4) summary = plain;
  }
  if (summary === '') return null;
  if (summary.length > EXTERNAL_OP_LIMITS.summaryChars) {
    summary = `${summary.slice(0, EXTERNAL_OP_LIMITS.summaryChars)}…`;
  }
  return { summary, topics: topics.slice(0, 6) };
}
