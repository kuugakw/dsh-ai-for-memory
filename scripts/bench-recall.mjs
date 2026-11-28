#!/usr/bin/env node
/**
 * Recall benchmark: does the retriever put the right memory in the top K?
 *
 * The corpus and queries live in scripts/recall-dataset.mjs. Each query has one
 * verified target and some have a near-miss, an unverified model claim, or a
 * distractor that repeats the query words with the wrong answer. We report
 * Recall@1/3/5, MRR and nDCG@10 for bm25, vector and hybrid, plus how often an
 * unverified claim leaks into the top 3.
 *
 *   node scripts/bench-recall.mjs [--json] [--topk=10]
 *
 * This is a benchmark, not a test: ranking quality changes are reported, not
 * asserted. Run it before/after touching tokenization, RRF or the unverified
 * penalty, and put the numbers in docs/recall-benchmark.md.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { MemoryStore } from '../lib/store.js';
import { DOCS, QUERIES } from './recall-dataset.mjs';

const JSON_OUT = process.argv.includes('--json');
const TOP_K = Number(process.argv.find((value) => value.startsWith('--topk='))?.slice(7) ?? 10);
const MODES = ['bm25', 'vector', 'hybrid'];
const KINDS = ['exact', 'paraphrase', 'trap', 'provenance'];

function rankOf(hits, target) {
  const index = hits.findIndex((hit) => hit.doc_id === target);
  return index === -1 ? Infinity : index + 1;
}

function ndcgAt(hits, target, k) {
  const rank = rankOf(hits, target);
  return rank <= k ? 1 / Math.log2(rank + 1) : 0;
}

function seed(root) {
  const dir = path.join(root, 'knowledge');
  fs.mkdirSync(dir, { recursive: true });
  for (const doc of DOCS) {
    fs.writeFileSync(path.join(dir, `${doc.doc_id}.json`), `${JSON.stringify(doc)}\n`);
  }
}

function summarize(results) {
  const n = results.length || 1;
  const at = (k) => results.filter((row) => row.rank <= k).length / n;
  return {
    recall1: at(1),
    recall3: at(3),
    recall5: at(5),
    mrr: results.reduce((sum, row) => sum + (row.rank <= TOP_K ? 1 / row.rank : 0), 0) / n,
    ndcg: results.reduce((sum, row) => sum + row.ndcg, 0) / n,
    avgMs: results.reduce((sum, row) => sum + row.ms, 0) / n,
  };
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-recall-'));
try {
  const store = new MemoryStore(root).init();
  seed(root);
  const docs = store.documents();
  if (docs.length !== DOCS.length) throw new Error(`seeded ${docs.length}, expected ${DOCS.length}`);
  const known = new Set(DOCS.map((doc) => doc.doc_id));
  for (const query of QUERIES) {
    if (!known.has(query.target)) throw new Error(`${query.id} targets missing doc ${query.target}`);
  }

  const perMode = {};
  const perQuery = [];
  for (const mode of MODES) {
    perMode[mode] = [];
    for (const query of QUERIES) {
      const started = performance.now();
      const hits = store.search(query.text, { mode, topK: TOP_K });
      const ms = performance.now() - started;
      const rank = rankOf(hits, query.target);
      const unverifiedTop3 = hits.slice(0, 3).some((hit) => hit.unverified === true);
      const row = { query: query.id, kind: query.kind, mode, target: query.target, rank, ms, ndcg: ndcgAt(hits, query.target, TOP_K), unverifiedTop3 };
      perMode[mode].push(row);
      perQuery.push(row);
    }
  }

  const summary = Object.fromEntries(MODES.map((mode) => [mode, summarize(perMode[mode])]));
  const byKind = {};
  for (const kind of KINDS) {
    byKind[kind] = Object.fromEntries(MODES.map((mode) => [
      mode,
      summarize(perMode[mode].filter((row) => row.kind === kind)),
    ]));
  }
  const provenanceRows = perMode.hybrid.filter((row) => row.kind === 'provenance');
  const unverifiedRate = provenanceRows.length === 0
    ? 0
    : provenanceRows.filter((row) => row.unverifiedTop3).length / provenanceRows.length;

  const result = {
    docs: docs.length,
    queries: QUERIES.length,
    topK: TOP_K,
    summary,
    byKind,
    unverifiedTop3Rate: { hybrid: unverifiedRate },
    perQuery,
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`recall benchmark: ${docs.length} memories, ${QUERIES.length} queries, top${TOP_K}`);
    console.log('');
    console.log('mode     R@1      R@3      R@5      MRR      nDCG     avg ms');
    for (const mode of MODES) {
      const s = summary[mode];
      console.log([
        mode.padEnd(8),
        pct(s.recall1).padStart(7),
        pct(s.recall3).padStart(7),
        pct(s.recall5).padStart(7),
        s.mrr.toFixed(3).padStart(7),
        s.ndcg.toFixed(3).padStart(7),
        s.avgMs.toFixed(2).padStart(7),
      ].join('  '));
    }
    console.log('');
    console.log('by kind (hybrid)');
    for (const kind of KINDS) {
      const s = byKind[kind].hybrid;
      console.log(`${kind.padEnd(12)} R@1 ${pct(s.recall1).padStart(6)}  R@3 ${pct(s.recall3).padStart(6)}  R@5 ${pct(s.recall5).padStart(6)}  MRR ${s.mrr.toFixed(3)}`);
    }
    console.log('');
    console.log(`unverified claims in top-3 (hybrid, provenance queries): ${pct(unverifiedRate)}`);
    const misses = perMode.hybrid.filter((row) => row.rank > 5);
    if (misses.length > 0) {
      console.log('');
      console.log('hybrid misses outside top-5:');
      for (const row of misses) {
        console.log(`  ${row.query} (${row.kind}) rank=${row.rank === Infinity ? 'miss' : row.rank} target=${row.target}`);
      }
    }
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
