/**
 * RAG over the knowledge layer.
 *
 * The knowledge files stay the source of truth: this module only keeps a cache
 * of their embeddings in `rag/index.json`, rebuilt incrementally by `aim_memory
 * action=index` and used by `aim_search` **while the RAG mount switch is on**.
 * Turning the switch off never touches data; retrieval simply goes back to the
 * local BM25 + hash-vector path, so the feature is fully reversible.
 *
 * No embedding happens at query time beyond the single query vector; if the
 * rerank service is unavailable the embedding order is returned as-is.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { embed, rerank } from './external.js';

export const RAG_VERSION = 1;
export const RAG_DEFAULTS = Object.freeze({
  // One embedding request per batch; large corpora stay under provider limits.
  batchSize: 16,
  // Candidates read from the index before the optional rerank pass.
  maxCandidates: 20,
  // Knowledge documents kept in one index (newest first).
  maxDocs: 500,
});

/** Path of the RAG index for one memory store. */
export function ragIndexPath(root) {
  return path.join(root, 'rag', 'index.json');
}

/** Stable content hash used to skip unchanged documents on rebuild. */
export function textHash(text) {
  return crypto.createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 24);
}

/** Read one index, or `null` when it is missing or unreadable. */
export function readRagIndex(root) {
  const file = ragIndexPath(root);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || data.version !== RAG_VERSION || typeof data.docs !== 'object' || data.docs === null) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/** Compact index metadata for the panel and `aim_memory action=status`. */
export function ragStats(root) {
  const index = readRagIndex(root);
  if (!index) return { built: false, docs: 0, dim: 0, model: '', built_at: '' };
  return {
    built: true,
    docs: Object.keys(index.docs).length,
    dim: Number(index.dim) || 0,
    model: typeof index.model === 'string' ? index.model : '',
    built_at: typeof index.built_at === 'string' ? index.built_at : '',
  };
}

/** Cosine similarity; `0` for unusable vectors. */
export function cosine(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || left.length !== right.length) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

/**
 * Build or refresh one store's RAG index.
 *
 * Unchanged documents (same text hash) reuse their stored vector, so a rebuild
 * after adding a few knowledge entries only pays for the new ones. Any embedding
 * failure aborts without overwriting the previous index.
 *
 * @param {import('./store.js').MemoryStore} store
 * @param {object} endpoint normalized external endpoint
 * @param {{fetchImpl?: Function, maxDocs?: number}} [options]
 */
export async function buildRagIndex(store, endpoint, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxDocs = Number.isInteger(options.maxDocs) && options.maxDocs > 0
    ? options.maxDocs : RAG_DEFAULTS.maxDocs;
  const docs = store.documents().slice(0, maxDocs);
  const previous = readRagIndex(store.root);
  const previousDocs = previous && previous.docs ? previous.docs : {};
  const next = {};
  const pending = [];

  for (const doc of docs) {
    const hash = textHash(doc.text);
    const cached = previousDocs[doc.doc_id];
    if (cached && cached.hash === hash && Array.isArray(cached.vector) && cached.vector.length > 0) {
      next[doc.doc_id] = { hash, vector: cached.vector };
    } else {
      pending.push({ doc, hash });
    }
  }

  let dim = next[Object.keys(next)[0]]?.vector.length ?? (Number(previous?.dim) || 0);
  for (let start = 0; start < pending.length; start += RAG_DEFAULTS.batchSize) {
    const batch = pending.slice(start, start + RAG_DEFAULTS.batchSize);
    const result = await embed(endpoint, batch.map((row) => row.doc.text), fetchImpl);
    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
        indexed: Object.keys(next).length,
        pending: pending.length,
      };
    }
    batch.forEach((row, offset) => {
      const vector = result.vectors[offset];
      next[row.doc.doc_id] = { hash: row.hash, vector };
      dim = vector.length;
    });
  }

  // Old entries for documents that no longer exist must not linger.
  const removed = Object.keys(previousDocs).filter((docId) => !Object.hasOwn(next, docId)).length;
  const file = ragIndexPath(store.root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({
    version: RAG_VERSION,
    model: endpoint.model !== '' ? endpoint.model : 'local',
    dim,
    built_at: new Date().toISOString(),
    docs: next,
  }));
  fs.renameSync(tmp, file);
  return {
    ok: true,
    indexed: Object.keys(next).length,
    embedded: pending.length,
    removed,
    dim,
    model: endpoint.model !== '' ? endpoint.model : 'local',
  };
}

/**
 * Score one store's indexed knowledge against a precomputed query vector.
 *
 * The query vector is passed in (not embedded here) because `aim_search` spans
 * several conversation stores and the query must be embedded only once.
 */
export function ragCandidates(store, queryVector, options = {}) {
  const index = readRagIndex(store.root);
  if (!index) return { ok: false, reason: 'no-index', candidates: [] };
  const limit = Number.isInteger(options.topK) && options.topK > 0 ? options.topK : RAG_DEFAULTS.maxCandidates;
  const category = typeof options.category === 'string' && options.category !== '' ? options.category : null;
  const docs = new Map(store.documents().map((doc) => [doc.doc_id, doc]));
  const scored = [];
  for (const [docId, entry] of Object.entries(index.docs)) {
    const doc = docs.get(docId);
    if (!doc) continue;
    if (category !== null && doc.category !== category) continue;
    const score = cosine(queryVector, entry.vector);
    if (score <= 0) continue;
    scored.push({ doc, score });
  }
  scored.sort((left, right) => right.score - left.score);
  return { ok: true, candidates: scored.slice(0, limit) };
}

/**
 * Optional rerank pass over candidates collected from one or more stores.
 * Falls back to the embedding order when the service is unavailable.
 */
export async function rerankCandidates(endpoint, query, candidates, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const topK = Number.isInteger(options.topK) && options.topK > 0 ? options.topK : 5;
  if (candidates.length === 0) return { ok: true, hits: [], via: 'embedding' };
  const documents = candidates.map((row) => row.doc.text);
  const reranked = await rerank(endpoint, { query, documents, topN: Math.min(candidates.length, topK) }, fetchImpl);
  if (reranked.ok) {
    const hits = reranked.results
      .filter((row) => Number.isInteger(row.index) && candidates[row.index])
      .map((row) => ({ ...candidates[row.index], score: row.score }));
    return { ok: true, hits, via: 'rerank' };
  }
  return {
    ok: true,
    hits: candidates.slice(0, topK).map((row) => ({ ...row, score: row.score })),
    via: 'embedding',
    rerankError: reranked.error,
  };
}
