#!/usr/bin/env node
/**
 * Scale smoke test for the JSON store: seed a large corpus, then measure the
 * operations the panel and tools actually run.
 *
 * This is a benchmark, not a unit test: it prints a table (and JSON with
 * --json) and fails only when a generous ceiling is exceeded. CI keeps the
 * default small; run `node scripts/bench-scale.mjs --docs=3000 --contexts=20`
 * before a release to reproduce the numbers in docs/benchmarks.md.
 *
 *   node scripts/bench-scale.mjs [--docs=3000] [--contexts=20] [--json]
 *                               [--keep] [--budget-search-cold-ms=8000]
 */
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from '../lib/store.js';
import { runSqlQuery } from '../lib/knowledge-query.js';
import { exportArtifact } from '../lib/export.js';
import { MemoryScopes, sessionKey } from '../lib/scopes.js';

function arg(name, fallback) {
  const match = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (!match) return fallback;
  const raw = match.slice(name.length + 3);
  const number = Number(raw);
  return Number.isFinite(number) ? number : raw;
}

const DOCS = Math.max(1, Number(arg('docs', 3000)));
const CONTEXTS = Math.max(0, Number(arg('contexts', 20)));
const JSON_OUT = process.argv.includes('--json');
const KEEP = process.argv.includes('--keep');
const SEARCH_COLD_BUDGET = Number(arg('budget-search-cold-ms', 8000));
const SEARCH_WARM_BUDGET = Number(arg('budget-search-warm-ms', 500));
const SQL_BUDGET = Number(arg('budget-sql-ms', 8000));

const CATEGORIES = ['project_facts', 'errors_fixes', 'decisions_reasoning', 'ui_facts', 'external_sources'];
const WORDS = ['检索', '数据库', '上下文', '引擎', '面板', '知识库', '快照', '决策', '安全', '迁移'];
const now = new Date('2026-11-28T00:00:00.000Z').toISOString();

function seedCorpus(root) {
  const dir = path.join(root, 'knowledge');
  fs.mkdirSync(dir, { recursive: true });
  for (let index = 0; index < DOCS; index += 1) {
    const id = `k_bench_${String(index).padStart(6, '0')}`;
    const words = [];
    for (let word = 0; word < 12; word += 1) words.push(WORDS[(index + word * 3) % WORDS.length]);
    const doc = {
      doc_id: id,
      text: `第 ${index} 条压测知识：${words.join(' ')}，用于测量 ${DOCS} 篇规模下的检索与导出。`,
      category: CATEGORIES[index % CATEGORIES.length],
      source: 'bench',
      url: index % 7 === 0 ? `https://example.test/item/${index}` : '',
      tags: [`tag-${index % 20}`, `group-${index % 5}`],
      confidence: 0.8,
      provenance: 'authored',
      verified: true,
      changes: [],
      evidence: [{ kind: 'bench', ref: String(index) }],
      created_at: now,
      updated_at: now,
      revision: 1,
    };
    fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(doc)}\n`);
  }
}

function measure(label, fn) {
  const started = performance.now();
  const value = fn();
  return { label, ms: Number((performance.now() - started).toFixed(1)), value };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-bench-'));
const rows = [];
try {
  const init = measure('store.init', () => new MemoryStore(root).init());
  seedCorpus(root);
  const store = init.value;

  const coldDocs = measure('documents (cold)', () => store.documents());
  const warmDocs = measure('documents (warm)', () => store.documents());

  const query = '压测 检索 数据库 上下文';
  const coldSearch = measure('search bm25 (cold)', () => store.search(query, { mode: 'bm25', topK: 5 }));
  const warmSearch = measure('search bm25 (warm)', () => store.search(query, { mode: 'bm25', topK: 5 }));
  const hybridWarm = measure('search hybrid (warm)', () => store.search(query, { mode: 'hybrid', topK: 5 }));

  const sql = measure('sql count by category', () => runSqlQuery(store, '按分类统计知识数量'));
  const sqlRaw = measure('sql raw select 50', () => runSqlQuery(store, 'SELECT doc_id, category FROM knowledge_docs LIMIT 50'));

  const exportJson = measure('export knowledge json', () => exportArtifact(store, { type: 'knowledge', format: 'json' }));
  const exportMarkdown = measure('export knowledge markdown', () => exportArtifact(store, { type: 'knowledge', format: 'markdown' }));

  const contexts = [];
  for (let index = 0; index < CONTEXTS; index += 1) {
    const saved = measure(`saveContext #${index + 1}`, () => store.saveContext({
      label: `bench-${index}`,
      turnFrom: index * 4 + 1,
      turnTo: index * 4 + 4,
      turns: Array.from({ length: 4 }, (_, turn) => ({ text: `压测上下文 ${index}-${turn} ${'内容'.repeat(80)}` })),
      text: `压测上下文 ${index} ${'内容'.repeat(200)}`,
      raw_events: [{ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(400) }] } }],
    }));
    contexts.push(saved.ms);
  }
  const listed = measure('listContexts', () => store.listContexts());

  const scopes = new MemoryScopes(root);
  const sessionKeys = Array.from({ length: 10 }, (_, index) => sessionKey(`bench-session-${index}`));
  for (const key of sessionKeys) {
    const sessionStore = scopes.sessionStore(key);
    sessionStore.init();
    for (let index = 0; index < 20; index += 1) {
      sessionStore.remember({
        text: `会话 ${key} 的第 ${index} 条知识，包含 检索 与 上下文 关键词。`,
        category: 'project_facts',
        source: 'bench',
      });
    }
  }
  const sessions = measure('listSessions (10 x 20)', () => scopes.listSessions());

  const contextAverage = contexts.length === 0
    ? 0
    : contexts.reduce((sum, value) => sum + value, 0) / contexts.length;

  rows.push(init, coldDocs, warmDocs, coldSearch, warmSearch, hybridWarm, sql, sqlRaw, exportJson, exportMarkdown, listed, sessions);
  rows.push({ label: 'saveContext (avg)', ms: Number(contextAverage.toFixed(1)), value: contexts.length });

  const result = {
    docs: DOCS,
    contexts: CONTEXTS,
    sessions: sessionKeys.length,
    root,
    measurements: Object.fromEntries(rows.map((row) => [row.label, row.ms])),
    searchHits: coldSearch.value?.length ?? 0,
    sqlRows: sqlRaw.value?.rows?.length ?? 0,
    exportBytes: exportJson.value?.bytes ?? 0,
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`scale bench: ${DOCS} docs, ${CONTEXTS} contexts, ${sessionKeys.length} sessions`);
    for (const row of rows) console.log(`${row.label.padEnd(28)} ${String(row.ms).padStart(9)} ms`);
    console.log(`search hits=${result.searchHits} sql rows=${result.sqlRows} export=${result.exportBytes} bytes`);
  }

  const failures = [];
  if (coldSearch.ms > SEARCH_COLD_BUDGET) failures.push(`cold search ${coldSearch.ms}ms > ${SEARCH_COLD_BUDGET}ms`);
  if (warmSearch.ms > SEARCH_WARM_BUDGET) failures.push(`warm search ${warmSearch.ms}ms > ${SEARCH_WARM_BUDGET}ms`);
  if (sqlRaw.ms > SQL_BUDGET) failures.push(`raw SQL ${sqlRaw.ms}ms > ${SQL_BUDGET}ms`);
  if (failures.length > 0) {
    console.error(`scale budgets exceeded:\n- ${failures.join('\n- ')}`);
    process.exitCode = 1;
  }
} finally {
  if (!KEEP) fs.rmSync(root, { recursive: true, force: true });
  else console.error(`kept benchmark root: ${root}`);
}
