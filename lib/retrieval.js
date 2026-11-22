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

/** TF vector over already-tokenized input; L2 normalized. */
export function buildVectorFromTokens(tokens) {
  const vec = new Float64Array(VECTOR_DIM);
  for (const token of tokens) {
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

/** TF vector with L2 normalization. */
export function buildVector(text) {
  return buildVectorFromTokens(tokenize(text));
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

/** A fresh mutable index entry (postings + per-document bookkeeping). */
function newIndexEntry() {
  return {
    postings: new Map(),
    lengths: new Map(),
    n: 0,
    totalLength: 0,
    avgLength: 0,
    // Snapshot used to update the index incrementally: one write removes and
    // re-adds that document's postings instead of rebuilding the whole library.
    versions: new Map(),
    docTokens: new Map(),
  };
}

function addIndexDoc(entry, doc) {
  const tokens = tokensFor(doc);
  const id = doc.doc_id;
  entry.docTokens.set(id, tokens);
  entry.versions.set(id, docVersion(doc));
  entry.lengths.set(id, tokens.length);
  entry.n += 1;
  entry.totalLength += tokens.length;
  for (const token of tokens) {
    let posting = entry.postings.get(token);
    if (!posting) {
      posting = new Map();
      entry.postings.set(token, posting);
    }
    posting.set(id, (posting.get(id) ?? 0) + 1);
  }
}

function removeIndexDoc(entry, id) {
  const tokens = entry.docTokens.get(id);
  if (!tokens) return;
  for (const token of tokens) {
    const posting = entry.postings.get(token);
    if (!posting) continue;
    const freq = posting.get(id);
    if (freq === undefined) continue;
    if (freq <= 1) {
      posting.delete(id);
      if (posting.size === 0) entry.postings.delete(token);
    } else {
      posting.set(id, freq - 1);
    }
  }
  entry.lengths.delete(id);
  entry.totalLength -= tokens.length;
  entry.n -= 1;
  entry.docTokens.delete(id);
  entry.versions.delete(id);
}

function applyIndexDocs(entry, docs) {
  const current = new Map();
  for (const doc of docs) current.set(doc.doc_id, doc);
  // Remove changed/deleted documents first, so a rewrite is one removal plus
  // one addition, not a full rebuild.
  for (const [id, version] of [...entry.versions]) {
    const doc = current.get(id);
    if (!doc || docVersion(doc) !== version) removeIndexDoc(entry, id);
  }
  for (const doc of docs) {
    if (entry.versions.get(doc.doc_id) !== docVersion(doc)) addIndexDoc(entry, doc);
  }
  entry.avgLength = entry.n > 0 ? entry.totalLength / entry.n : 0;
}

/** Build an in-memory BM25 index from knowledge documents. */
export function buildIndex(docs) {
  const entry = newIndexEntry();
  for (const doc of docs) addIndexDoc(entry, doc);
  entry.avgLength = entry.n > 0 ? entry.totalLength / entry.n : 0;
  return {
    postings: entry.postings,
    lengths: entry.lengths,
    n: entry.n,
    avgLength: entry.avgLength,
  };
}

const K1 = 1.5;
const B = 0.75;

/**
 * Four caches, all LRU:
 * - per-document tokens/vectors: a write only recomputes the changed document;
 * - the inverted index is mutable and updated in place (see applyIndexDocs), so
 *   one write removes and re-adds that document's postings instead of
 *   rebuilding the whole library;
 * - the library vector map is the fast path over those per-document vectors.
 *
 * LRU matters here: `lruGet` refreshes insertion order, so a hot library index
 * survives a burst of one-off lookups. Plain `map.delete(map.keys().next())`
 * would evict the hot entry first.
 */
const TOKEN_CACHE = new Map();
const VECTOR_CACHE = new Map();
const INDEX_CACHE = new Map();
const LIBRARY_VECTOR_CACHE = new Map();
const CACHE_MAX = 4000;
const LIBRARY_CACHE_MAX = 12;

function lruGet(map, key) {
  if (!map.has(key)) return undefined;
  const value = map.get(key);
  map.delete(key);
  map.set(key, value);
  return value;
}

function lruSet(map, key, value, max) {
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

/**
 * Cache key: one library (store root) per category. Without the scope, two
 * independent stores with the same category would remove and re-add each
 * other's documents on every search.
 */
function libraryKey(category, scope) {
  return JSON.stringify([String(scope ?? ''), category ?? null]);
}

function indexFor(docs, category, scope) {
  const key = libraryKey(category, scope);
  let entry = lruGet(INDEX_CACHE, key);
  if (!entry) {
    entry = newIndexEntry();
    lruSet(INDEX_CACHE, key, entry, LIBRARY_CACHE_MAX);
  }
  applyIndexDocs(entry, docs);
  return entry;
}

function libraryVectorsFor(docs, category, scope) {
  const key = libraryKey(category, scope);
  let entry = lruGet(LIBRARY_VECTOR_CACHE, key);
  if (!entry) {
    entry = { vectors: new Map(), versions: new Map() };
    lruSet(LIBRARY_VECTOR_CACHE, key, entry, LIBRARY_CACHE_MAX);
  }
  const current = new Map();
  for (const doc of docs) current.set(doc.doc_id, doc);
  for (const [id, version] of [...entry.versions]) {
    const doc = current.get(id);
    if (!doc || docVersion(doc) !== version) {
      entry.vectors.delete(id);
      entry.versions.delete(id);
    }
  }
  for (const doc of docs) {
    const version = docVersion(doc);
    if (entry.versions.get(doc.doc_id) !== version) {
      entry.vectors.set(doc.doc_id, vectorFor(doc));
      entry.versions.set(doc.doc_id, version);
    }
  }
  return entry.vectors;
}

function docVersion(doc) {
  const stamp = String(doc.updated_at ?? '');
  // Normal knowledge writes always carry updated_at and revision, and revision
  // is bumped whenever the sentence changes. The revision matters: a
  // same-millisecond rewrite can keep the same text length (for example both
  // "8080" and "8081" are four characters), so a timestamp+length key would
  // silently reuse the old tokens/vector. Documents from older versions that
  // have no revision fall back to hashing the text.
  if (stamp !== '' && Number.isInteger(doc.revision)) {
    return `${stamp}:${doc.revision}`;
  }
  return `h:${fnv1a(String(doc.text ?? ''))}`;
}

function docCacheKey(doc) {
  return `${doc.doc_id}\u0000${docVersion(doc)}`;
}

function tokensFor(doc) {
  const key = docCacheKey(doc);
  const cached = lruGet(TOKEN_CACHE, key);
  if (cached) return cached;
  const tokens = tokenize(String(doc.text ?? ''));
  lruSet(TOKEN_CACHE, key, tokens, CACHE_MAX);
  return tokens;
}

function vectorFor(doc) {
  const key = docCacheKey(doc);
  const cached = lruGet(VECTOR_CACHE, key);
  if (cached) return cached;
  const vector = buildVector(String(doc.text ?? ''));
  lruSet(VECTOR_CACHE, key, vector, CACHE_MAX);
  return vector;
}

/** A short, query-centered excerpt. The full text stays behind doc_id. */
export function snippetOf(text, query, maxChars = 240) {
  const value = String(text ?? '');
  if (value.length <= maxChars) return value;
  const tokens = tokenize(String(query ?? '')).filter((token) => token.length >= 1);
  const lower = value.toLowerCase();
  const findFirst = (candidates) => {
    let at = -1;
    for (const token of candidates) {
      const found = lower.indexOf(token.toLowerCase());
      if (found >= 0 && (at < 0 || found < at)) at = found;
    }
    return at;
  };
  // Chinese single characters are excellent recall terms but terrible
  // snippet anchors: 网/时 almost always appear before the actual phrase.
  // Prefer bigrams/Latin words; only fall back to single characters when no
  // multi-character token occurs.
  const precise = tokens.filter((token) => token.length >= 2);
  let at = precise.length > 0 ? findFirst(precise) : -1;
  if (at < 0) at = findFirst(tokens);
  const start = at < 0 ? 0 : Math.max(0, at - Math.floor(maxChars * 0.35));
  const end = Math.min(value.length, start + maxChars);
  return `${start > 0 ? '…' : ''}${value.slice(start, end)}${end < value.length ? '…' : ''}`;
}

/**
 * The single summary implementation. `search()` and `applyDisclosure()` both
 * call it, so there is no second preview path that can drift.
 */
function summarizeHits(hits, query) {
  return (Array.isArray(hits) ? hits : []).map((hit) => {
    const full = String(hit.text ?? '');
    // A summary hit keeps text_chars (the original length) but only the
    // preview; re-slicing it would overwrite text_chars with the preview
    // length and make text_truncated permanently false.
    if (hit.disclosure === 'summary'
      || (Number.isInteger(hit.text_chars) && hit.text_chars > full.length)) {
      return hit;
    }
    const preview = snippetOf(full, query);
    return {
      ...hit,
      text: preview,
      text_chars: full.length,
      text_truncated: preview.length < full.length,
      disclosure: 'summary',
    };
  });
}

/**
 * Downgrade full-text hits to query-centered previews.
 *
 * `detail: 'full'` is a pass-through, not an upgrade: a summary hit keeps only
 * the preview and `text_chars`, never the original text, so it cannot be
 * expanded here. Call `search(..., { detail: 'full' })` when full text is
 * required.
 */
export function applyDisclosure(hits, query, detail = 'summary') {
  if (detail === 'full') return hits;
  return summarizeHits(hits, query);
}

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
 * @param {{topK?: number, category?: string|null, mode?: 'bm25'|'vector'|'hybrid',
 *   cacheScope?: string, cacheMode?: 'auto'|'library'|'document'}} options
 *   `cacheScope` separates the incremental indexes of independent stores.
 * @returns {Array<object>} hits sorted by score, zero-score documents removed.
 *   The hashing vector channel only scores documents that share at least one
 *   token with the query, so a document whose only similarity comes from a
 *   dimension collision stays at zero and cannot enter hybrid results.
 */
export function search(docs, query, options = {}) {
  const topK = Number.isInteger(options.topK) && options.topK > 0 ? options.topK : 5;
  const mode = options.mode ?? 'hybrid';
  const detail = options.detail === 'full' ? 'full' : 'summary';
  const cacheMode = ['auto', 'library', 'document'].includes(options.cacheMode)
    ? options.cacheMode : 'auto';
  if (!['bm25', 'vector', 'hybrid'].includes(mode)) {
    throw new Error(`mode 必须是 bm25 / vector / hybrid，收到：${mode}`);
  }
  if (typeof query !== 'string' || query.trim() === '') return [];

  const filtered = options.category
    ? docs.filter((doc) => doc.category === options.category)
    : docs;
  if (filtered.length === 0) return [];

  const category = options.category ?? null;
  // Every mode uses the incremental index: a single write only touches that
  // document's postings. `document` mode skips only the library-level vector
  // map and reads the per-document vector cache instead.
  const index = indexFor(filtered, category, options.cacheScope);
  const libraryVectors = cacheMode === 'document'
    ? null
    : libraryVectorsFor(filtered, category, options.cacheScope);
  const queryTokens = tokenize(query);
  const queryVector = mode === 'bm25' ? null : buildVector(query);

  const bm25 = new Map();
  for (const doc of filtered) bm25.set(doc.doc_id, bm25Score(index, queryTokens, doc.doc_id));
  const vectorScores = new Map();
  if (!queryVector) {
    for (const doc of filtered) vectorScores.set(doc.doc_id, 0);
  } else {
    // TF vectors over a 128-dimension hashing space give unrelated text a
    // small positive cosine whenever a dimension collides, even with zero
    // shared terms. That is noise, not a weak match: only documents that
    // share a token with the query get a vector score. A plain cosine floor
    // cannot separate the two (a single collision in a 30-token document is
    // already ~0.19), but token overlap can.
    const queryTokenSet = new Set(queryTokens);
    for (const doc of filtered) {
      const docTokens = index.docTokens.get(doc.doc_id) ?? [];
      const sharesToken = docTokens.some((token) => queryTokenSet.has(token));
      const vector = libraryVectors ? libraryVectors.get(doc.doc_id) : vectorFor(doc);
      vectorScores.set(doc.doc_id, sharesToken ? cosine(queryVector, vector) : 0);
    }
  }

  // Hybrid is rank fusion, not min-max weighted addition: BM25 has a long tail
  // and a single high score would otherwise dominate the normalized channel.
  const bm25Rank = new Map([...bm25.entries()]
    .filter(([, value]) => value > 0)
    .sort((left, right) => right[1] - left[1])
    .map(([id], index) => [id, index + 1]));
  const vectorRank = new Map([...vectorScores.entries()]
    .filter(([, value]) => value > 0)
    .sort((left, right) => right[1] - left[1])
    .map(([id], index) => [id, index + 1]));

  const hits = [];
  for (const doc of filtered) {
    const keyword = bm25.get(doc.doc_id) ?? 0;
    const vector = vectorScores.get(doc.doc_id) ?? 0;
    const confidence = Number.isFinite(doc.confidence)
      ? Math.min(1, Math.max(0, doc.confidence))
      : 0.8;
    let score;
    if (mode === 'bm25') {
      score = keyword;
    } else if (mode === 'vector') {
      score = vector;
    } else {
      score = (bm25Rank.has(doc.doc_id) ? 0.6 / (RRF_K + bm25Rank.get(doc.doc_id)) : 0)
        + (vectorRank.has(doc.doc_id) ? 0.4 / (RRF_K + vectorRank.get(doc.doc_id)) : 0);
    }
    // Confidence remains a bounded modifier after rank fusion. The unverified
    // penalty is applied again after cross-channel RRF in searchWithRag, where
    // pure rank can otherwise erase it.
    score *= 0.85 + 0.15 * confidence;
    const provenance = typeof doc.provenance === 'string' ? doc.provenance : 'authored';
    const verified = doc.verified === true;
    const unverified = provenance === 'model' && !verified;
    if (unverified) score *= 0.35;
    if (score > 0) {
      const fullText = String(doc.text ?? '');
      hits.push({
        doc_id: doc.doc_id,
        category: doc.category,
        text: fullText,
        text_chars: fullText.length,
        text_truncated: false,
        disclosure: 'full',
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
        bm25_rank: bm25Rank.get(doc.doc_id) ?? null,
        vector_rank: vectorRank.get(doc.doc_id) ?? null,
      });
    }
  }

  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, topK);
  return detail === 'full' ? top : summarizeHits(top, query);
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
