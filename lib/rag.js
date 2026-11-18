/**
 * RAG over the knowledge layer.
 *
 * Storage is **sharded**, not one big JSON file:
 *
 *   rag/manifest.json        meta + shard directory (written last, atomically)
 *   rag/shard-<category>.json  one independent file per knowledge category
 *   rag/.lock                short-lived writer lock
 *
 * Why:
 * - a rebuild only rewrites the shards whose content changed (unchanged shards
 *   keep their old file, verified by a content hash in the manifest);
 * - a search reads only the shards it needs (`category` filter) and never has
 *   to parse the whole corpus;
 * - every file is written to `<file>.tmp` then renamed, so a reader sees the
 *   old file or the new one, never a half-written one;
 * - readers retry once on a transient read error and tolerate a missing shard,
 *   while writers serialize through `<root>/rag/.lock` (stale locks expire).
 *
 * Each shard entry caches the document text plus its category/source, so a
 * search does not need to scan every knowledge JSON file to score vectors.
 * The old single-file `rag/index.json` format has been removed: only the
 * sharded layout is read, and any leftover legacy file is deleted on rebuild.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { embed, embedEndpoint, rerank } from './external.js';
import { normalizeProvenance } from './knowledge.js';

export const RAG_LAYOUT = 'sharded';
const MANIFEST_VERSION = 3;
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 3_000;

export const RAG_DEFAULTS = Object.freeze({
  // One embedding request per batch; large corpora stay under provider limits.
  batchSize: 16,
  // Candidates read from the index before the optional rerank pass.
  maxCandidates: 20,
  // Knowledge documents kept in one index (newest first).
  maxDocs: 500,
  // Cosine similarity at which two documents of the same category are treated
  // as near-duplicates. Only one of them is indexed (the newest one wins).
  dedupeSimilarity: 0.95,
});

/**
 * RAG needs **both** a dedicated embedding model and a dedicated rerank model.
 *
 * Falling back to the main chat model is deliberately not accepted here: a chat
 * model is rarely an embedding model, and embedding-only retrieval was the old
 * low-quality path. The panel/API refuse to mount RAG until both fields are set.
 */
export function ragModelStatus(config = {}) {
  const embedModel = String(config.externalEmbedModel ?? '').trim();
  const rerankModel = String(config.externalRerankModel ?? '').trim();
  const missing = [];
  if (embedModel === '') missing.push('Embedding 模型（externalEmbedModel）');
  if (rerankModel === '') missing.push('Rerank 模型（externalRerankModel）');
  return {
    ready: missing.length === 0,
    embedModel,
    rerankModel,
    missing,
  };
}

/** Path of the sharded manifest. */
export function ragManifestPath(root) {
  return path.join(root, 'rag', 'manifest.json');
}

/** Stable content hash used to skip unchanged documents and shards. */
export function textHash(text) {
  return crypto.createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 24);
}

/** Small synchronous sleep; only used for lock/read retries. */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy fallback */ }
  }
}

/** Read JSON, retrying once for a transient sharing/partial-read error. */
function readJsonRetry(file) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      if (attempt === 1) return null;
      sleepSync(15);
    }
  }
  return null;
}

/** Atomic write: temp file + rename, so readers never see a partial file. */
function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}

/** Category -> safe shard id (all current categories are already safe). */
function shardIdOf(category) {
  const id = String(category ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  return id !== '' ? id : 'misc';
}

/** Read the manifest when it is a valid sharded index. */
function readManifest(root) {
  const file = ragManifestPath(root);
  const data = readJsonRetry(file);
  if (!data || data.version !== MANIFEST_VERSION || data.layout !== RAG_LAYOUT
    || !Array.isArray(data.shards)) return null;
  if (typeof data.dim !== 'number' || data.dim <= 0) return null;
  return data;
}

/**
 * Identity of one embedding space: the provider endpoint plus the model name.
 *
 * Vectors are only comparable inside the same space. A different provider can
 * use the same model name with another dimension (or another vector space), so
 * the index records both and a rebuild never mixes old and new vectors.
 */
export function embeddingIdentity(endpoint) {
  const resolved = embedEndpoint(endpoint);
  return {
    endpoint: resolved.apiBase,
    model: resolved.model !== '' ? resolved.model : 'local',
  };
}

function mergeShards(root, manifest) {
  const docs = {};
  for (const shard of manifest.shards) {
    if (!shard || typeof shard.file !== 'string') continue;
    const data = readJsonRetry(path.join(root, 'rag', shard.file));
    if (!data || typeof data.docs !== 'object' || data.docs === null) continue;
    for (const [docId, entry] of Object.entries(data.docs)) {
      if (entry && Array.isArray(entry.vector) && entry.vector.length > 0) docs[docId] = entry;
    }
  }
  return {
    model: typeof manifest.model === 'string' ? manifest.model : '',
    endpoint: typeof manifest.endpoint === 'string' ? manifest.endpoint : '',
    dim: Number(manifest.dim) || 0,
    built_at: typeof manifest.built_at === 'string' ? manifest.built_at : '',
    docs,
  };
}

/**
 * Read one sharded index into the merged shape, or `null` when none exists.
 * Single-file indexes are no longer supported.
 */
export function readRagIndex(root) {
  const manifest = readManifest(root);
  if (!manifest) return null;
  return mergeShards(root, manifest);
}

/** Compact index metadata for the panel and `aim_memory action=status`. */
export function ragStats(root) {
  const manifest = readManifest(root);
  if (!manifest) {
    return {
      built: false, docs: 0, dim: 0, model: '', endpoint: '', built_at: '', shards: 0, deduped: 0, layout: '',
    };
  }
  return {
    built: true,
    docs: Number(manifest.count) || Object.keys(mergeShards(root, manifest).docs).length,
    dim: Number(manifest.dim) || 0,
    model: typeof manifest.model === 'string' ? manifest.model : '',
    endpoint: typeof manifest.endpoint === 'string' ? manifest.endpoint : '',
    built_at: typeof manifest.built_at === 'string' ? manifest.built_at : '',
    shards: manifest.shards.length,
    deduped: Number(manifest.deduped) || 0,
    layout: RAG_LAYOUT,
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

/** Cross-process writer lock; returns a release function. */
function acquireIndexLock(root) {
  const dir = path.join(root, 'rag');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.lock');
  const started = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      } finally {
        fs.closeSync(fd);
      }
      return () => { try { fs.unlinkSync(file); } catch { /* already gone */ } };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(file);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(file);
          continue;
        }
      } catch { /* lock disappeared between checks */ }
      if (Date.now() - started > LOCK_WAIT_MS) {
        throw new Error('等待 RAG 索引写锁超时（另一个进程正在写索引）');
      }
      sleepSync(20);
    }
  }
}

/**
 * Serialize builds per store inside this process; the file lock covers other
 * processes. Embedding happens before the lock is taken so a slow model does
 * not block readers for long.
 */
const buildQueues = new Map();

/**
 * Build or refresh one store's RAG index.
 *
 * Unchanged documents reuse their stored vector; unchanged shards reuse their
 * whole file. Any embedding failure aborts without touching the previous index.
 */
export async function buildRagIndex(store, endpoint, options = {}) {
  const root = store.root;
  const previous = buildQueues.get(root) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(() => buildRagIndexInner(store, endpoint, options));
  buildQueues.set(root, task);
  try {
    return await task;
  } finally {
    if (buildQueues.get(root) === task) buildQueues.delete(root);
  }
}

async function buildRagIndexInner(store, endpoint, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxDocs = Number.isInteger(options.maxDocs) && options.maxDocs > 0
    ? options.maxDocs : RAG_DEFAULTS.maxDocs;
  const docs = store.documents().slice(0, maxDocs);
  const identity = embeddingIdentity(endpoint);
  const previousManifest = readManifest(store.root);
  const previous = readRagIndex(store.root);
  const previousDocs = previous && previous.docs ? previous.docs : {};
  // Vectors are only comparable inside one embedding space. Reuse is disabled
  // when the provider endpoint or model changed, because the new service may
  // return another dimension (or another vector space for the same name).
  const reusable = Boolean(previousManifest
    && typeof previousManifest.endpoint === 'string'
    && previousManifest.endpoint === identity.endpoint
    && String(previousManifest.model ?? '') === identity.model
    && Number(previousManifest.dim) > 0);
  const expectedDim = reusable ? Number(previousManifest.dim) : 0;
  const changed = previousManifest !== null && !reusable;
  const next = new Map(); // doc_id -> full entry (text cached for fast search)
  let pending = [];

  for (const doc of docs) {
    const hash = textHash(doc.text);
    const cached = previousDocs[doc.doc_id];
    const entry = {
      hash,
      vector: null,
      text: doc.text,
      category: doc.category,
      source: doc.source,
      provenance: normalizeProvenance(doc.provenance, doc.source),
      verified: doc.verified === true,
      confidence: Number.isFinite(doc.confidence) ? doc.confidence : 0.8,
      changes_count: Array.isArray(doc.changes) ? doc.changes.length : 0,
      updated_at: doc.updated_at ?? '',
    };
    if (reusable && cached && cached.hash === hash
      && Array.isArray(cached.vector) && cached.vector.length === expectedDim) {
      entry.vector = cached.vector;
    } else {
      pending.push({ doc, hash, entry });
    }
    next.set(doc.doc_id, entry);
  }

  const embedRows = async (rows) => {
    for (let start = 0; start < rows.length; start += RAG_DEFAULTS.batchSize) {
      const batch = rows.slice(start, start + RAG_DEFAULTS.batchSize);
      const result = await embed(endpoint, batch.map((row) => row.doc.text), fetchImpl);
      if (!result.ok) return result;
      batch.forEach((row, offset) => {
        row.entry.vector = result.vectors[offset];
      });
    }
    return { ok: true };
  };
  const fail = (error) => ({
    ok: false,
    error,
    indexed: [...next.values()].filter((entry) => Array.isArray(entry.vector)).length,
    pending: pending.length,
  });
  const firstDim = () => {
    const entry = [...next.values()].find((row) => Array.isArray(row.vector) && row.vector.length > 0);
    return entry ? entry.vector.length : 0;
  };

  let embedded = pending.length;
  if (pending.length > 0) {
    const result = await embedRows(pending);
    if (!result.ok) return fail(result.error);
  }

  let dim = firstDim();
  // A server can change its output dimension even when the configured model
  // name stayed the same. Never write an index that mixes dimensions: re-embed
  // every document once at the observed dimension.
  if (dim > 0 && [...next.values()].some((entry) => !Array.isArray(entry.vector)
    || entry.vector.length !== dim)) {
    for (const entry of next.values()) entry.vector = null;
    pending = docs.map((doc) => ({ doc, hash: textHash(doc.text), entry: next.get(doc.doc_id) }));
    embedded = pending.length;
    const result = await embedRows(pending);
    if (!result.ok) return fail(result.error);
    dim = firstDim();
  }
  const missing = [...next.values()].filter((entry) => !Array.isArray(entry.vector) || entry.vector.length === 0);
  if (missing.length > 0) {
    return fail(`嵌入结果不完整：${missing.length} 篇没有向量，索引未更新（旧的索引保持不变）`);
  }
  if (dim > 0 && [...next.values()].some((entry) => entry.vector.length !== dim)) {
    return fail(`嵌入维度不一致：同一索引里出现了 ${dim}d 与其他维度的向量，索引未更新`);
  }

  // Semantic de-duplication: knowledge docs are short one-line conclusions, so
  // near-identical wording from different turns/scopes is common. Compare each
  // document with the already-kept documents of the same category and keep only
  // the newest representative. This is an index-level filter: the knowledge
  // base itself is untouched, and BM25 still sees every document.
  const deduped = [];
  const keptByCategory = new Map();
  for (const [docId, entry] of [...next.entries()]) {
    const categoryId = shardIdOf(entry.category);
    const kept = keptByCategory.get(categoryId) ?? [];
    let duplicateOf = '';
    let bestScore = 0;
    for (const candidate of kept) {
      const score = cosine(entry.vector, candidate.vector);
      if (score > bestScore) bestScore = score;
      if (score >= RAG_DEFAULTS.dedupeSimilarity) {
        duplicateOf = candidate.doc_id;
        break;
      }
    }
    if (duplicateOf !== '') {
      deduped.push({
        doc_id: docId,
        duplicate_of: duplicateOf,
        similarity: Number(bestScore.toFixed(4)),
      });
      next.delete(docId);
    } else {
      kept.push({ doc_id: docId, vector: entry.vector });
      keptByCategory.set(categoryId, kept);
    }
  }

  // Group entries into one shard per category.
  const shards = new Map();
  for (const [docId, entry] of next) {
    const id = shardIdOf(entry.category);
    if (!shards.has(id)) shards.set(id, { id, docs: {} });
    shards.get(id).docs[docId] = entry;
  }

  const release = acquireIndexLock(store.root);
  try {
    const previousManifest = readManifest(store.root);
    const previousShards = new Map(
      (previousManifest?.shards ?? []).map((shard) => [shard.id, shard]),
    );
    const manifestShards = [];
    const dir = path.join(store.root, 'rag');
    for (const [id, shard] of shards) {
      const payload = JSON.stringify({ id, version: MANIFEST_VERSION, docs: shard.docs });
      const hash = textHash(payload);
      const file = `shard-${id}.json`;
      const old = previousShards.get(id);
      if (!old || old.hash !== hash) {
        writeJsonAtomic(path.join(dir, file), payload);
      }
      manifestShards.push({ id, file, docs: Object.keys(shard.docs).length, hash });
    }
    // Remove shard files that are no longer referenced.
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith('shard-') || !name.endsWith('.json')) continue;
        if (!manifestShards.some((shard) => shard.file === name)) {
          fs.rmSync(path.join(dir, name), { force: true });
        }
      }
    } catch { /* a missing dir cannot happen here; keep going */ }

    const manifest = {
      version: MANIFEST_VERSION,
      layout: RAG_LAYOUT,
      model: identity.model,
      endpoint: identity.endpoint,
      dim,
      built_at: new Date().toISOString(),
      count: next.size,
      deduped: deduped.length,
      shards: manifestShards,
    };
    writeJsonAtomic(ragManifestPath(store.root), JSON.stringify(manifest));
    // The single-file layout is gone for good; remove any leftover file.
    try { fs.rmSync(path.join(store.root, 'rag', 'index.json'), { force: true }); } catch { /* optional */ }
  } finally {
    release();
  }
  return {
    ok: true,
    indexed: next.size,
    embedded,
    deduped: deduped.length,
    duplicates: deduped.slice(0, 20),
    removed: Object.keys(previousDocs).filter((docId) => !next.has(docId)).length,
    dim,
    model: identity.model,
    endpoint: identity.endpoint,
    changed,
    shards: shards.size,
  };
}

/**
 * Score one store's indexed knowledge against a precomputed query vector.
 *
 * Entries carry their own text/category, so no knowledge-file scan is needed
 * for the common case; legacy entries fall back to `store.documents()`.
 */
export function ragCandidates(store, queryVector, options = {}) {
  const index = readRagIndex(store.root);
  if (!index) return { ok: false, reason: 'no-index', candidates: [] };
  const queryDim = Array.isArray(queryVector) ? queryVector.length : 0;
  if (queryDim === 0) return { ok: false, reason: 'empty-query', candidates: [] };
  const indexDim = Number(index.dim) || 0;
  // A provider switch can change the embedding dimension. Comparing vectors of
  // different lengths is meaningless (cosine returns 0), so report the mismatch
  // instead of silently returning an empty/arbitrary result.
  if (indexDim > 0 && indexDim !== queryDim) {
    return {
      ok: false,
      reason: 'dim-mismatch',
      indexDim,
      queryDim,
      indexModel: typeof index.model === 'string' ? index.model : '',
      indexEndpoint: typeof index.endpoint === 'string' ? index.endpoint : '',
      candidates: [],
    };
  }
  if (options.model !== undefined) {
    const indexModel = typeof index.model === 'string' ? index.model : '';
    if (indexModel !== String(options.model)) {
      return {
        ok: false,
        reason: 'model-mismatch',
        indexModel,
        currentModel: String(options.model),
        candidates: [],
      };
    }
  }
  if (options.endpoint !== undefined) {
    const indexEndpoint = typeof index.endpoint === 'string' ? index.endpoint : '';
    // Older manifests predate the endpoint field; keep them searchable and let
    // the next rebuild fill it in (the dimension/model checks above still run).
    if (indexEndpoint !== '' && indexEndpoint !== String(options.endpoint)) {
      return {
        ok: false,
        reason: 'endpoint-mismatch',
        indexEndpoint,
        currentEndpoint: String(options.endpoint),
        candidates: [],
      };
    }
  }
  const limit = Number.isInteger(options.topK) && options.topK > 0 ? options.topK : RAG_DEFAULTS.maxCandidates;
  const category = typeof options.category === 'string' && options.category !== '' ? options.category : null;
  let docMap = null;
  const lookupDoc = (docId) => {
    if (docMap === null) docMap = new Map(store.documents().map((doc) => [doc.doc_id, doc]));
    return docMap.get(docId);
  };
  const scored = [];
  let skipped = 0;
  for (const [docId, entry] of Object.entries(index.docs)) {
    if (!entry || !Array.isArray(entry.vector) || entry.vector.length !== queryVector.length) {
      skipped += 1;
      continue;
    }
    let doc = {
      doc_id: docId,
      text: entry.text,
      category: entry.category,
      source: entry.source,
      updated_at: entry.updated_at ?? '',
      changes_count: Number.isInteger(entry.changes_count) ? entry.changes_count : null,
    };
    // Shards built before provenance was cached do not have these fields.
    // Infer them from the source so an old model-authored document cannot enter
    // the rerank pool as an unmarked fact.
    const provenance = normalizeProvenance(entry.provenance, entry.source);
    doc.provenance = provenance;
    doc.verified = typeof entry.verified === 'boolean' ? entry.verified : provenance !== 'model';
    if (Number.isFinite(entry.confidence)) {
      doc.confidence = entry.confidence;
    } else {
      // Shards built before confidence was cached: recover it from the JSON base
      // once; a missing value stays neutral.
      const stored = lookupDoc(docId);
      doc.confidence = Number.isFinite(stored?.confidence) ? stored.confidence : 0.8;
    }
    if (!Number.isInteger(doc.changes_count)) {
      const stored = lookupDoc(docId);
      doc.changes_count = Array.isArray(stored?.changes) ? stored.changes.length : 0;
    }
    if (typeof doc.text !== 'string' || typeof doc.category !== 'string') {
      const stored = lookupDoc(docId);
      if (!stored) continue;
      doc = stored;
    }
    if (category !== null && doc.category !== category) continue;
    const score = cosine(queryVector, entry.vector);
    if (score <= 0) continue;
    scored.push({ doc, score });
  }
  if (skipped > 0 && scored.length === 0) {
    return { ok: false, reason: 'dim-mismatch', indexDim, queryDim, skipped, candidates: [] };
  }
  scored.sort((left, right) => right.score - left.score);
  return { ok: true, candidates: scored.slice(0, limit), skipped };
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
