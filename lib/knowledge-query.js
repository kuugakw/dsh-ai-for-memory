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

import { CATEGORIES } from './util.js';

const SQL_MAX_ROWS = 50;

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
});

const METRIC_RE = /(多少|几条|几篇|几个|数量|总数|统计|分布|占比|排行|排名|平均|最高|最低|最多|最少|top\s*\d+|最近\s*(\d+|几|多少)?\s*(条|篇|个)?|按\s*(分类|来源|标签)|各\s*(分类|来源|标签)|每\s*(个)?\s*(分类|来源|标签))/i;
const OPEN_RE = /(怎么|如何|为什么|什么|哪些|介绍|解释|总结|整理|相关|有关|关于|类似|经验|方案|原因|区别|对比|建议|怎么用|怎么改|有没有)/;
const ID_RE = /\bk_[0-9a-z]{4,}\b/i;
const RAW_SQL_RE = /^\s*(select|with)\b/i;

/** Map a Chinese category mention to its stored id, or `null`. */
export function categoryOf(text) {
  const value = String(text ?? '');
  for (const category of CATEGORIES) {
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
  if (metric && open) {
    return { route: 'hybrid', intent: 'metric+open', reason: '指标 + 开放描述：SQL 出事实、向量补上下文' };
  }
  if (metric) return { route: 'sql', intent: 'metric', reason: '指标/聚合/精确统计' };
  return { route: 'vector', intent: 'open', reason: '开放文档类问题' };
}

/** Translate one question into a read-only SQL plan, or `null` when unsure. */
export function translateToSql(query) {
  const q = String(query ?? '').trim();
  if (q === '') return null;

  if (RAW_SQL_RE.test(q)) {
    if (!isSafeSelect(q)) return null;
    return { sql: q.replace(/;\s*$/, ''), params: [], kind: 'raw', explanation: '执行显式只读 SELECT' };
  }

  const idMatch = q.match(ID_RE);
  if (idMatch) {
    const value = idMatch[0].toLowerCase();
    return {
      sql: 'SELECT * FROM knowledge_docs WHERE lower(doc_id) LIKE ? LIMIT 5',
      params: [`${value}%`],
      kind: 'exact',
      explanation: `按 doc_id 精确查找 ${value}`,
    };
  }

  if (/(按|各|每(个)?)\s*(分类|来源)/.test(q) || /(分类|来源)\s*(分布|统计|数量|多少)/.test(q)) {
    const bySource = /来源/.test(q) && !/分类/.test(q);
    const column = bySource ? 'source' : 'category';
    return {
      sql: `SELECT ${column} AS label, COUNT(*) AS n FROM knowledge_docs GROUP BY ${column} ORDER BY n DESC`,
      params: [],
      kind: 'group',
      explanation: `按${bySource ? '来源' : '分类'}分组统计`,
    };
  }

  if (/(哪个|哪个分类|什么分类).*(最多|最少)/.test(q) || /(最多|最少).*(分类|来源)/.test(q)) {
    const desc = /最少/.test(q) ? 'ASC' : 'DESC';
    const column = /来源/.test(q) ? 'source' : 'category';
    return {
      sql: `SELECT ${column} AS label, COUNT(*) AS n FROM knowledge_docs GROUP BY ${column} ORDER BY n ${desc} LIMIT 1`,
      params: [],
      kind: 'top',
      explanation: `找出数量${desc === 'DESC' ? '最多' : '最少'}的${column === 'source' ? '来源' : '分类'}`,
    };
  }

  const category = categoryOf(q);
  const tagMatch = q.match(/标签[^\w]*([\w\-.\u4e00-\u9fff]+)/);
  const latest = q.match(/最近\s*(\d+|几|多少)?\s*(条|篇|个)?/);
  const wantsList = /(列出|显示|查看|最近|最新|哪些)/.test(q);

  if (latest && wantsList) {
    const count = Number.parseInt(latest[1], 10);
    const limit = Number.isInteger(count) && count > 0 ? Math.min(count, SQL_MAX_ROWS) : 10;
    return {
      sql: 'SELECT doc_id, category, source, text, updated_at FROM knowledge_docs ORDER BY updated_at DESC LIMIT ?',
      params: [limit],
      kind: 'recent',
      explanation: `按更新时间取最近 ${limit} 条知识`,
    };
  }

  if (tagMatch) {
    return {
      sql: 'SELECT doc_id, category, tags, text FROM knowledge_docs WHERE tags LIKE ? ORDER BY updated_at DESC LIMIT 20',
      params: [`%${tagMatch[1]}%`],
      kind: 'tag',
      explanation: `按标签「${tagMatch[1]}」过滤`,
    };
  }

  if (/(置信度|confidence)/.test(q)) {
    if (/(平均|均值)/.test(q)) {
      return {
        sql: `SELECT ROUND(AVG(confidence), 3) AS avg_confidence FROM knowledge_docs${
          category ? ' WHERE category = ?' : ''}`,
        params: category ? [category] : [],
        kind: 'confidence',
        explanation: '计算平均置信度',
      };
    }
    const desc = /最低/.test(q) ? 'ASC' : 'DESC';
    return {
      sql: `SELECT doc_id, category, confidence, text FROM knowledge_docs ORDER BY confidence ${desc} LIMIT 10`,
      params: [],
      kind: 'confidence',
      explanation: `按置信度${desc === 'DESC' ? '从高到低' : '从低到高'}取前 10 条`,
    };
  }

  if (/(最长|字数最多|最详细)/.test(q)) {
    return {
      sql: 'SELECT doc_id, category, length(text) AS chars, text FROM knowledge_docs ORDER BY length(text) DESC LIMIT 5',
      params: [],
      kind: 'length',
      explanation: '按正文字数取最长的 5 条知识',
    };
  }

  if (/(多少|几条|几篇|几个|数量|总数|总计)/.test(q)) {
    return {
      sql: `SELECT COUNT(*) AS n FROM knowledge_docs${category ? ' WHERE category = ?' : ''}`,
      params: category ? [category] : [],
      kind: 'count',
      explanation: category ? `统计分类 ${category} 的知识数量` : '统计知识总条数',
    };
  }

  return null;
}

/** True when the text is one read-only SELECT/WITH statement. */
export function isSafeSelect(sql) {
  const text = String(sql ?? '').trim().replace(/;\s*$/, '');
  if (text === '') return false;
  if (!/^\s*(select|with)\b/i.test(text)) return false;
  if (/;/.test(text)) return false;
  if (/\b(insert|update|delete|replace|drop|alter|attach|detach|pragma|create|vacuum|reindex)\b/i.test(text)) {
    return false;
  }
  return true;
}

/**
 * Build an in-memory SQLite database from the JSON documents of one store (or a
 * merged list of documents). The optional `origin` column keeps the source
 * conversation when several stores are queried at once.
 *
 * @param {import('./store.js').MemoryStore|object[]} input
 * @returns {{ db: object, close: () => void } | null}
 */
export function openQueryDatabase(input) {
  let DatabaseSync;
  try {
    if (typeof process.getBuiltinModule !== 'function') return null;
    ({ DatabaseSync } = process.getBuiltinModule('node:sqlite') ?? {});
  } catch {
    return null;
  }
  if (typeof DatabaseSync !== 'function') return null;
  const docs = Array.isArray(input) ? input : input.documents();
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE knowledge_docs (
      doc_id TEXT PRIMARY KEY, text TEXT NOT NULL, category TEXT NOT NULL,
      source TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
      confidence REAL NOT NULL DEFAULT 0.8, evidence TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1, origin TEXT NOT NULL DEFAULT ''
    );
  `);
  const insert = db.prepare(`
    INSERT OR REPLACE INTO knowledge_docs
      (doc_id, text, category, source, url, tags, confidence, evidence, created_at, updated_at, revision, origin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      JSON.stringify(Array.isArray(doc.evidence) ? doc.evidence : []),
      doc.created_at ?? '',
      doc.updated_at ?? '',
      Number.isInteger(doc.revision) ? doc.revision : 1,
      typeof doc.origin === 'string' ? doc.origin : '',
    );
  }
  return { db, close: () => db.close() };
}

/** Run one translated question against the JSON-derived SQL view. */
export function runSqlQuery(input, query) {
  const plan = translateToSql(query);
  if (!plan) return { ok: false, error: '这个问题无法稳定翻译成只读 SQL。' };
  const opened = openQueryDatabase(input);
  if (!opened) return { ok: false, error: '当前 Node 不支持 node:sqlite，SQL 通道不可用。' };
  try {
    const rows = opened.db.prepare(plan.sql).all(...plan.params);
    return { ok: true, plan, rows: rows.slice(0, SQL_MAX_ROWS) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), plan };
  } finally {
    opened.close();
  }
}

/** Human-readable output for one SQL result. */
export function formatSqlResult(query, result) {
  if (result.ok !== true) {
    return `SQL 通道没有执行：${result.error}`;
  }
  const { plan, rows } = result;
  const lines = [`检索路由：SQL（Text-to-SQL）｜${plan.explanation}`];
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
  if (rows.length >= SQL_MAX_ROWS) lines.push(`（只显示前 ${SQL_MAX_ROWS} 行）`);
  return lines.join('\n');
}
