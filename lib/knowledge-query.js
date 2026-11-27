// @ts-check
/**
 * Query routing over the knowledge base (JSON → SQL / RAG).
 *
 * The knowledge base has three views of one corpus:
 * - **JSON** files are the base material; every fact is written there first.
 * - **RAG** is a derived vector index (`lib/rag.js`) for fuzzy, open questions.
 * - **SQL** is a derived, queryable view (`lib/knowledge-sqlite.js`) for metrics,
 *   aggregation, exact ids and counts.
 *
 * This module adds the dispatch layer between them. A question is classified by
 * deterministic rules (no generative call, so it works offline and cannot invent
 * SQL), and metric/aggregation questions are translated into a small set of
 * read-only SQL queries. Translation never mutates data: raw SQL is accepted
 * only when it is a single `SELECT`/`WITH` statement.
 *
 * `runSqlRoute` builds an in-memory SQLite database from the JSON documents of
 * the requested range on every call. That keeps JSON the single source of truth
 * while still giving the routing layer real SQL semantics (GROUP BY, ORDER BY,
 * COUNT, LIKE). If `node:sqlite` is unavailable, the caller falls back to RAG or
 * local BM25.
 */

import { randomBytes } from 'node:crypto';
import { KNOWLEDGE_CATEGORIES } from './knowledge.js';

const SQL_MAX_ROWS = 50;
// A raw SELECT can return blobs/strings far larger than a normal document. The
// row count alone does not bound memory: 50 rows of 32 MiB is 1.6 GiB, and the
// SQLite driver materializes each row before we can inspect it.
const SQL_MAX_ROW_BYTES = 2 * 1024 * 1024;
const SQL_MAX_RESULT_BYTES = 16 * 1024 * 1024;
// Functions that can return a value larger than their inputs, or aggregate an
// unbounded number of rows. `substr` is deliberately not here: it only slices
// its input, so its output cannot exceed a value that is already bounded.
const FORBIDDEN_SQL_FUNCTIONS = new Set([
  'printf',
  'format',
  'hex',
  'quote',
  'json_quote',
  'replace',
  'concat',
  'concat_ws',
  'group_concat',
  'string_agg',
  'json_group_array',
  'json_group_object',
  'jsonb_group_array',
  'jsonb_group_object',
  // Extension loading and file I/O are off by default in node:sqlite, but a
  // future runtime flag (allowExtension / enableLoadExtension) would turn these
  // into arbitrary native code execution or file reads. They have no place in a
  // knowledge query, so deny them by name regardless of the runtime defaults.
  'load_extension',
  'readfile',
  'writefile',
  'edit',
  'fts3_tokenizer',
  'fts5_tokenizer',
]);

/** Chinese names users may type for the eight stored categories. */
const CATEGORY_ALIASES = Object.freeze({
  project_facts: ['项目事实', '项目'],
  ui_facts: ['界面事实', '界面', 'ui'],
  errors_fixes: ['错误修复', '错误', '报错'],
  decisions_reasoning: ['决策理由', '决策'],
  tools_apis: ['工具接口', '工具', 'api'],
  workflow_rules: ['工作流规则', '工作流', '规则'],
  external_sources: ['外部来源', '网页'],
  open_questions: ['未决问题', '问题'],
  incidents: ['事故', '事故记录'],
});

const METRIC_RE = /(多少|几条|几篇|几个|数量|总数|统计|分布|占比|排行|排名|平均|最高|最低|最多|最少|top\s*\d+|最近\s*(\d+|几|多少)?\s*(条|篇|个)?|按\s*(分类|来源|标签)|各\s*(分类|来源|标签)|每\s*(个)?\s*(分类|来源|标签))/i;
const OPEN_RE = /(怎么|如何|为什么|什么|哪些|介绍|解释|总结|整理|相关|有关|关于|类似|经验|方案|原因|区别|对比|建议|怎么用|怎么改|有没有)/;
const ID_RE = /\bk_[0-9a-z]{4,}\b/i;
const RAW_SQL_RE = /^\s*(select|with)\b/i;

/** Map a Chinese category mention to its stored id, or `null`. */
export function categoryOf(text) {
  const value = String(text ?? '');
  // The keyword channel stores knowledge categories, not archive categories:
  // `workflow_rules`/`tools_apis` are real ids here while `action_logs` is not.
  for (const category of KNOWLEDGE_CATEGORIES) {
    if (value.includes(category)) return category;
  }
  for (const [category, aliases] of Object.entries(CATEGORY_ALIASES)) {
    if (aliases.some((alias) => value.includes(alias))) return category;
  }
  return null;
}

/**
 * Classify one natural-language question.
 *
 * @returns {{ route: 'sql'|'vector'|'hybrid', intent: string, reason: string }}
 */
export function routeKnowledgeQuery(query) {
  const q = String(query ?? '').trim();
  if (q === '') return { route: 'vector', intent: 'empty', reason: '空问题' };
  if (RAW_SQL_RE.test(q)) return { route: 'sql', intent: 'raw-sql', reason: '显式 SQL' };
  if (ID_RE.test(q)) return { route: 'sql', intent: 'exact-id', reason: '精确 doc_id' };
  const metric = METRIC_RE.test(q);
  const open = OPEN_RE.test(q);
  // A metric word alone is not enough to promise SQL. If the deterministic
  // translator has no plan, route to the vector channel instead of answering a
  // fluent but unrelated aggregate ("哪个方案最多坑" -> workflow_rules=42).
  const planned = metric ? translateToSql(q) : null;
  if (metric && open) {
    if (!planned) return { route: 'vector', intent: 'metric-unplanned', reason: '有指标词，但没有稳定的 SQL 计划' };
    return { route: 'hybrid', intent: 'metric+open', reason: '指标 + 开放描述：SQL 出事实、向量补上下文' };
  }
  if (metric) {
    if (!planned) return { route: 'vector', intent: 'metric-unplanned', reason: '有指标词，但没有稳定的 SQL 计划' };
    return { route: 'sql', intent: 'metric', reason: '指标/聚合/精确统计' };
  }
  return { route: 'vector', intent: 'open', reason: '开放文档类问题' };
}

/** Translate one question into a read-only SQL plan, or `null` when unsure. */
export function translateToSql(query) {
  const q = String(query ?? '').trim();
  if (q === '') return null;

  if (RAW_SQL_RE.test(q)) {
    if (!isSafeSelect(q)) return null;
    const body = q.replace(/;\s*$/, '').trim();
    // Always wrap: the driver stops iterating after SQL_MAX_ROWS, but a raw
    // SELECT with no LIMIT can still make SQLite compute/sort the full result
    // before yielding the first row. The outer LIMIT is the explicit cap.
    return {
      sql: `SELECT * FROM (${body}) LIMIT ${SQL_MAX_ROWS}`,
      params: [],
      kind: 'raw',
      confidence: 1,
      explanation: '执行显式只读 SELECT（外层强制 LIMIT 50）',
    };
  }

  const idMatch = q.match(ID_RE);
  if (idMatch) {
    const value = idMatch[0].toLowerCase();
    return {
      sql: 'SELECT * FROM knowledge_docs WHERE lower(doc_id) LIKE ? LIMIT 5',
      params: [`${value}%`],
      kind: 'exact',
      confidence: 0.95,
      explanation: `按 doc_id 精确查找 ${value}`,
    };
  }

  if (/(未确认|模型自述|未核实|unverified)/i.test(q)) {
    const category = categoryOf(q);
    const where = `provenance = 'model' AND verified = 0${category ? ' AND category = ?' : ''}`;
    const wantsList = /(列出|哪些|哪几条|明细|清单)/.test(q);
    return wantsList
      ? {
        sql: `SELECT doc_id, category, provenance, verified, text FROM knowledge_docs WHERE ${where} ORDER BY updated_at DESC LIMIT 20`,
        params: category ? [category] : [],
        kind: 'unverified',
        confidence: 0.95,
        explanation: '列出未确认的模型自述',
      }
      : {
        sql: `SELECT COUNT(*) AS n FROM knowledge_docs WHERE ${where}`,
        params: category ? [category] : [],
        kind: 'unverified',
        confidence: 0.95,
        explanation: '统计未确认的模型自述',
      };
  }

  if (/(按|各|每(个)?)\s*(分类|来源)/.test(q) || /(分类|来源)\s*(分布|统计|数量|多少)/.test(q)) {
    const bySource = /来源/.test(q) && !/分类/.test(q);
    const column = bySource ? 'source' : 'category';
    return {
      sql: `SELECT ${column} AS label, COUNT(*) AS n FROM knowledge_docs GROUP BY ${column} ORDER BY n DESC`,
      params: [],
      kind: 'group',
      confidence: 0.92,
      explanation: `按${bySource ? '来源' : '分类'}分组统计`,
    };
  }

  if (/(分类|来源)/.test(q) && /(最多|最少)/.test(q)) {
    const desc = /最少/.test(q) ? 'ASC' : 'DESC';
    const column = /来源/.test(q) ? 'source' : 'category';
    return {
      sql: `SELECT ${column} AS label, COUNT(*) AS n FROM knowledge_docs GROUP BY ${column} ORDER BY n ${desc} LIMIT 1`,
      params: [],
      kind: 'top',
      confidence: 0.9,
      explanation: `找出数量${desc === 'DESC' ? '最多' : '最少'}的${column === 'source' ? '来源' : '分类'}`,
    };
  }

  const category = categoryOf(q);
  // Do not let the separator class consume Chinese: `[^\w]*` swallowed all but
  // the last character ("标签项目事实" -> "实"). Only punctuation/space separates
  // the label from the tag.
  const tagMatch = q.match(/标签\s*(?:为|是|：|:)?\s*([\w\-.\u4e00-\u9fff]+)/);
  // The tag itself has no delimiter from a following question phrase
  // ("项目事实有多少条"). Greedy capture would otherwise search for
  // `%项目事实有多少条%` and count zero. Strip only the known trailing question
  // forms, not arbitrary Chinese, so tags that merely end in "数量" survive.
  let tag = tagMatch?.[1] ?? '';
  if (tag !== '') {
    tag = tag
      .replace(/(?:有)?(?:多少|几)(?:条|篇|个)?$/, '')
      .replace(/的(?:数量|总数|统计|分布|排行|排名|知识|文档|条目|记录)$/, '');
  }
  const latest = q.match(/最近\s*(\d+|几|多少)?\s*(条|篇|个)?/);
  const wantsList = /(列出|显示|查看|最近|最新|哪些)/.test(q);
  const wantsCount = /(多少|几条|几篇|几个|数量|总数|总计)/.test(q);

  if (latest && wantsList && !wantsCount) {
    const count = Number.parseInt(latest[1], 10);
    const limit = Number.isInteger(count) && count > 0 ? Math.min(count, SQL_MAX_ROWS) : 10;
    return {
      sql: 'SELECT doc_id, category, source, text, updated_at FROM knowledge_docs ORDER BY updated_at DESC LIMIT ?',
      params: [limit],
      kind: 'recent',
      confidence: 0.75,
      explanation: `按更新时间取最近 ${limit} 条知识`,
    };
  }

  if (tag !== '') {
    // "按标签 X 统计 / 有多少条" asks for a count, not a list of matching rows.
    if (/(多少|几条|几篇|几个|数量|总数|总计|统计)/.test(q)) {
      return {
        sql: 'SELECT COUNT(*) AS n FROM knowledge_docs WHERE tags LIKE ?',
        params: [`%${tag}%`],
        kind: 'count',
        confidence: 0.8,
        explanation: `统计标签「${tag}」的知识数量`,
      };
    }
    return {
      sql: 'SELECT doc_id, category, tags, text FROM knowledge_docs WHERE tags LIKE ? ORDER BY updated_at DESC LIMIT 20',
      params: [`%${tag}%`],
      kind: 'tag',
      confidence: 0.7,
      explanation: `按标签「${tag}」过滤`,
    };
  }

  if (/(置信度|confidence)/.test(q)) {
    if (/(平均|均值)/.test(q)) {
      return {
        sql: `SELECT ROUND(AVG(confidence), 3) AS avg_confidence FROM knowledge_docs${
          category ? ' WHERE category = ?' : ''}`,
        params: category ? [category] : [],
        kind: 'confidence',
        confidence: 0.9,
        explanation: '计算平均置信度',
      };
    }
    const desc = /最低/.test(q) ? 'ASC' : 'DESC';
    return {
      sql: `SELECT doc_id, category, confidence, text FROM knowledge_docs ORDER BY confidence ${desc} LIMIT 10`,
      params: [],
      kind: 'confidence',
      confidence: 0.85,
      explanation: `按置信度${desc === 'DESC' ? '从高到低' : '从低到高'}取前 10 条`,
    };
  }

  if (/(最长|字数最多|最详细)/.test(q)) {
    return {
      sql: 'SELECT doc_id, category, length(text) AS chars, text FROM knowledge_docs ORDER BY length(text) DESC LIMIT 5',
      params: [],
      kind: 'length',
      confidence: 0.8,
      explanation: '按正文字数取最长的 5 条知识',
    };
  }

  if (/(多少|几条|几篇|几个|数量|总数|总计)/.test(q)) {
    return {
      sql: `SELECT COUNT(*) AS n, COUNT(DISTINCT doc_id) AS distinct_docs FROM knowledge_docs${category ? ' WHERE category = ?' : ''}`,
      params: category ? [category] : [],
      kind: 'count',
      confidence: 0.9,
      explanation: category
        ? `统计分类 ${category} 的知识数量（副本数 + 去重事实数）`
        : '统计知识总条数（副本数 + 去重事实数）',
    };
  }

  return null;
}

/**
 * Blank out SQL string literals, quoted identifiers and comments.
 *
 * The read-only check must not see `delete` or `;` inside a string literal, and
 * must still reject a second statement hidden after a comment. Returns `null`
 * for an unterminated quote/comment so the caller rejects the whole statement.
 */
function sqlWithoutLiterals(sql) {
  const source = String(sql ?? '');
  const out = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      let closed = false;
      while (i < source.length) {
        if (source[i] === quote) {
          if (source[i + 1] === quote) { i += 2; continue; }
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) return null;
      out.push(' ');
      continue;
    }
    if (ch === '[') {
      const close = source.indexOf(']', i + 1);
      if (close < 0) return null;
      i = close + 1;
      out.push(' ');
      continue;
    }
    if (ch === '-' && source[i + 1] === '-') {
      const newline = source.indexOf('\n', i + 2);
      i = newline < 0 ? source.length : newline + 1;
      out.push(' ');
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      if (close < 0) return null;
      i = close + 2;
      out.push(' ');
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

/**
 * Tokenize just enough SQL to inspect CTE names and `FROM`/`JOIN` targets.
 * Strings and comments are dropped; quoted identifiers keep their decoded value
 * so `FROM "c"` is visible instead of being blanked by sqlWithoutLiterals().
 * Returns null on an unterminated quote or comment.
 */
function tokenizeCteSql(sql) {
  const source = String(sql ?? '');
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "'") {
      i += 1;
      let closed = false;
      while (i < source.length) {
        if (source[i] === "'") {
          if (source[i + 1] === "'") { i += 2; continue; }
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) return null;
      continue;
    }
    if (ch === '-' && source[i + 1] === '-') {
      const newline = source.indexOf('\n', i + 2);
      i = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      if (close < 0) return null;
      i = close + 2;
      continue;
    }
    if (ch === '"' || ch === '`' || ch === '[') {
      const closeChar = ch === '[' ? ']' : ch;
      let value = '';
      let closed = false;
      i += 1;
      while (i < source.length) {
        if (source[i] === closeChar) {
          if (source[i + 1] === closeChar) { value += closeChar; i += 2; continue; }
          i += 1;
          closed = true;
          break;
        }
        value += source[i];
        i += 1;
      }
      if (!closed) return null;
      tokens.push({ kind: 'quoted', value });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < source.length && /[\w$]/.test(source[i])) i += 1;
      const value = source.slice(start, i);
      tokens.push({ kind: 'word', value, upper: value.toUpperCase() });
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < source.length && /[\d.]/.test(source[i])) i += 1;
      tokens.push({ kind: 'number', value: source.slice(start, i) });
      continue;
    }
    tokens.push({ kind: 'punct', value: ch });
    i += 1;
  }
  return tokens;
}

function isCteWord(token, upper) {
  return token?.kind === 'word' && token.upper === upper;
}

function isCtePunct(token, value) {
  return token?.kind === 'punct' && token.value === value;
}

/** Index of the `)` matching the `(` token at `open`, or -1. */
function matchingParenToken(tokens, open) {
  if (!isCtePunct(tokens[open], '(')) return -1;
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    if (isCtePunct(tokens[i], '(')) depth += 1;
    else if (isCtePunct(tokens[i], ')')) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** True when the CTE body has a FROM/JOIN target with this CTE's name. */
function bodyReferencesCte(tokens, start, end, cte) {
  for (let i = start; i < end; i += 1) {
    if (!isCteWord(tokens[i], 'FROM')) continue;
    if (fromListReferencesCte(tokens, i + 1, end, cte)) return true;
  }
  return false;
}

// A FROM clause ends at the next top-level clause keyword; commas and JOINs
// inside it introduce more table references.
const FROM_TERMINATORS = new Set([
  'WHERE', 'GROUP', 'HAVING', 'WINDOW', 'ORDER', 'LIMIT', 'OFFSET',
  'UNION', 'INTERSECT', 'EXCEPT', 'RETURNING',
]);

/**
 * Scan one FROM list, including comma-separated tables, JOINs and parenthesized
 * table groups such as `FROM (knowledge_docs, c)`. Subqueries are skipped here
 * because bodyReferencesCte() visits their own FROM tokens separately.
 */
function fromListReferencesCte(tokens, start, end, cte) {
  let expectTable = true;
  for (let i = start; i < end; i += 1) {
    const token = tokens[i];
    if (isCtePunct(token, ')')) break;
    if (isCtePunct(token, '(')) {
      const close = matchingParenToken(tokens, i);
      if (close < 0 || close >= end) return true;
      const first = tokens[i + 1];
      const subquery = isCteWord(first, 'SELECT')
        || isCteWord(first, 'WITH')
        || isCteWord(first, 'VALUES');
      // A function call after a table name (`json_each(...)`) is not a table
      // group; only recurse while a table slot is expected.
      if (expectTable && !subquery && fromListReferencesCte(tokens, i + 1, close, cte)) {
        return true;
      }
      i = close;
      expectTable = false;
      continue;
    }
    if (isCtePunct(token, ',')) {
      expectTable = true;
      continue;
    }
    if (isCteWord(token, 'JOIN')) {
      expectTable = true;
      continue;
    }
    if (token.kind === 'word' && FROM_TERMINATORS.has(token.upper)) break;
    if (!expectTable || (token.kind !== 'word' && token.kind !== 'quoted')) continue;
    let target = token;
    // `FROM schema."c"`: the table name is the token after the dot.
    if (isCtePunct(tokens[i + 1], '.')) {
      target = tokens[i + 2];
      if (!target || (target.kind !== 'word' && target.kind !== 'quoted')) return true;
      i += 2;
    }
    if (target.value.toLowerCase() === cte) return true;
    expectTable = false;
  }
  return false;
}

/**
 * True when the CTE list starting just after one `WITH` token is recursive or
 * cannot be parsed. SQLite accepts `WITH c(x) AS (... FROM "c")` even without
 * the `RECURSIVE` keyword, so the check must compare decoded identifiers.
 */
function withClauseIsUnsafe(tokens, start) {
  let i = start;
  if (isCteWord(tokens[i], 'RECURSIVE')) return true;
  for (;;) {
    const name = tokens[i];
    if (!name || (name.kind !== 'word' && name.kind !== 'quoted')) return true;
    const cte = name.value.toLowerCase();
    i += 1;
    if (isCtePunct(tokens[i], '(')) {
      const columns = matchingParenToken(tokens, i);
      if (columns < 0) return true;
      i = columns + 1;
    }
    if (!isCteWord(tokens[i], 'AS')) return true;
    i += 1;
    if (isCteWord(tokens[i], 'NOT')) {
      i += 1;
      if (!isCteWord(tokens[i], 'MATERIALIZED')) return true;
    }
    if (isCteWord(tokens[i], 'MATERIALIZED')) i += 1;
    if (!isCtePunct(tokens[i], '(')) return true;
    const close = matchingParenToken(tokens, i);
    if (close < 0) return true;
    if (bodyReferencesCte(tokens, i + 1, close, cte)) return true;
    i = close + 1;
    if (isCtePunct(tokens[i], ',')) {
      i += 1;
      continue;
    }
    return false;
  }
}

/** True when the statement calls a function that can allocate unbounded output. */
function hasForbiddenSqlFunction(sql) {
  const tokens = tokenizeCteSql(sql);
  if (tokens === null) return true;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const token = tokens[i];
    if ((token.kind === 'word' || token.kind === 'quoted')
      && FORBIDDEN_SQL_FUNCTIONS.has(token.value.toLowerCase())
      && isCtePunct(tokens[i + 1], '(')) {
      return true;
    }
  }
  return false;
}

/** JSON table-valued functions: they expand a column and add no real relation. */
const JSON_TABLE_FUNCTIONS = new Set(['json_each', 'json_tree']);

/** Relations a read-only SELECT may name. Everything else is off-limits. */
const ALLOWED_RELATIONS = new Set(['knowledge_docs', ...JSON_TABLE_FUNCTIONS]);

/**
 * True when a JOIN targets anything other than json_each()/json_tree().
 *
 * The SQL route allows one `knowledge_docs` relation plus bounded derived
 * views. `JOIN json_each(tags)` is the join tag queries actually need and it
 * cannot reach a second table; every other join stays rejected because a real
 * join (or a self cross join) can materialize a cartesian product synchronously
 * before the outer LIMIT sees a row.
 */
function hasUnsafeJoin(sql) {
  const tokens = tokenizeCteSql(sql);
  if (tokens === null) return true;
  for (let i = 0; i < tokens.length; i += 1) {
    if (!isCteWord(tokens[i], 'JOIN')) continue;
    const target = tokens[i + 1];
    if (!target || (target.kind !== 'word' && target.kind !== 'quoted')) return true;
    if (!JSON_TABLE_FUNCTIONS.has(target.value.toLowerCase())) return true;
    if (!isCtePunct(tokens[i + 2], '(')) return true;
  }
  return false;
}

/**
 * Names introduced by `WITH` clauses anywhere in the statement.
 *
 * A CTE is a derived view over the single knowledge table, so its name is a
 * legal FROM target. The set is collected up front because a CTE can be
 * referenced before later CTEs are parsed (`FROM a` while `a`'s body is being
 * read is still a normal derived view reference).
 */
function cteNames(tokens) {
  const names = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    if (!isCteWord(tokens[i], 'WITH')) continue;
    // Match hasUnsafeCte(): `SELECT 1 AS with` is an alias, not a CTE.
    if (i > 0 && !isCtePunct(tokens[i - 1], '(')) continue;
    let j = i + 1;
    if (isCteWord(tokens[j], 'RECURSIVE')) j += 1;
    for (;;) {
      const name = tokens[j];
      if (!name || (name.kind !== 'word' && name.kind !== 'quoted')) break;
      names.add(String(name.value).toLowerCase());
      j += 1;
      if (isCtePunct(tokens[j], '(')) {
        const columns = matchingParenToken(tokens, j);
        if (columns < 0) break;
        j = columns + 1;
      }
      if (!isCteWord(tokens[j], 'AS')) break;
      j += 1;
      if (isCteWord(tokens[j], 'NOT')) j += 1;
      if (isCteWord(tokens[j], 'MATERIALIZED')) j += 1;
      if (!isCtePunct(tokens[j], '(')) break;
      const close = matchingParenToken(tokens, j);
      if (close < 0) break;
      j = close + 1;
      if (isCtePunct(tokens[j], ',')) {
        j += 1;
        continue;
      }
      break;
    }
  }
  return names;
}

/** True when any CTE in the statement is recursive or unparseable. */
function hasUnsafeCte(sql) {
  const tokens = tokenizeCteSql(sql);
  if (tokens === null) return true;
  for (let i = 0; i < tokens.length; i += 1) {
    if (!isCteWord(tokens[i], 'WITH')) continue;
    // A CTE's WITH starts the statement or a parenthesized subquery. `with`
    // after AS is a legal column alias (`SELECT 1 AS with`), not a CTE; scanning
    // it as one rejected a valid read-only query.
    if (i > 0 && !isCtePunct(tokens[i - 1], '(')) continue;
    if (withClauseIsUnsafe(tokens, i + 1)) return true;
  }
  return false;
}

/**
 * Count relation references in every FROM list.
 *
 * The validator allows one real table plus CTEs, so a relation name appearing
 * twice in FROM positions is a self cross join. `WITH x AS (...) SELECT count(*)
 * FROM x, x, x, x` computes N^4 rows before the outer LIMIT 50 can stop
 * anything, and it used no JOIN keyword, so the old checks let it through.
 * JOINs are rejected separately; this covers the comma form, including table
 * groups such as `FROM (x, x)`.
 */
function collectFromRelations(tokens, counts) {
  for (let i = 0; i < tokens.length; i += 1) {
    if (!isCteWord(tokens[i], 'FROM')) continue;
    scanFromList(tokens, i + 1, counts);
  }
}

function scanFromList(tokens, start, counts) {
  let expectTable = true;
  for (let j = start; j < tokens.length; j += 1) {
    const token = tokens[j];
    if (isCtePunct(token, ')')) return;
    if (isCtePunct(token, ',')) {
      expectTable = true;
      continue;
    }
    if (isCtePunct(token, '(')) {
      const close = matchingParenToken(tokens, j);
      if (close < 0) return;
      const first = tokens[j + 1];
      const subquery = isCteWord(first, 'SELECT')
        || isCteWord(first, 'WITH')
        || isCteWord(first, 'VALUES');
      // A table group `(x, y)` is a join in disguise: recurse into it. A
      // function argument list (`json_each(tags)`) is not a relation, and a
      // subquery is skipped here because its own FROM is visited by the outer
      // scan. Recursing into arguments used to count `tags` as a table.
      if (expectTable && !subquery) scanFromList(tokens, j + 1, counts);
      j = close;
      expectTable = false;
      continue;
    }
    if (token.kind === 'word' && FROM_TERMINATORS.has(token.upper)) return;
    if (!expectTable || (token.kind !== 'word' && token.kind !== 'quoted')) continue;
    if (['select', 'with', 'values', 'lateral'].includes(String(token.value).toLowerCase())) continue;
    // `FROM main."knowledge_docs"`: judge the table name, not the schema. The
    // temp database only has `main`, and naming it explicitly must not turn a
    // known relation into a foreign one.
    let name = String(token.value).toLowerCase();
    if (isCtePunct(tokens[j + 1], '.')) {
      const table = tokens[j + 2];
      if (table && (table.kind === 'word' || table.kind === 'quoted')) {
        name = String(table.value).toLowerCase();
        j += 2;
      }
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);
    expectTable = false;
  }
}

/** True when any relation is referenced from FROM more than once. */
function hasDuplicateRelations(sql) {
  const tokens = tokenizeCteSql(sql);
  if (tokens === null) return true;
  const counts = new Map();
  collectFromRelations(tokens, counts);
  for (const count of counts.values()) if (count > 1) return true;
  return false;
}

/**
 * True when a FROM/JOIN target is not one of the relations the route owns.
 *
 * The SQL route builds a throwaway database from the JSON base, so the only
 * relation it can legitimately expose is `knowledge_docs`. JSON table-valued
 * functions expand a column of that relation, and CTEs are derived views over
 * it. Everything else — `sqlite_master`, `sqlite_schema`, `sqlite_temp_master`,
 * `pragma_table_info(...)`, attached schemas, extension tables — leaks catalog
 * or runtime state that the channel is not supposed to expose. The old checks
 * only counted `knowledge_docs` occurrences, so a query naming a different
 * relation (or a pragma table function) passed the gate; the execution error
 * for unknown names made the gap invisible until the relation existed.
 */
function hasForeignRelation(sql) {
  const tokens = tokenizeCteSql(sql);
  if (tokens === null) return true;
  const allowed = new Set(ALLOWED_RELATIONS);
  for (const name of cteNames(tokens)) allowed.add(name);
  const counts = new Map();
  collectFromRelations(tokens, counts);
  for (const name of counts.keys()) if (!allowed.has(name)) return true;
  return false;
}

/** True when the text is one read-only SELECT/WITH statement. */
export function isSafeSelect(sql) {
  const text = String(sql ?? '').trim();
  if (text === '') return false;
  const stripped = sqlWithoutLiterals(text);
  if (stripped === null) return false;
  let body = stripped.trim();
  if (!/^\s*(select|with)\b/i.test(body)) return false;
  // Allow one trailing semicolon (the caller may type `SELECT ...;`), but do
  // not let a semicolon in a string literal count as a second statement.
  if (body.endsWith(';')) body = body.slice(0, -1).trimEnd();
  if (/;/.test(body)) return false;
  if (/\b(insert|update|delete|replace|drop|alter|attach|detach|pragma|create|vacuum|reindex)\b/i.test(body)) {
    return false;
  }
  // There is exactly one table (`knowledge_docs`) and one derived view. A real
  // JOIN, or the same table referenced twice, is a cartesian product or an
  // aggregate SQLite materializes synchronously before yielding a row — one raw
  // SELECT can then block the host event loop for minutes. No legitimate
  // knowledge query needs that; only JSON table-valued functions may be joined.
  if (hasUnsafeJoin(text)) return false;
  // Duplicate FROM references are counted by name (see hasDuplicateRelations).
  // Counting the raw string `knowledge_docs` rejected `json_each(knowledge_docs.tags)`,
  // a schema-qualified column reference that names the table only once.
  // Comma joins and table groups (`FROM x, x`, `FROM (x, x)`) bypass the JOIN
  // and table-name checks when the repeated name is a CTE.
  if (hasDuplicateRelations(text)) return false;
  // The route's database only owns `knowledge_docs`; a query naming any other
  // relation (internal catalog tables, pragma table functions, attached
  // schemas) is outside the channel even when SQLite could answer it.
  if (hasForeignRelation(text)) return false;
  // `printf`/`format` and other expanding functions can turn a short input into
  // an arbitrarily large value before any row-byte check runs. Check decoded
  // identifiers too, so "hex"(...) and [group_concat](...) cannot hide behind
  // quoting.
  if (hasForbiddenSqlFunction(text)) return false;
  // A recursive CTE is one row generator with no built-in stop condition; the
  // execution path is synchronous, so let the validator reject it up front.
  // Tokenize the original text, not `body`, because sqlWithoutLiterals() blanks
  // quoted identifiers and would hide `FROM "c"`.
  if (hasUnsafeCte(text)) return false;
  return true;
}

/**
 * Install output-size guards before any query runs.
 *
 * SQLite materializes a scalar result before the driver can inspect it, so a
 * post-hoc row-byte check cannot stop `randomblob(134217728)` from allocating
 * 128 MiB. Set SQLite's own value-length limit where the runtime exposes it,
 * override the blob constructors with bounded versions, and deny expanding
 * functions that the limit cannot be assumed to cover on every Node version.
 */
function installQueryLimits(db, sqlite) {
  const deniedFunctions = new Set(FORBIDDEN_SQL_FUNCTIONS);
  const addDenied = (name) => { deniedFunctions.add(name); };

  // Newer Node exposes SQLITE_LIMIT_LENGTH as db.limits.length; it rejects an
  // oversized string/blob while SQLite is building it. Node 22 has no limits
  // property, hence the function denials below.
  try {
    if (db.limits && typeof db.limits.length === 'number') {
      db.limits.length = SQL_MAX_ROW_BYTES;
    }
  } catch {
    // Older runtimes may expose a read-only object; the denials still apply.
  }

  if (typeof db.function === 'function') {
    try {
      db.function('randomblob', { deterministic: false }, (size) => {
        const bytes = Math.max(1, Math.trunc(Number(size) || 0));
        if (!Number.isFinite(bytes) || bytes > SQL_MAX_ROW_BYTES) {
          throw new Error(`randomblob 请求 ${bytes} 字节，超过单值上限 ${SQL_MAX_ROW_BYTES}`);
        }
        return randomBytes(bytes);
      });
    } catch {
      addDenied('randomblob');
    }
    try {
      db.function('zeroblob', { deterministic: true }, (size) => {
        const bytes = Math.max(0, Math.trunc(Number(size) || 0));
        if (!Number.isFinite(bytes) || bytes > SQL_MAX_ROW_BYTES) {
          throw new Error(`zeroblob 请求 ${bytes} 字节，超过单值上限 ${SQL_MAX_ROW_BYTES}`);
        }
        return Buffer.alloc(bytes);
      });
    } catch {
      addDenied('zeroblob');
    }
  } else {
    addDenied('randomblob');
    addDenied('zeroblob');
  }

  const constants = sqlite?.constants ?? sqlite ?? {};
  if (typeof db.setAuthorizer === 'function' && Number.isInteger(constants.SQLITE_FUNCTION)) {
    const deny = Number.isInteger(constants.SQLITE_DENY) ? constants.SQLITE_DENY : 1;
    const ok = Number.isInteger(constants.SQLITE_OK) ? constants.SQLITE_OK : 0;
    db.setAuthorizer((action, arg1, arg2) => {
      if (action === constants.SQLITE_FUNCTION
        && deniedFunctions.has(String(arg2 ?? '').toLowerCase())) {
        return deny;
      }
      return ok;
    });
  }
}

/**
 * Build an in-memory SQLite database from the JSON documents of one store (or a
 * merged list of documents). The optional `origin` column keeps the source
 * conversation when several stores are queried at once.
 *
 * @param {import('./store.js').MemoryStore|any[]} input
 * @returns {{ db: any, close: () => void } | null}
 */
export function openQueryDatabase(input) {
  let DatabaseSync;
  let sqlite;
  try {
    if (typeof process.getBuiltinModule !== 'function') return null;
    sqlite = process.getBuiltinModule('node:sqlite') ?? {};
    ({ DatabaseSync } = sqlite);
  } catch {
    return null;
  }
  if (typeof DatabaseSync !== 'function') return null;
  const docs = Array.isArray(input) ? input : input.documents();
  const db = new DatabaseSync(':memory:');
  installQueryLimits(db, sqlite);
  db.exec(`
    CREATE TABLE knowledge_docs (
      doc_id TEXT NOT NULL, text TEXT NOT NULL, category TEXT NOT NULL,
      source TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
      confidence REAL NOT NULL DEFAULT 0.8,
      provenance TEXT NOT NULL DEFAULT 'authored', verified INTEGER NOT NULL DEFAULT 1,
      evidence TEXT NOT NULL DEFAULT '[]', changes TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1, origin TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (origin, doc_id)
    );
    CREATE INDEX knowledge_docs_doc_id ON knowledge_docs(doc_id);
  `);
  const insert = db.prepare(`
    INSERT OR REPLACE INTO knowledge_docs
      (doc_id, text, category, source, url, tags, confidence, provenance, verified,
       evidence, changes, created_at, updated_at, revision, origin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const doc of docs) {
    insert.run(
      doc.doc_id,
      doc.text,
      doc.category,
      doc.source,
      doc.url,
      JSON.stringify(Array.isArray(doc.tags) ? doc.tags : []),
      Number.isFinite(doc.confidence) ? doc.confidence : 0.8,
      typeof doc.provenance === 'string' ? doc.provenance : 'authored',
      doc.verified === true ? 1 : 0,
      JSON.stringify(Array.isArray(doc.evidence) ? doc.evidence : []),
      JSON.stringify(Array.isArray(doc.changes) ? doc.changes : []),
      doc.created_at ?? '',
      doc.updated_at ?? '',
      Number.isInteger(doc.revision) ? doc.revision : 1,
      typeof doc.origin === 'string' ? doc.origin : '',
    );
  }
  return { db, close: () => db.close() };
}

/** Estimated in-memory size of one SQLite value. */
function sqlValueBytes(value) {
  if (typeof value === 'string') {
    // JS strings are UTF-16 in memory; compare both that and the serialized
    // UTF-8 size so a wide string cannot slip under the cap.
    return Math.max(Buffer.byteLength(value, 'utf8'), value.length * 2);
  }
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (value == null) return 0;
  return 8;
}

function sqlRowBytes(row) {
  let total = 0;
  for (const [key, value] of Object.entries(row)) {
    total += key.length * 2 + sqlValueBytes(value);
  }
  return total;
}

/** Run one translated question against the JSON-derived SQL view. */
export function runSqlQuery(input, query) {
  const plan = translateToSql(query);
  if (!plan) return { ok: false, error: '这个问题无法稳定翻译成只读 SQL。' };
  const docs = Array.isArray(input) ? input : input.documents();
  const opened = openCachedQueryDatabase(docs);
  if (!opened) return { ok: false, error: '当前 Node 不支持 node:sqlite，SQL 通道不可用。' };
  try {
    // `iterate()` lets us stop after the visible-row budget instead of
    // materializing an unbounded result set before slicing it. Byte caps stop
    // a few wide rows from doing the same thing with their payloads.
    const statement = opened.db.prepare(plan.sql);
    const rows = [];
    let totalBytes = 0;
    for (const row of statement.iterate(...plan.params)) {
      if (rows.length >= SQL_MAX_ROWS) break;
      const bytes = sqlRowBytes(row);
      if (bytes > SQL_MAX_ROW_BYTES) {
        return {
          ok: false,
          error: `SQL 结果单行超过 ${SQL_MAX_ROW_BYTES} 字节上限，已拒绝返回。`,
          plan,
        };
      }
      if (totalBytes + bytes > SQL_MAX_RESULT_BYTES) {
        return {
          ok: false,
          error: `SQL 结果超过 ${SQL_MAX_RESULT_BYTES} 字节上限，已拒绝返回。`,
          plan,
        };
      }
      rows.push(row);
      totalBytes += bytes;
    }
    return { ok: true, plan, rows };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), plan };
  }
}

/** Reuse the derived SQLite view until the document set actually changes. */
const QUERY_CACHE = new Map();
const QUERY_CACHE_MAX = 4;

function querySignature(docs) {
  const textHash = (text) => {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  };
  return docs.map((doc) => [
    doc.origin ?? '',
    doc.doc_id ?? '',
    doc.text.length,
    textHash(doc.text),
    doc.category ?? '',
    doc.source ?? '',
    doc.url ?? '',
    doc.updated_at ?? '',
    doc.revision ?? 1,
    doc.provenance ?? 'authored',
    doc.verified === true ? 1 : 0,
    Number.isFinite(doc.confidence) ? doc.confidence : 0.8,
    Array.isArray(doc.changes) ? doc.changes.length : 0,
  ].join('\u0000')).sort().join('\u0001');
}

function openCachedQueryDatabase(docs) {
  const signature = querySignature(docs);
  const hit = QUERY_CACHE.get(signature);
  if (hit) {
    // LRU: refresh insertion order.
    QUERY_CACHE.delete(signature);
    QUERY_CACHE.set(signature, hit);
    return hit;
  }
  const opened = openQueryDatabase(docs);
  if (!opened) return null;
  QUERY_CACHE.set(signature, opened);
  if (QUERY_CACHE.size > QUERY_CACHE_MAX) {
    const oldest = QUERY_CACHE.keys().next().value;
    const evicted = QUERY_CACHE.get(oldest);
    QUERY_CACHE.delete(oldest);
    evicted?.close?.();
  }
  return opened;
}

/** Human-readable output for one SQL result. */
export function formatSqlResult(query, result) {
  if (result.ok !== true) {
    return `SQL 通道没有执行：${result.error}`;
  }
  const { plan, rows } = result;
  const confidence = Number.isFinite(plan.confidence) ? `（置信度 ${plan.confidence.toFixed(2)}）` : '';
  const lines = [`检索路由：SQL（Text-to-SQL）｜${plan.explanation}${confidence}`];
  if (rows.length === 0) {
    lines.push(`没有命中的数据（${query}）。`);
    return lines.join('\n');
  }
  lines.push(`SQL：${plan.sql}`);
  lines.push(`结果 ${rows.length} 行：`);
  for (const row of rows) {
    const parts = Object.entries(row)
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([key, value]) => {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        return `${key}=${text.length > 240 ? `${text.slice(0, 240)}…` : text}`;
      });
    lines.push(`- ${parts.join('｜')}`);
  }
  const unverified = rows.filter((row) => row.provenance === 'model'
    && !(row.verified === 1 || row.verified === true)).length;
  if (unverified > 0) {
    lines.push(`⚠ 其中 ${unverified} 行是模型自述（未经用户确认），已标为 provenance=model / verified=0；不要当作项目事实。`);
  }
  if (rows.length >= SQL_MAX_ROWS) lines.push(`（只显示前 ${SQL_MAX_ROWS} 行）`);
  return lines.join('\n');
}
