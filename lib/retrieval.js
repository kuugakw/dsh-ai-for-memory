/**
 * Local knowledge retrieval: BM25 keywords + a hashing-trick vector space.
 *
 * This mirrors the retrieval layer of AI for Memory: no network, no
 * embedding service, deterministic across processes. It is a bag-of-words
 * vector, not a semantic model — that limitation is documented in the README.
 */

/** Vector width used by both documents and queries. */
export const VECTOR_DIM = 128;

const HAN = '\\u3400-\\u9fff\\uf900-\\ufaff';
const TOKEN_RE = new RegExp(`([${HAN}]+)|([a-z0-9_]+)`, 'g');

/**
 * Tokenize text into Latin words and Chinese uni/bi-grams.
 *
 * Uni-grams keep recall acceptable when the user types a single character;
 * bi-grams keep precision for normal words. Both are cheap and deterministic.
 */
export function tokenize(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const tokens = [];
  const input = text.toLowerCase();
  TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = TOKEN_RE.exec(input)) !== null) {
    if (match[1]) {
      const run = match[1];
      for (const ch of run) tokens.push(ch);
      for (let i = 0; i + 1 < run.length; i += 1) tokens.push(run.slice(i, i + 2));
    } else {
      tokens.push(match[2]);
    }
  }
  return tokens;
}

/** FNV-1a 32-bit hash: stable across processes and platforms. */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** TF vector with L2 normalization. */
export function buildVector(text) {
  const vec = new Float64Array(VECTOR_DIM);
  for (const token of tokenize(text)) {
    vec[fnv1a(token) % VECTOR_DIM] += 1;
  }
  let norm = 0;
  for (let i = 0; i < VECTOR_DIM; i += 1) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < VECTOR_DIM; i += 1) vec[i] /= norm;
  }
  return vec;
}

/** Cosine similarity; `0` when either side is empty. */
export function cosine(a, b) {
  if (!a || !b) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < VECTOR_DIM; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Build an in-memory BM25 index from knowledge documents. */
export function buildIndex(docs) {
  const postings = new Map();
  const lengths = new Map();
  let totalLength = 0;
  for (const doc of docs) {
    const tokens = tokenize(doc.text);
    lengths.set(doc.doc_id, tokens.length);
    totalLength += tokens.length;
    const termFreq = new Map();
    for (const token of tokens) termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
    for (const [term, freq] of termFreq) {
      let posting = postings.get(term);
      if (!posting) {
        posting = new Map();
        postings.set(term, posting);
      }
      posting.set(doc.doc_id, freq);
    }
  }
  const n = docs.length;
  return { postings, lengths, n, avgLength: n > 0 ? totalLength / n : 0 };
}

const K1 = 1.5;
const B = 0.75;

/** BM25 score of one document for already-tokenized query terms. */
export function bm25Score(index, queryTokens, docId) {
  const length = index.lengths.get(docId) ?? 0;
  if (length === 0 || queryTokens.length === 0) return 0;
  const avg = index.avgLength || 1;
  let score = 0;
  for (const term of queryTokens) {
    const posting = index.postings.get(term);
    if (!posting) continue;
    const tf = posting.get(docId) ?? 0;
    if (tf === 0) continue;
    const df = posting.size;
    const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5));
    score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (length / avg))));
  }
  return score;
}

/**
 * Search knowledge documents.
 *
 * @param {Array<{doc_id: string, text: string, category: string}>} docs
 * @param {string} query
 * @param {{topK?: number, category?: string|null, mode?: 'bm25'|'vector'|'hybrid'}} options
 * @returns {Array<object>} hits sorted by score, zero-score documents removed.
 */
export function search(docs, query, options = {}) {
  const topK = Number.isInteger(options.topK) && options.topK > 0 ? options.topK : 5;
  const mode = options.mode ?? 'hybrid';
  if (!['bm25', 'vector', 'hybrid'].includes(mode)) {
    throw new Error(`mode 必须是 bm25 / vector / hybrid，收到：${mode}`);
  }
  if (typeof query !== 'string' || query.trim() === '') return [];

  const filtered = options.category
    ? docs.filter((doc) => doc.category === options.category)
    : docs;
  if (filtered.length === 0) return [];

  const index = buildIndex(filtered);
  const queryTokens = tokenize(query);
  const queryVector = mode === 'bm25' ? null : buildVector(query);

  const bm25 = new Map();
  for (const doc of filtered) bm25.set(doc.doc_id, bm25Score(index, queryTokens, doc.doc_id));
  const bm25Values = [...bm25.values()];
  const maxBm25 = Math.max(...bm25Values);
  const minBm25 = Math.min(...bm25Values);

  const hits = [];
  for (const doc of filtered) {
    const keyword = bm25.get(doc.doc_id) ?? 0;
    const vector = queryVector ? cosine(queryVector, buildVector(doc.text)) : 0;
    const confidence = Number.isFinite(doc.confidence)
      ? Math.min(1, Math.max(0, doc.confidence))
      : 0.8;
    let score;
    if (mode === 'bm25') {
      score = keyword;
    } else if (mode === 'vector') {
      score = vector;
    } else {
      const normalized = maxBm25 > minBm25 ? (keyword - minBm25) / (maxBm25 - minBm25) : 0;
      score = 0.6 * normalized + 0.4 * Math.max(0, vector);
    }
    // Confidence is not a separate ranking channel; it is a bounded modifier so
    // a 0.4-confidence claim cannot outrank a 0.9-confidence fact at equal
    // relevance, while relevance still dominates.
    score *= 0.85 + 0.15 * confidence;
    // Model-authored statements are leads, not confirmed project facts. Keep
    // them retrievable but never let them outrank user/verified knowledge.
    const provenance = typeof doc.provenance === 'string' ? doc.provenance : 'authored';
    const verified = doc.verified === true;
    const unverified = provenance === 'model' && !verified;
    if (unverified) score *= 0.35;
    if (score > 0) {
      hits.push({
        doc_id: doc.doc_id,
        category: doc.category,
        text: doc.text,
        source: typeof doc.source === 'string' ? doc.source : '',
        url: typeof doc.url === 'string' ? doc.url : '',
        tags: Array.isArray(doc.tags) ? doc.tags : [],
        provenance,
        verified,
        unverified,
        confidence,
        changes_count: Array.isArray(doc.changes) ? doc.changes.length : 0,
        score,
        bm25_score: keyword,
        vector_score: vector,
      });
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}

/** Reciprocal-rank-fusion constant. 60 is the value from the original RRF paper. */
export const RRF_K = 60;

/**
 * Fuse several ranked channels with Reciprocal Rank Fusion.
 *
 * RRF only looks at ranks, so a channel whose scores are on a different scale
 * (cosine vs BM25) cannot dominate by accident. A document present in only one
 * channel still gets a score, which is how a document that was deduplicated out
 * of the RAG index remains reachable through the local BM25 channel.
 *
 * @param {Array<{name: string, rows: object[]}>} lists - ranked, best first.
 * @param {{k?: number, keyOf?: (row: object) => string}} [options]
 * @returns {object[]} fused rows sorted by `rrf_score`, with `rrf_ranks`.
 */
export function reciprocalRankFusion(lists, options = {}) {
  const k = Number.isInteger(options.k) && options.k > 0 ? options.k : RRF_K;
  const keyOf = typeof options.keyOf === 'function'
    ? options.keyOf
    : (row) => `${row?.origin_key ?? ''}:${row?.doc_id ?? ''}`;
  const fused = new Map();
  for (const list of Array.isArray(lists) ? lists : []) {
    const name = typeof list?.name === 'string' && list.name !== '' ? list.name : 'channel';
    const rows = Array.isArray(list?.rows) ? list.rows : [];
    rows.forEach((row, index) => {
      if (!row || typeof row !== 'object') return;
      const key = keyOf(row);
      if (key === '' || key === ':') return;
      let entry = fused.get(key);
      if (!entry) {
        entry = { ...row, rrf_score: 0, rrf_ranks: {} };
        fused.set(key, entry);
      } else {
        // Keep the first row's text/metadata, but do not lose fields the other
        // channel carries (changes_count, provenance, ...).
        for (const [field, value] of Object.entries(row)) {
          if (entry[field] === undefined) entry[field] = value;
        }
      }
      entry.rrf_score += 1 / (k + index + 1);
      entry.rrf_ranks[name] = index + 1;
      if (name === 'rag' && Number.isFinite(row.score)) entry.rag_score = row.score;
      if (name === 'local' && Number.isFinite(row.score)) entry.local_score = row.score;
    });
  }
  return [...fused.values()].sort((left, right) => right.rrf_score - left.rrf_score);
}
