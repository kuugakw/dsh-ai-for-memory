/**
 * Filesystem-backed three-layer memory store.
 *
 * Layout under the memory root:
 *
 *   staging/staging_<hour>.jsonl     append-only working log
 *   archive/<category>.jsonl         idempotent categorized archive
 *   snapshots/<name>_<ts>.json       exact state snapshots
 *   knowledge/<doc_id>.json          searchable knowledge documents
 *   decisions/<decision_id>.json     reviewed decisions
 *
 * The store is deliberately synchronous: files are small, tool calls are
 * already serialized, and synchronous code makes crash behavior easy to reason
 * about (append one line, then return).
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  CATEGORIES,
  CATEGORY_MAP,
  KINDS,
  RISKS,
  SCHEMA_VERSION,
  VERIFIES,
  appendJsonLine,
  countPhysicalLines,
  ensureDir,
  hash40,
  hourKey,
  listJsonFiles,
  listJsonlFiles,
  nowIso,
  pad,
  readJson,
  readJsonl,
  safeStem,
  writeJson,
  clip,
  BoundedCache,
} from './util.js';
import { USAGE_FILE, USAGE_MAX_ENTRIES, recencyWeight } from './usage.js';
import { search as searchDocs } from './retrieval.js';
import {
  knowledgeDatabasePath,
  openKnowledgeDatabase,
  sqliteAvailable,
} from './knowledge-sqlite.js';
import {
  EXTRACTION_VERSION,
  candidatesFromDecision,
  candidatesFromRecord,
  candidatesFromTurn,
  findConflicts,
  findDuplicate,
  findDuplicateMatch,
  materialChange,
  knowledgeKey,
  normalizeCategory,
  normalizeKnowledge,
  normalizeProvenance,
  normalizeSource,
  withTokens,
} from './knowledge.js';

const START_MARKER = 'START_MARKER';
const ARCHIVE_ENTRY = 'ARCHIVE_ENTRY';

/**
 * Per-root mutation counter shared by every store instance in this process.
 * The plugin can hold more than one MemoryStore for the same directory (the
 * tool context and the panel each build their own scopes), so local cache
 * invalidation is not enough: a write through instance A must invalidate a view
 * cached by instance B.
 */
const cacheEpochs = new Map();

/**
 * File parse caches are process-wide: an absolute path is a unique key and the
 * same file is shared by every MemoryScopes/MemoryStore created for a panel
 * request. This is what lets the panel reuse work across HTTP requests.
 *
 * They must stay bounded. A long-running DSH process reads files from every
 * memory root and conversation it ever opens, so an unbounded map would keep
 * every parsed knowledge doc, archive and context forever. The byte budget uses
 * the file size as a cheap proxy for the parsed value; one oversized file (for
 * example a very large context archive) is parsed but not retained.
 */
const fileJsonCache = new BoundedCache({ maxEntries: 2000, maxBytes: 8 * 1024 * 1024 });
const fileJsonlCache = new BoundedCache({ maxEntries: 256, maxBytes: 16 * 1024 * 1024 });

/** Derived views are per root, also shared by every store instance. */
const rootViewCaches = new Map();

function rootViewCache(root) {
  let cache = rootViewCaches.get(root);
  if (!cache) {
    cache = {
      documents: null,
      knowledgeStats: null,
      search: new Map(),
      staging: null,
      archiveStats: null,
      archiveIds: new Map(),
      contexts: null,
      decisions: null,
      pendingKnowledge: null,
      pendingPromotions: null,
      promotedLedger: null,
      conflicts: null,
    };
    rootViewCaches.set(root, cache);
  }
  return cache;
}

/** Freeze the cached document and its arrays so callers cannot poison the view. */
function freezeDocument(doc) {
  if (Array.isArray(doc.tags)) Object.freeze(doc.tags);
  if (Array.isArray(doc.evidence)) Object.freeze(doc.evidence);
  if (Array.isArray(doc.changes)) Object.freeze(doc.changes);
  return Object.freeze(doc);
}

export class MemoryStore {
  /**
   * @param {string} root - absolute memory directory.
   * @param {{maxContentChars?: number, maxSnapshotBytes?: number, defaultTopK?: number}} [options]
   */
  constructor(root, options = {}) {
    this.root = path.resolve(root);
    this.stagingDir = path.join(this.root, 'staging');
    this.archiveDir = path.join(this.root, 'archive');
    this.snapshotDir = path.join(this.root, 'snapshots');
    this.knowledgeDir = path.join(this.root, 'knowledge');
    this.decisionDir = path.join(this.root, 'decisions');
    this.contextDir = path.join(this.root, 'contexts');
    // Proposals that would rewrite an existing fact. They are deliberately kept
    // outside knowledge/ so they never become searchable facts before a user
    // confirms them.
    this.pendingDir = path.join(this.root, 'pending');
    this.knowledgePendingFile = path.join(this.pendingDir, 'knowledge.json');
    this.compactionStatusFile = path.join(this.root, 'compaction_status.json');
    this.promotedLedgerFile = path.join(this.knowledgeDir, '_promoted.json');
    // Per-conversation recency log: doc_id -> { at, count }. Rolled into the
    // ranking only for this store, so A's usage never changes B's order.
    this.knowledgeUsageFile = path.join(this.knowledgeDir, USAGE_FILE);
    // Audit trail for the conflict gate: every blocked write is one line here.
    // It is not a queue: nothing in this file is ever applied automatically, and
    // it is not read by documents() or search.
    this.conflictsFile = path.join(this.knowledgeDir, 'conflicts.jsonl');
    this.maxContentChars = options.maxContentChars ?? 20000;
    this.maxSnapshotBytes = options.maxSnapshotBytes ?? 262144;
    this.defaultTopK = options.defaultTopK ?? 5;
    // Staging files are a raw working log; once every record is in archive/,
    // the hourly file is redundant. Retention only removes fully archived files
    // older than N days, so an unarchived record can never be lost here.
    this.stagingRetentionDays = Number.isFinite(options.stagingRetentionDays)
      ? Math.max(0, options.stagingRetentionDays)
      : 30;
    // Context archives are restorable by design; deleting them is opt-in.
    this.contextRetentionDays = Number.isFinite(options.contextRetentionDays)
      ? Math.max(0, options.contextRetentionDays)
      : 0;
    this.decisionRetentionDays = Number.isFinite(options.decisionRetentionDays)
      ? Math.max(0, options.decisionRetentionDays)
      : 0;
    // Knowledge storage backend: 'json' (one file per document, the default) or
    // 'sqlite' (a single queryable database, mirrored back to JSON files).
    // A Node build without node:sqlite silently stays on JSON.
    this.knowledgeBackend = options.knowledgeBackend === 'sqlite' && sqliteAvailable()
      ? 'sqlite'
      : 'json';
    this.knowledgeDbFile = knowledgeDatabasePath(this.root);
    this.knowledgeSql = null;
    this.knowledgeFallbackError = '';
    // Repeated readers (aim_search fan-out, panel /state, promote) call the
    // same layer several times per operation. Keep short-lived derived views
    // and a per-file parse cache; writes invalidate the affected view, and the
    // TTL bounds staleness for files edited outside the plugin.
    this._cacheTtlMs = Number.isFinite(options.cacheTtlMs) && options.cacheTtlMs >= 0
      ? options.cacheTtlMs
      : 1000;
    this._cache = rootViewCache(this.root);
    this._fileCache = fileJsonCache;
    this._jsonlCache = fileJsonlCache;
  }

  get _documentsCache() { return this._cache.documents; }
  set _documentsCache(value) { this._cache.documents = value; }
  get _knowledgeStatsCache() { return this._cache.knowledgeStats; }
  set _knowledgeStatsCache(value) { this._cache.knowledgeStats = value; }
  get _searchCache() { return this._cache.search; }
  get _stagingCache() { return this._cache.staging; }
  set _stagingCache(value) { this._cache.staging = value; }
  get _archiveStatsCache() { return this._cache.archiveStats; }
  set _archiveStatsCache(value) { this._cache.archiveStats = value; }
  get _contextsCache() { return this._cache.contexts; }
  set _contextsCache(value) { this._cache.contexts = value; }
  get _decisionsCache() { return this._cache.decisions; }
  set _decisionsCache(value) { this._cache.decisions = value; }
  get _pendingKnowledgeCache() { return this._cache.pendingKnowledge; }
  set _pendingKnowledgeCache(value) { this._cache.pendingKnowledge = value; }
  get _pendingPromotionsCache() { return this._cache.pendingPromotions; }
  set _pendingPromotionsCache(value) { this._cache.pendingPromotions = value; }
  get _promotedLedgerCache() { return this._cache.promotedLedger; }
  set _promotedLedgerCache(value) { this._cache.promotedLedger = value; }
  get _conflictsCache() { return this._cache.conflicts; }
  set _conflictsCache(value) { this._cache.conflicts = value; }

  /* ---- derived-value cache ------------------------------------------------ */

  _cacheFresh(cache) {
    return cache !== null && cache !== undefined
      && cache.epoch === this._epoch()
      && Date.now() - cache.at <= this._cacheTtlMs;
  }

  _epoch() {
    return cacheEpochs.get(this.root) ?? 0;
  }

  _bumpEpoch() {
    cacheEpochs.set(this.root, this._epoch() + 1);
  }

  _statOf(file) {
    try {
      const stat = fs.statSync(file);
      return { mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      return null;
    }
  }

  /** Parse a JSON file only when its mtime/size changed. */
  _readJsonCached(file) {
    const meta = this._statOf(file);
    if (meta === null) return null;
    const hit = this._fileCache.get(file);
    if (hit !== undefined && hit.mtimeMs === meta.mtimeMs && hit.size === meta.size) return hit.value;
    const value = readJson(file);
    this._fileCache.set(file, { ...meta, value }, meta.size);
    return value;
  }

  /** Parse a JSONL file only when its mtime/size changed. */
  _readJsonlCached(file) {
    const meta = this._statOf(file);
    if (meta === null) return [];
    const hit = this._jsonlCache.get(file);
    if (hit !== undefined && hit.mtimeMs === meta.mtimeMs && hit.size === meta.size) return hit.value;
    const value = readJsonl(file);
    this._jsonlCache.set(file, { ...meta, value }, meta.size);
    return value;
  }

  _invalidateKnowledge() {
    this._documentsCache = null;
    this._knowledgeStatsCache = null;
    this._searchCache.clear();
    this._pendingKnowledgeCache = null;
    this._pendingPromotionsCache = null;
    this._promotedLedgerCache = null;
  }

  _invalidateStaging() {
    this._stagingCache = null;
    this._pendingKnowledgeCache = null;
  }

  _invalidateArchive() {
    this._archiveStatsCache = null;
    this._pendingKnowledgeCache = null;
  }

  _invalidateContexts() {
    this._contextsCache = null;
    this._pendingKnowledgeCache = null;
  }

  _invalidateDecisions() {
    this._decisionsCache = null;
    this._pendingKnowledgeCache = null;
  }

  /** Keep an already-built documents view current after a single write. */
  _rememberInDocumentsCache(doc) {
    this._searchCache.clear();
    if (this._documentsCache === null) return;
    const docs = this._documentsCache.docs.filter((item) => item.doc_id !== doc.doc_id);
    docs.push(freezeDocument(this.normalizeStoredDoc(doc)));
    docs.sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
    this._documentsCache = { at: Date.now(), epoch: this._epoch(), docs };
  }

  _removeFromDocumentsCache(docId) {
    this._searchCache.clear();
    if (this._documentsCache === null) return;
    const docs = this._documentsCache.docs.filter((item) => item.doc_id !== docId);
    this._documentsCache = { at: Date.now(), epoch: this._epoch(), docs };
  }

  // ---- paths -------------------------------------------------------------

  /** Ensure every directory exists. */
  init() {
    for (const dir of [
      this.root,
      this.stagingDir,
      this.archiveDir,
      this.snapshotDir,
      this.knowledgeDir,
      this.decisionDir,
      this.contextDir,
      this.pendingDir,
    ]) {
      ensureDir(dir);
    }
    return this;
  }

  // ---- knowledge storage -------------------------------------------------

  /**
   * SQLite handle for the knowledge base, or `null` in JSON mode.
   *
   * Opening the database also performs a one-time import of existing JSON
   * documents, so switching backends never hides facts written earlier. A
   * failure downgrades the store to JSON for the rest of its life instead of
   * taking the memory layer down.
   */
  knowledgeStore() {
    if (this.knowledgeBackend !== 'sqlite') return null;
    if (this.knowledgeSql) return this.knowledgeSql;
    try {
      this.knowledgeSql = openKnowledgeDatabase(this.root);
    } catch (error) {
      this.knowledgeBackend = 'json';
      this.knowledgeFallbackError = String(error?.message ?? error);
      this.knowledgeSql = null;
      return null;
    }
    for (const file of listJsonFiles(this.knowledgeDir)) {
      if (path.basename(file) === path.basename(this.promotedLedgerFile)) continue;
      const data = readJson(file);
      if (!data || typeof data.doc_id !== 'string' || typeof data.text !== 'string') continue;
      // Rows already in SQL are newer than the JSON mirror; do not downgrade them.
      if (this.knowledgeSql.getById(data.doc_id)) continue;
      this.knowledgeSql.upsert(this.normalizeStoredDoc(data));
    }
    return this.knowledgeSql;
  }

  /** Backend description for status lines and the panel. */
  /**
   * Backend description for status lines and the panel.
   *
   * `source` is always `json`: that is the canonical, reviewable base. The
   * `sqlite` backend only adds a derived read-only mirror for SQL tooling; it
   * never replaces JSON as the write or read source.
   */
  knowledgeBackendInfo() {
    this.knowledgeStore();
    return {
      source: 'json',
      backend: this.knowledgeBackend,
      sqlMirror: this.knowledgeBackend === 'sqlite',
      file: this.knowledgeBackend === 'sqlite' ? this.relative(this.knowledgeDbFile) : '',
      sqliteAvailable: sqliteAvailable(),
      error: this.knowledgeFallbackError,
    };
  }

  /** Normalize a stored JSON document or SQLite row into one shape. */
  normalizeStoredDoc(data) {
    const source = typeof data.source === 'string' ? data.source : 'unknown';
    const provenance = normalizeProvenance(data.provenance, source);
    const evidence = Array.isArray(data.evidence) ? data.evidence : [];
    // Explicit confirmation is its own fact, not a guess derived from source.
    // New documents write `confirmed`; documents confirmed before this field
    // existed are recognized by the user-confirm evidence they already carry.
    const confirmed = data.confirmed === true
      || evidence.some((item) => item && item.kind === 'user-confirm');
    const untraceable = normalizeSource(source) === 'unknown' && provenance === 'model';
    return {
      doc_id: data.doc_id,
      schema_version: Number.isInteger(data.schema_version) ? data.schema_version : SCHEMA_VERSION,
      text: data.text,
      // Legacy documents may carry a pre-taxonomy category; reading through
      // the normalizer keeps the corpus in one closed set.
      category: normalizeCategory(data.category),
      source,
      tags: Array.isArray(data.tags) ? data.tags.filter((tag) => typeof tag === 'string') : [],
      url: typeof data.url === 'string' ? data.url : '',
      confidence: typeof data.confidence === 'number' ? data.confidence : 0.8,
      provenance,
      confirmed,
      // Source inference may lower a model claim to unverified, but it can
      // never veto an explicit confirmation.
      verified: confirmed ? true : (untraceable ? false : (typeof data.verified === 'boolean' ? data.verified : provenance !== 'model')),
      evidence,
      changes: Array.isArray(data.changes) ? data.changes.filter((item) => item && typeof item === 'object') : [],
      created_at: typeof data.created_at === 'string' ? data.created_at : '',
      updated_at: typeof data.updated_at === 'string' ? data.updated_at : '',
      revision: Number.isInteger(data.revision) ? data.revision : 1,
    };
  }

  /** POSIX-relative path used inside dedup ids and records. */
  relative(file) {
    return path.relative(this.root, file).split(path.sep).join('/');
  }

  // ---- staging -----------------------------------------------------------

  /**
   * Append one working-log record.
   *
   * @param {{content: string, kind?: string, source?: string, risk?: string, verify?: string}} input
   * @returns {object} the stored record plus its resolved category.
   */
  stage(input) {
    this.init();
    const content = String(input?.content ?? '');
    if (content.trim() === '') throw new Error('content 必须为非空字符串');
    if (content.length > this.maxContentChars) {
      throw new Error(`content 过长（${content.length} 字符，上限 ${this.maxContentChars}）`);
    }

    const kind = input?.kind ?? 'action';
    if (!KINDS.includes(kind)) throw new Error(`kind 必须是 ${KINDS.join(' / ')}，收到：${kind}`);
    const risk = input?.risk ?? 'low';
    if (!RISKS.includes(risk)) throw new Error(`risk 必须是 ${RISKS.join(' / ')}，收到：${risk}`);
    const verify = input?.verify ?? 'pending';
    if (!VERIFIES.includes(verify)) {
      throw new Error(`verify 必须是 ${VERIFIES.join(' / ')}，收到：${verify}`);
    }

    const file = path.join(this.stagingDir, `staging_${hourKey()}.jsonl`);
    // Count physical lines, including a torn last line, so indexes are unique.
    const entryIndex = countPhysicalLines(file);
    const sourceFile = this.relative(file);
    const record = {
      dedup_id: hash40(`${sourceFile}\n${entryIndex}\n`),
      source_file: sourceFile,
      entry_index: entryIndex,
      timestamp: nowIso(),
      kind,
      content,
      source: String(input?.source ?? ''),
      risk,
      verify,
    };
    appendJsonLine(file, record, { durable: false });
    this._bumpEpoch();
    this._invalidateStaging();
    return { ...record, category: CATEGORY_MAP[kind] };
  }

  /** Read every staging record, oldest file first. */
  stagingRecords() {
    if (this._cacheFresh(this._stagingCache)) return this._stagingCache.records.slice();
    const records = [];
    for (const file of listJsonlFiles(this.stagingDir)) records.push(...this._readJsonlCached(file));
    this._stagingCache = { at: Date.now(), epoch: this._epoch(), records };
    return records.slice();
  }

  // ---- archive -----------------------------------------------------------

  /**
   * Move staged records into categorized archive files.
   *
   * Idempotent: an entry whose `dedup_id` already exists in the target file is
   * skipped, so a retry after a crash only fills the missing pieces.
   *
   * @param {{category?: string|null}} [options]
   */
  archive(options = {}) {
    this.init();
    const forced = options.category ?? null;
    if (forced !== null && !CATEGORIES.includes(forced)) {
      throw new Error(`category 必须是 ${CATEGORIES.join(' / ')}，收到：${forced}`);
    }

    const stats = { archived: 0, skipped: 0, failed: 0, categories: [] };
    const staged = this.stagingRecords();
    if (staged.length === 0) return stats;

    const processed = new Map();
    const processedFor = (category) => {
      if (!processed.has(category)) processed.set(category, this._archiveIdsFor(category));
      return processed.get(category);
    };

    // Optional per-record categories (dedup_id → category), produced by the
    // external classifier. Unknown values fall back to the kind-based route so a
    // bad model answer can never lose a record.
    const overrides = options.categories && typeof options.categories === 'object'
      ? options.categories
      : null;
    const pickOverride = (dedupId) => {
      const value = overrides?.[dedupId];
      return typeof value === 'string' && CATEGORIES.includes(value) ? value : null;
    };

    const pending = [];
    for (const record of staged) {
      if (!record.dedup_id) {
        stats.failed += 1;
        continue;
      }
      const targets = forced !== null
        ? [forced]
        : [pickOverride(record.dedup_id) ?? CATEGORY_MAP[record.kind] ?? 'action_logs'];
      if (targets.every((category) => processedFor(category).has(record.dedup_id))) {
        stats.skipped += 1;
        continue;
      }
      pending.push({ record, targets });
    }
    if (pending.length === 0) return stats;

    const sourceFiles = [...new Set(pending.map(({ record }) => record.source_file))].sort();
    const touched = [...new Set(pending.flatMap(({ targets }) => targets))].sort();
    for (const category of touched) {
      appendJsonLine(this.categoryFile(category), {
        type: START_MARKER,
        batch_id: Math.random().toString(16).slice(2, 14),
        timestamp: nowIso(),
        source_files: sourceFiles,
        category,
      });
    }

    for (const { record, targets } of pending) {
      for (const category of targets) {
        if (processedFor(category).has(record.dedup_id)) continue;
        appendJsonLine(this.categoryFile(category), {
          type: ARCHIVE_ENTRY,
          dedup_id: record.dedup_id,
          source_file: record.source_file,
          entry_index: record.entry_index,
          timestamp: record.timestamp,
          kind: record.kind,
          content: record.content,
          source: record.source,
          risk: record.risk,
          verify: record.verify,
          archived_at: nowIso(),
        });
        processedFor(category).add(record.dedup_id);
        stats.archived += 1;
      }
    }

    stats.categories = touched;
    // Keep the per-category dedup sets incremental: update their file signature
    // instead of throwing them away and re-reading every archive file.
    for (const category of touched) {
      const meta = this._statOf(this.categoryFile(category));
      if (meta !== null) {
        this._cache.archiveIds.set(category, {
          mtimeMs: meta.mtimeMs,
          size: meta.size,
          ids: processedFor(category),
        });
      }
    }
    this._bumpEpoch();
    this._invalidateArchive();
    return stats;
  }

  /** Cached dedup-id set for one archive category, keyed by file mtime + size. */
  _archiveIdsFor(category) {
    const file = this.categoryFile(category);
    const meta = this._statOf(file);
    if (meta === null) return new Set();
    const hit = this._cache.archiveIds.get(category);
    if (hit && hit.mtimeMs === meta.mtimeMs && hit.size === meta.size) return hit.ids;
    const ids = new Set(
      this._readJsonlCached(file)
        .filter((row) => row.type !== START_MARKER && row.dedup_id)
        .map((row) => row.dedup_id),
    );
    this._cache.archiveIds.set(category, { mtimeMs: meta.mtimeMs, size: meta.size, ids });
    return ids;
  }

  /** Absolute path of one category file. */
  categoryFile(category) {
    if (!CATEGORIES.includes(category)) throw new Error(`未知归档分类：${category}`);
    return path.join(this.archiveDir, `${category}.jsonl`);
  }

  /** Number of archive entries (markers excluded), globally or per category. */
  archivedCount(category = null) {
    const countFile = (file) => this._readJsonlCached(file)
      .filter((row) => row.type !== START_MARKER).length;
    if (category !== null) return countFile(this.categoryFile(category));
    return listJsonlFiles(this.archiveDir).reduce((sum, file) => sum + countFile(file), 0);
  }

  /** Recent archive entries of one category, newest first. */
  archiveEntries(category, limit = 50) {
    const rows = this._readJsonlCached(this.categoryFile(category))
      .filter((row) => row.type !== START_MARKER);
    return rows.slice(-limit).reverse().map((row) => ({
      dedup_id: row.dedup_id,
      content: row.content,
      kind: row.kind,
      risk: row.risk,
      verify: row.verify,
      source: row.source,
      timestamp: row.timestamp,
    }));
  }

  /** `{category: entryCount}` for every existing archive file. */
  archiveStats() {
    if (this._cacheFresh(this._archiveStatsCache)) return { ...this._archiveStatsCache.stats };
    const stats = {};
    for (const file of listJsonlFiles(this.archiveDir)) {
      const category = path.basename(file, '.jsonl');
      stats[category] = this._readJsonlCached(file).filter((row) => row.type !== START_MARKER).length;
    }
    this._archiveStatsCache = { at: Date.now(), epoch: this._epoch(), stats };
    return { ...stats };
  }

  /**
   * Delete hourly staging files that are old enough and fully archived.
   *
   * A file is only removed when every record in it already exists in archive/.
   * Unarchived records stay forever, regardless of age.
   */
  pruneStaging(days = this.stagingRetentionDays) {
    if (!(Number.isFinite(days) && days > 0)) return 0;
    const cutoff = Date.now() - days * 86400000;
    const archived = new Set();
    for (const file of listJsonlFiles(this.archiveDir)) {
      const category = path.basename(file, '.jsonl');
      if (!CATEGORIES.includes(category)) continue;
      for (const id of this._archiveIdsFor(category)) archived.add(id);
    }
    let removed = 0;
    for (const file of listJsonlFiles(this.stagingDir)) {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (stat.mtimeMs > cutoff) continue;
      const records = this._readJsonlCached(file);
      if (records.length === 0) continue;
      if (!records.every((row) => row && typeof row.dedup_id === 'string' && archived.has(row.dedup_id))) continue;
      try {
        fs.rmSync(file);
        this._jsonlCache.delete(file);
        removed += 1;
      } catch {
        // A concurrent reader/writer keeps the file; retry on the next pass.
      }
    }
    if (removed > 0) {
      this._bumpEpoch();
      this._invalidateStaging();
      this._invalidateArchive();
    }
    return removed;
  }

  /** Opt-in age retention for context archives. Default disabled: restorable means kept. */
  pruneContexts(days = this.contextRetentionDays) {
    if (!(Number.isFinite(days) && days > 0)) return 0;
    const cutoff = Date.now() - days * 86400000;
    let removed = 0;
    for (const file of listJsonFiles(this.contextDir)) {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (stat.mtimeMs > cutoff) continue;
      try {
        fs.rmSync(file);
        this._fileCache.delete(file);
        removed += 1;
      } catch {
        // Keep it and try again later.
      }
    }
    if (removed > 0) {
      this._bumpEpoch();
      this._invalidateContexts();
    }
    return removed;
  }

  /** Opt-in age retention for decision audit records. Default disabled. */
  pruneDecisions(days = this.decisionRetentionDays) {
    if (!(Number.isFinite(days) && days > 0)) return 0;
    const cutoff = Date.now() - days * 86400000;
    let removed = 0;
    for (const file of listJsonFiles(this.decisionDir)) {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (stat.mtimeMs > cutoff) continue;
      try {
        fs.rmSync(file);
        this._fileCache.delete(file);
        removed += 1;
      } catch {
        // Keep it and try again later.
      }
    }
    if (removed > 0) {
      this._bumpEpoch();
      this._invalidateDecisions();
    }
    return removed;
  }

  /** Run every configured retention pass; returns per-layer removed counts. */
  pruneRetention() {
    return {
      staging: this.pruneStaging(),
      contexts: this.pruneContexts(),
      decisions: this.pruneDecisions(),
    };
  }

  // ---- snapshots ---------------------------------------------------------

  /**
   * Store an exact state snapshot.
   *
   * @param {{name: string, state?: object, metadata?: object}} input
   */
  snapshot(input) {
    if (typeof input?.name !== 'string' || input.name.trim() === '') {
      throw new Error('name 必须为非空字符串');
    }
    const state = input.state ?? {};
    if (state === null || typeof state !== 'object' || Array.isArray(state)) {
      throw new Error('state 必须为对象');
    }
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized, 'utf8') > this.maxSnapshotBytes) {
      throw new Error(`state 过大（上限 ${this.maxSnapshotBytes} 字节）`);
    }

    this.init();
    const now = new Date();
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
      + `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const baseId = `${safeStem(input.name, 'snapshot')}_${timestamp}`;
    let snapshotId = baseId;
    let suffix = 1;
    while (fs.existsSync(path.join(this.snapshotDir, `${snapshotId}.json`))) {
      suffix += 1;
      snapshotId = `${baseId}_${suffix}`;
    }

    const data = {
      snapshot_id: snapshotId,
      name: input.name,
      timestamp: nowIso(now),
      state,
    };
    if (input.metadata && typeof input.metadata === 'object') data.metadata = input.metadata;
    writeJson(path.join(this.snapshotDir, `${snapshotId}.json`), data);

    return {
      snapshot_id: snapshotId,
      name: input.name,
      timestamp: data.timestamp,
      state_size: serialized.length,
      file: this.relative(path.join(this.snapshotDir, `${snapshotId}.json`)),
    };
  }

  /** Look up a snapshot by exact id, then name, then id prefix. */
  loadSnapshot(idOrName) {
    if (typeof idOrName !== 'string' || idOrName.trim() === '') return null;
    const exact = path.join(this.snapshotDir, `${idOrName}.json`);
    const direct = readJson(exact);
    if (direct) return direct;

    let byName = null;
    let byPrefix = null;
    for (const file of listJsonFiles(this.snapshotDir)) {
      const data = readJson(file);
      if (!data) continue;
      const mtime = fs.statSync(file).mtimeMs;
      if (data.name === idOrName && (!byName || mtime >= byName.mtime)) {
        byName = { data, mtime };
      }
      if (typeof data.snapshot_id === 'string' && data.snapshot_id.startsWith(idOrName)
        && (!byPrefix || mtime >= byPrefix.mtime)) {
        byPrefix = { data, mtime };
      }
    }
    const chosen = byName ?? byPrefix;
    return chosen ? chosen.data : null;
  }

  /** Restore the `state` object from a snapshot, or null. */
  restoreSnapshot(idOrName) {
    const data = this.loadSnapshot(idOrName);
    return data ? data.state : null;
  }

  /** Snapshot metadata, oldest first. */
  listSnapshots() {
    const rows = [];
    for (const file of listJsonFiles(this.snapshotDir)) {
      const data = readJson(file);
      if (!data) continue;
      rows.push({
        snapshot_id: data.snapshot_id ?? path.basename(file, '.json'),
        name: data.name ?? '',
        timestamp: data.timestamp ?? '',
        state_size: JSON.stringify(data.state ?? {}).length,
        mtime: fs.statSync(file).mtimeMs,
      });
    }
    rows.sort((a, b) => a.mtime - b.mtime);
    return rows.map(({ mtime, ...row }) => row);
  }

  /**
   * Delete one snapshot file by exact id, name or id prefix.
   *
   * Automatic retention uses this for near-duplicate pruning. It never touches
   * context archives (`contexts/`) or other layers.
   */
  removeSnapshot(idOrName) {
    const data = this.loadSnapshot(idOrName);
    if (!data || typeof data.snapshot_id !== 'string') return false;
    const file = path.join(this.snapshotDir, `${data.snapshot_id}.json`);
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file);
    return true;
  }

  // ---- knowledge ---------------------------------------------------------

  /**
   * Conversation-scoped usage log: `doc_id -> { at, count }`.
   *
   * Kept per store, so the same document can be "recently used" in one
   * conversation and "long unused" in another; ranking reads only its own log.
   */
  knowledgeUsage() {
    const data = readJson(this.knowledgeUsageFile);
    const raw = data && typeof data.docs === 'object' && data.docs !== null ? data.docs : {};
    // Cross-conversation search used to record foreign doc_ids here. Drop them
    // on read: a usage log must only describe documents this store owns, or the
    // 1000-entry cap evicts the caller's own real usage with foreign IDs.
    const owned = new Set(this.documents().map((doc) => doc.doc_id));
    const docs = {};
    let removed = 0;
    for (const [docId, entry] of Object.entries(raw)) {
      if (owned.has(docId)) docs[docId] = entry;
      else removed += 1;
    }
    if (removed > 0) {
      ensureDir(this.knowledgeDir);
      writeJson(this.knowledgeUsageFile, {
        version: 1,
        updated_at: nowIso(),
        docs,
      }, { durable: false });
    }
    return docs;
  }

  /** Record that this conversation used the given knowledge documents now. */
  recordKnowledgeUsage(docIds, options = {}) {
    const requested = (Array.isArray(docIds) ? docIds : [docIds])
      .map((value) => String(value ?? '').trim())
      .filter((value) => value !== '');
    if (requested.length === 0) return;
    // Only documents in this store can be "used by this conversation". A search
    // hit from another conversation must not enter this usage log.
    const owned = new Set(this.documents().map((doc) => doc.doc_id));
    const list = requested.filter((docId) => owned.has(docId));
    if (list.length === 0) return;
    const at = typeof options.at === 'string' && options.at !== '' ? options.at : nowIso();
    const usage = this.knowledgeUsage();
    for (const docId of new Set(list)) {
      const previous = usage[docId];
      usage[docId] = {
        at,
        count: (Number.isInteger(previous?.count) ? previous.count : 0) + 1,
      };
    }
    const kept = Object.entries(usage)
      .sort((left, right) => String(right[1]?.at ?? '').localeCompare(String(left[1]?.at ?? '')))
      .slice(0, USAGE_MAX_ENTRIES);
    ensureDir(this.knowledgeDir);
    writeJson(this.knowledgeUsageFile, {
      version: 1,
      updated_at: at,
      docs: Object.fromEntries(kept),
    }, { durable: false });
  }

  /** All recency weights for this store in one read (doc_id -> 0..1). */
  knowledgeWeights(now = Date.now()) {
    const usage = this.knowledgeUsage();
    const weights = {};
    for (const [docId, entry] of Object.entries(usage)) {
      weights[docId] = recencyWeight(entry?.at, now);
    }
    return weights;
  }

  /** Recency weight for one document in this conversation (0..1). */
  knowledgeWeight(docId, now = Date.now()) {
    const entry = this.knowledgeUsage()[docId];
    return recencyWeight(entry?.at, now);
  }

  /**
   * Record one incident as a separately labeled knowledge type.
   *
   * Incidents are dated evidence, not claims about the project, so they bypass
   * the conflict gate: a new incident never asks for confirmation and never
   * overwrites a fact. The text is a fixed template so every incident stays
   * readable and searchable in the same shape.
   */
  recordIncident(input = {}) {
    const field = (value) => String(value ?? '').trim();
    const title = field(input.title);
    if (title === '') throw new Error('incident 需要 title');
    const severity = ['low', 'medium', 'high'].includes(input.severity) ? input.severity : 'medium';
    const status = ['open', 'mitigated', 'resolved'].includes(input.status) ? input.status : 'open';
    const occurredAt = field(input.occurred_at) !== '' ? field(input.occurred_at) : nowIso();
    const details = [];
    for (const [label, value] of [
      ['发生了什么', input.what_happened],
      ['影响', input.impact],
      ['原因', input.cause],
      ['处理', input.fix],
      ['预防', input.prevention],
    ]) {
      const text = field(value);
      if (text !== '') details.push(`${label}：${text}`);
    }
    // Incidents are model prose, not verified facts. Keep one compact sentence
    // (the knowledge layer's invariant) instead of a six-line template that
    // dominates BM25 and the panel.
    const text = `[事故] ${title}${details.length > 0 ? `：${details.join('；')}` : ''}`
      + `（严重度：${severity}；状态：${status}；发生时间：${occurredAt}）`;
    const tags = [...new Set([
      'incident', severity, status,
      ...(Array.isArray(input.tags) ? input.tags.map((tag) => field(tag)).filter(Boolean) : []),
    ])].slice(0, 8);
    return this.remember({
      doc_id: field(input.doc_id) !== '' ? field(input.doc_id) : undefined,
      text,
      category: 'incidents',
      source: 'incident',
      tags,
      // Model prose: low confidence and needs a user confirmation before it
      // stops carrying the unverified badge.
      confidence: 0.55,
      provenance: 'model',
      verified: false,
      evidence: [{ kind: 'incident', ref: field(input.source) || 'incident', at: occurredAt }],
    }, { confirm: true });
  }

  /**
   * Upsert one knowledge document.
   *
   * The id is derived from the text when the caller does not name one, so
   * writing the same fact twice merges into one document instead of creating a
   * second copy. Updates keep the original `created_at` and append provenance
   * instead of replacing it.
   *
   * A fact that *disagrees* with what is already stored is not written: when a
   * related document exists with a different wording, the call returns
   * `needs_confirm` and the caller has to ask the user, then retry with
   * `{ confirm: true }`. Programmatic mining uses `preserveText: true` instead:
   * it may add evidence to an existing fact, but it must never rewrite the
   * sentence the user already confirmed.
   *
   * An explicit `doc_id` that already exists names the document to rewrite. It
   * needs the same confirmation as a detected conflict; with `confirm: true`
   * the new text replaces that document's body (the old text stays in
   * `changes`), which is how a confirmed "use the new value" is applied.
   *
   * @param {{doc_id?: string, text: string, category?: string, source?: string,
   *   tags?: string[], url?: string, confidence?: number, evidence?: object[]}} input
   * @param {{confirm?: boolean, preserveText?: boolean}} [options]
   */
  remember(input, options = {}) {
    const doc = normalizeKnowledge(input);
    const incomingText = doc.text;
    if (doc.text.length > this.maxContentChars) {
      throw new Error(`text 过长（${doc.text.length} 字符，上限 ${this.maxContentChars}）`);
    }

    this.init();
    const existingDocs = withTokens(this.documents());
    // A caller-supplied doc_id is a naming convenience, not a second dedupe
    // namespace. The same text under a different custom id must land in the
    // existing document. An id that is already taken by different text is an
    // explicit rewrite target: it is never silently written over, but it may be
    // overwritten with `confirm: true`.
    const explicitId = typeof input?.doc_id === 'string' ? input.doc_id.trim() : '';
    const explicitDoc = explicitId === ''
      ? null
      : existingDocs.find((item) => item.doc_id === explicitId) ?? null;
    const duplicateMatch = findDuplicateMatch(doc.text, existingDocs);
    const duplicateDoc = duplicateMatch?.doc ?? null;
    // An explicit id with different text names a document the caller wants to
    // rewrite. That is never silent: without confirm it is a proposed update,
    // and with confirm the body is replaced (audited in `changes`).
    const explicitRewrite = explicitDoc !== null && explicitDoc.text !== doc.text;
    // Near-duplicates are normally merged silently. A changed value is not a
    // restatement though: "端口 8080" → "端口 8081" has >0.85 token overlap and
    // would otherwise bypass the conflict gate and overwrite the old value with
    // no visible signal. materialChange() turns that into an explicit update.
    const targetDoc = explicitRewrite ? explicitDoc : duplicateDoc;
    const change = targetDoc ? materialChange(targetDoc.text, doc.text) : null;
    if (targetDoc) {
      doc.doc_id = targetDoc.doc_id;
    } else if (existingDocs.some((item) => item.doc_id === doc.doc_id)) {
      doc.doc_id = knowledgeKey(doc.text);
    }
    // Mining is not a user edit. It may add evidence to an existing fact, but a
    // different sentence (even a paraphrase) must not replace the stored one.
    // A material value/URL/polarity change is stronger: it is a proposed update,
    // reported to the caller but never written.
    const preserveText = options.preserveText === true;
    const preservedText = preserveText && targetDoc && targetDoc.text !== incomingText;
    if (preserveText && targetDoc && change) {
      const update = {
        doc_id: targetDoc.doc_id,
        text: targetDoc.text,
        category: typeof targetDoc.category === 'string' ? targetDoc.category : '',
        similarity: Number((duplicateMatch?.score ?? 1).toFixed(3)),
        update: true,
        change,
      };
      return this.reportConflict({
        needs_confirm: true,
        kind: 'update',
        pending: { doc_id: targetDoc.doc_id, text: incomingText, category: doc.category, update_of: targetDoc.doc_id },
        conflicts: [update],
      });
    }
    if (preservedText) {
      // Keep the confirmed wording; the new evidence is merged below.
      doc.text = targetDoc.text;
    }
    if (options.confirm !== true && doc.category !== 'incidents' && !preserveText) {
      const conflicts = findConflicts(doc.text, existingDocs);
      if (explicitRewrite) {
        const similarity = explicitDoc.doc_id === duplicateDoc?.doc_id
          ? Number((duplicateMatch?.score ?? 0).toFixed(3))
          : 0;
        return this.reportConflict({
          needs_confirm: true,
          kind: 'update',
          pending: { doc_id: doc.doc_id, text: doc.text, category: doc.category, update_of: explicitDoc.doc_id },
          conflicts: [{
            doc_id: explicitDoc.doc_id,
            text: explicitDoc.text,
            category: typeof explicitDoc.category === 'string' ? explicitDoc.category : '',
            similarity,
            update: true,
            change: change ?? { kind: 'text', before: [explicitDoc.text], after: [doc.text] },
          }, ...conflicts].slice(0, 3),
        });
      }
      if (duplicateDoc && change) {
        const update = {
          doc_id: duplicateDoc.doc_id,
          text: duplicateDoc.text,
          category: typeof duplicateDoc.category === 'string' ? duplicateDoc.category : '',
          similarity: Number((duplicateMatch?.score ?? 1).toFixed(3)),
          update: true,
          change,
        };
        return this.reportConflict({
          needs_confirm: true,
          kind: 'update',
          pending: { doc_id: doc.doc_id, text: doc.text, category: doc.category, update_of: duplicateDoc.doc_id },
          conflicts: [update, ...conflicts].slice(0, 3),
        });
      }
      if (conflicts.length > 0) {
        return this.reportConflict({
          needs_confirm: true,
          kind: 'conflict',
          pending: { doc_id: doc.doc_id, text: doc.text, category: doc.category },
          conflicts,
        });
      }
    }
    const file = path.join(this.knowledgeDir, `${safeStem(doc.doc_id, 'doc')}.json`);
    const sqlite = this.knowledgeStore();
    const previous = (sqlite ? sqlite.getById(doc.doc_id) : null) ?? readJson(file);
    const now = nowIso();
    const data = {
      ...doc,
      created_at: typeof previous?.created_at === 'string' ? previous.created_at : now,
      updated_at: now,
      // Revision tracks sentence changes, not evidence counts. A preserved
      // mining merge must not look like a user edit in the panel.
      revision: previous
        ? (typeof previous.text === 'string' && previous.text !== doc.text
          ? (Number.isInteger(previous.revision) ? previous.revision + 1 : 1)
          : (Number.isInteger(previous.revision) ? previous.revision : 1))
        : 1,
    };
    if (previous) {
      // Provenance accumulates: the same fact confirmed in another layer is
      // stronger evidence, not a replacement. The first producer stays the
      // named source; later producers show up in the evidence trail.
      const evidence = [...(Array.isArray(previous.evidence) ? previous.evidence : [])];
      for (const item of doc.evidence) evidence.push(item);
      data.evidence = evidence.slice(-20);
      // Keep a short audit trail when the stored sentence itself changes.
      // `revision` alone cannot tell a restatement from a real value update.
      const changes = (Array.isArray(previous.changes) ? previous.changes : [])
        .filter((item) => item && typeof item === 'object')
        .slice(-4);
      if (typeof previous.text === 'string' && previous.text !== doc.text) {
        const detected = change ?? { kind: 'text', before: [previous.text], after: [doc.text] };
        changes.push({
          at: now,
          kind: detected.kind,
          before: detected.before,
          after: detected.after,
          previous_text: previous.text,
        });
      }
      if (changes.length > 0) data.changes = changes.slice(-5);
      const tags = [...new Set([
        ...(Array.isArray(previous.tags) ? previous.tags : []),
        ...doc.tags,
      ])].slice(0, 8);
      data.tags = tags;
      if (doc.url === '' && typeof previous.url === 'string') data.url = previous.url;
      const previousSource = typeof previous.source === 'string' ? previous.source : '';
      data.source = previousSource !== '' && previousSource !== 'unknown' ? previousSource : doc.source;
      // Never let a model claim downgrade a user/verified fact that happens to
      // share the same text. Provenance only moves up this ladder.
      const rank = { model: 0, authored: 1, user: 2 };
      const previousProvenance = normalizeProvenance(previous.provenance, previousSource);
      const previousConfirmed = previous.confirmed === true
        || (Array.isArray(previous.evidence)
          && previous.evidence.some((item) => item && item.kind === 'user-confirm'))
        || (normalizeSource(previousSource) === 'user-confirmed' && previous.verified === true);
      const previousVerified = typeof previous.verified === 'boolean'
        ? previous.verified
        : previousProvenance !== 'model';
      if ((rank[doc.provenance] ?? 0) < (rank[previousProvenance] ?? 0)) {
        data.provenance = previousProvenance;
      }
      data.confirmed = previousConfirmed || doc.confirmed === true;
      data.verified = data.confirmed || previousVerified || doc.verified === true;
      if (typeof previous.confidence === 'number') {
        data.confidence = Math.max(previous.confidence, doc.confidence);
      }
    }
    writeJson(file, data);
    this._bumpEpoch();
    this._rememberInDocumentsCache(data);
    this._knowledgeStatsCache = null;
    this._pendingKnowledgeCache = null;
    this._pendingPromotionsCache = null;
    // A confirmed update resolves any legacy review item for the same target.
    // Only an explicit user confirmation counts; a preserved mining merge is
    // not a resolution. New runs never enqueue, but old items may still exist.
    if (options.confirm === true && targetDoc && !preservedText) {
      this.clearPendingPromotionFor(targetDoc.doc_id, incomingText);
      // The user made the call; close the matching conflict report so the audit
      // trail does not keep the write in the "unconfirmed" count.
      this._settleConflicts(targetDoc.doc_id);
    }
    // Dual-write in SQLite mode: SQLite is the read path, the JSON file stays as
    // a mirror so switching back to the JSON backend loses nothing.
    sqlite?.upsert(data);
    return {
      ...data,
      merged: Boolean(previous),
      preserved_text: preservedText === true,
      file: this.relative(file),
    };
  }

  /**
   * Every knowledge document, newest first — always read from the JSON files.
   *
   * JSON is the canonical base: writes land there first so they can be inspected
   * and corrected, and SQL / RAG are derived views that never override it. The
   * SQLite mirror may lag or be edited externally without changing what the
   * knowledge base actually contains.
   */
  documents() {
    if (this._cacheFresh(this._documentsCache)) return this._documentsCache.docs.slice();
    const docs = [];
    for (const file of listJsonFiles(this.knowledgeDir)) {
      if (path.basename(file) === path.basename(this.promotedLedgerFile)) continue;
      const data = this._readJsonCached(file);
      if (!data || typeof data.doc_id !== 'string' || typeof data.text !== 'string') continue;
      docs.push(freezeDocument(this.normalizeStoredDoc(data)));
    }
    docs.sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
    this._documentsCache = { at: Date.now(), epoch: this._epoch(), docs };
    return docs.slice();
  }

  /** Search knowledge documents; see `retrieval.search`. */
  search(query, options = {}) {
    const topK = options.topK ?? this.defaultTopK;
    const mode = options.mode ?? 'hybrid';
    const category = options.category ?? null;
    const detail = options.detail === 'full' ? 'full' : 'summary';
    const cacheMode = ['auto', 'library', 'document'].includes(options.cacheMode)
      ? options.cacheMode : 'auto';
    const key = JSON.stringify([query, topK, mode, category, detail, cacheMode]);
    const cached = this._searchCache.get(key);
    if (cached && this._cacheFresh(cached)) return cached.hits.slice();
    const hits = searchDocs(this.documents(), query, { topK, category, mode, detail, cacheMode });
    this._searchCache.set(key, { at: Date.now(), epoch: this._epoch(), hits });
    if (this._searchCache.size > 16) {
      this._searchCache.delete(this._searchCache.keys().next().value);
    }
    return hits.slice();
  }

  /**
   * Confirm an existing knowledge document without changing its text.
   *
   * This is the missing lifecycle step for model-authored claims: the user can
   * say "yes, this is right" and clear the unverified badge while keeping the
   * same doc_id and evidence chain.
   *
   * @param {string} idOrPrefix
   * @returns {{verified: boolean, doc_id?: string, already?: boolean, reason?: string}}
   */
  verifyKnowledge(idOrPrefix) {
    const value = String(idOrPrefix ?? '').trim();
    if (value === '') return { verified: false, reason: '需要 doc_id' };
    let docId = '';
    let file = path.join(this.knowledgeDir, `${safeStem(value, 'doc')}.json`);
    if (fs.existsSync(file)) {
      docId = value;
    } else {
      const matches = this.documents().filter((doc) => doc.doc_id.startsWith(value));
      if (matches.length === 0) return { verified: false, reason: `未找到知识：${value}` };
      if (matches.length > 1) {
        return { verified: false, reason: `${value} 命中 ${matches.length} 篇，请给出更完整的 id` };
      }
      docId = matches[0].doc_id;
      file = path.join(this.knowledgeDir, `${safeStem(docId, 'doc')}.json`);
    }
    const current = this._readJsonCached(file);
    if (!current || typeof current.doc_id !== 'string') {
      return { verified: false, reason: `未找到知识：${docId}` };
    }
    if (current.verified === true && normalizeSource(current.source) !== 'unknown') {
      return { verified: true, doc_id: docId, already: true };
    }
    const now = nowIso();
    const updated = {
      ...current,
      // A user confirmation is a traceable source of its own. Leaving
      // `source: unknown` while writing verified:true made every later read
      // normalize the flag back to false; the panel then looked like a no-op.
      source: 'user-confirmed',
      provenance: 'user',
      confirmed: true,
      verified: true,
      updated_at: now,
      evidence: [
        ...(Array.isArray(current.evidence) ? current.evidence : []),
        { kind: 'user-confirm', ref: `source:${current.source ?? 'unknown'}`, at: now },
      ].slice(-20),
    };
    writeJson(file, updated);
    this._bumpEpoch();
    this._rememberInDocumentsCache(updated);
    this._knowledgeStatsCache = null;
    this._pendingKnowledgeCache = null;
    this._pendingPromotionsCache = null;
    const sqlite = this.knowledgeStore();
    if (sqlite) sqlite.upsert(this.normalizeStoredDoc(updated));
    return { verified: true, doc_id: docId, already: false };
  }

  /**
   * Undo a user confirmation: remove the confirmation evidence and restore the
   * source captured in its ref. Only documents with a real `user-confirm`
   * evidence row are eligible, so authored/verified facts cannot be demoted by
   * accident.
   */
  unverifyKnowledge(idOrPrefix) {
    const value = String(idOrPrefix ?? '').trim();
    if (value === '') return { verified: true, reason: '需要 doc_id' };
    let docId = '';
    let file = path.join(this.knowledgeDir, `${safeStem(value, 'doc')}.json`);
    if (fs.existsSync(file)) {
      docId = value;
    } else {
      const matches = this.documents().filter((doc) => doc.doc_id.startsWith(value));
      if (matches.length !== 1) return { verified: true, reason: `未找到唯一知识：${value}` };
      docId = matches[0].doc_id;
      file = path.join(this.knowledgeDir, `${safeStem(docId, 'doc')}.json`);
    }
    const current = this._readJsonCached(file);
    if (!current || typeof current.doc_id !== 'string') {
      return { verified: true, reason: `未找到知识：${docId}` };
    }
    const evidence = Array.isArray(current.evidence) ? current.evidence : [];
    const confirmations = evidence.filter((item) => item && item.kind === 'user-confirm');
    if (confirmations.length === 0) {
      return { verified: true, reason: '这条不是通过面板确认写入的，不能撤销' };
    }
    const firstRef = String(confirmations[0]?.ref ?? '');
    const restoredSource = firstRef.startsWith('source:') ? firstRef.slice('source:'.length) : 'unknown';
    const now = nowIso();
    const updated = {
      ...current,
      source: restoredSource || 'unknown',
      provenance: 'model',
      confirmed: false,
      verified: false,
      updated_at: now,
      evidence: evidence.filter((item) => !(item && item.kind === 'user-confirm')).slice(-20),
    };
    writeJson(file, updated);
    this._bumpEpoch();
    this._rememberInDocumentsCache(updated);
    this._knowledgeStatsCache = null;
    this._pendingKnowledgeCache = null;
    this._pendingPromotionsCache = null;
    const sqlite = this.knowledgeStore?.();
    if (sqlite) sqlite.upsert(this.normalizeStoredDoc(updated));
    return { verified: false, doc_id: docId, undone: true };
  }

  /**
   * Delete one knowledge document by id (or id prefix).
   *
   * A wrong fact is worse than a missing one, so the corpus needs a way out;
   * the deletion is reported instead of silently succeeding.
   *
   * @param {string} idOrPrefix
   * @returns {{deleted: boolean, doc_id?: string, reason?: string}}
   */
  forgetKnowledge(idOrPrefix) {
    const value = String(idOrPrefix ?? '').trim();
    if (value === '') return { deleted: false, reason: '需要 doc_id' };
    const remove = (docId) => {
      const file = path.join(this.knowledgeDir, `${safeStem(docId, 'doc')}.json`);
      if (fs.existsSync(file)) fs.rmSync(file);
      this._fileCache.delete(file);
      this._bumpEpoch();
      this._removeFromDocumentsCache(docId);
      this._knowledgeStatsCache = null;
      this._pendingKnowledgeCache = null;
      this._pendingPromotionsCache = null;
      const sqlite = this.knowledgeStore();
      if (sqlite) sqlite.remove(docId);
      // Drop its recency entry too, so a forgotten document cannot rank.
      const usage = this.knowledgeUsage();
      if (Object.hasOwn(usage, docId)) {
        delete usage[docId];
        writeJson(this.knowledgeUsageFile, { version: 1, updated_at: nowIso(), docs: usage }, { durable: false });
      }
      // Forget the mining ledger entry too, so a corrected extraction can
      // re-mine the same layer item instead of being blocked forever.
      const ledger = this.promotedLedger();
      const refs = {};
      for (const [ref, entry] of Object.entries(ledger.refs)) {
        if (entry && entry.doc_id === docId) continue;
        refs[ref] = entry;
      }
      writeJson(this.promotedLedgerFile, {
        version: EXTRACTION_VERSION,
        schema_version: SCHEMA_VERSION,
        updated_at: nowIso(),
        refs,
      }, { durable: false });
      this._bumpEpoch();
      this._promotedLedgerCache = null;
    };
    const direct = path.join(this.knowledgeDir, `${safeStem(value, 'doc')}.json`);
    if (fs.existsSync(direct)) {
      remove(value);
      return { deleted: true, doc_id: value };
    }
    const matches = this.documents().filter((doc) => doc.doc_id.startsWith(value));
    if (matches.length === 0) return { deleted: false, reason: `未找到知识：${value}` };
    if (matches.length > 1) {
      return { deleted: false, reason: `${value} 命中 ${matches.length} 篇，请给出更完整的 id` };
    }
    remove(matches[0].doc_id);
    return { deleted: true, doc_id: matches[0].doc_id };
  }

  /** `{documents, categories, sources}` for the knowledge layer. */
  knowledgeStats() {
    if (this._cacheFresh(this._knowledgeStatsCache)) {
      return {
        ...this._knowledgeStatsCache.value,
        categories: { ...this._knowledgeStatsCache.value.categories },
        sources: { ...this._knowledgeStatsCache.value.sources },
      };
    }
    const docs = this.documents();
    const categories = {};
    const sources = {};
    for (const doc of docs) {
      categories[doc.category] = (categories[doc.category] ?? 0) + 1;
      sources[doc.source] = (sources[doc.source] ?? 0) + 1;
    }
    const value = { documents: docs.length, categories, sources, pendingUpdates: this.pendingPromotions().length };
    this._knowledgeStatsCache = { at: Date.now(), epoch: this._epoch(), value };
    return value;
  }

  /** Ledger of layer items already mined into knowledge. */
  promotedLedger() {
    if (this._cacheFresh(this._promotedLedgerCache)) {
      return { ...this._promotedLedgerCache.value, refs: { ...this._promotedLedgerCache.value.refs } };
    }
    const data = this._readJsonCached(this.promotedLedgerFile);
    // A ledger written by an older extractor is stale: re-evaluate the corpus
    // with the current rules instead of trusting the previous pass.
    if (!data || data.version !== EXTRACTION_VERSION) {
      const empty = { updated_at: '', refs: {} };
      this._promotedLedgerCache = { at: Date.now(), epoch: this._epoch(), value: empty };
      return { ...empty, refs: {} };
    }
    const refs = typeof data.refs === 'object' && data.refs !== null ? data.refs : {};
    const value = { updated_at: typeof data.updated_at === 'string' ? data.updated_at : '', refs };
    this._promotedLedgerCache = { at: Date.now(), epoch: this._epoch(), value };
    return { ...value, refs: { ...refs } };
  }

  /** Record mined refs so `promote` never re-derives the same fact twice. */
  markPromoted(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return;
    const ledger = this.promotedLedger();
    const now = nowIso();
    for (const entry of entries) {
      if (!entry || typeof entry.ref !== 'string' || entry.ref === '') continue;
      ledger.refs[entry.ref] = { at: now, doc_id: String(entry.doc_id ?? '') };
    }
    // Do not evict old refs: dropping one makes its source item look fresh and
    // promote re-mines the whole lifetime again. Refs are small; correctness and
    // bounded work matter more than a few hundred KB of ledger.
    writeJson(this.promotedLedgerFile, {
      version: EXTRACTION_VERSION,
      schema_version: SCHEMA_VERSION,
      updated_at: now,
      refs: ledger.refs,
    }, { durable: false });
    this._bumpEpoch();
    this._promotedLedgerCache = {
      at: Date.now(),
      epoch: this._epoch(),
      value: { updated_at: now, refs: { ...ledger.refs } },
    };
    this._pendingKnowledgeCache = null;
  }

  /**
   * Rough count of layer items not yet mined. Used for the "待提炼" line: it is
   * an upper bound (one item can yield no candidate at all), not a promise.
   */
  pendingKnowledge() {
    if (this._cacheFresh(this._pendingKnowledgeCache)) return this._pendingKnowledgeCache.value;
    const ledger = this.promotedLedger();
    const mined = Object.keys(ledger.refs).length;
    let total = this.stagingRecords().length + this.archivedCount();
    for (const row of this.listContexts()) total += Number(row.turn_count ?? 0);
    total += this.decisionStats().total;
    const value = Math.max(0, total - mined);
    this._pendingKnowledgeCache = { at: Date.now(), epoch: this._epoch(), value };
    return value;
  }

  /**
   * Legacy review queue: proposals written by older versions that a mining run
   * wanted to apply to an existing document.
   *
   * New runs no longer enqueue anything: a conflict or value change is reported
   * in the tool result, and the user's "use the new value" is applied with
   * `remember(..., { confirm: true })` plus the target `doc_id`. These readers
   * stay so already-queued items can still be reviewed or ignored.
   *
   * They live under pending/, not knowledge/, because an unconfirmed proposal is
   * not a fact: it must never appear in search or in `documents()`.
   */
  pendingPromotions() {
    if (this._cacheFresh(this._pendingPromotionsCache)) return this._pendingPromotionsCache.items.slice();
    const data = this._readJsonCached(this.knowledgePendingFile);
    const items = Array.isArray(data?.items)
      ? data.items.filter((item) => item && typeof item.pending_id === 'string')
      : [];
    this._pendingPromotionsCache = { at: Date.now(), epoch: this._epoch(), items };
    return items.slice();
  }

  /** Legacy only: record one queued proposal (older mining runs called this). */
  recordPendingPromotion(item) {
    this.init();
    const target = typeof item?.update_of === 'string' ? item.update_of : '';
    const text = typeof item?.text === 'string' ? item.text : '';
    if (target === '' || text === '') return null;
    const pendingId = `pending_${hash40(`${target}\n${text}`).slice(0, 12)}`;
    const now = nowIso();
    const items = this.pendingPromotions();
    const existing = items.find((row) => row.pending_id === pendingId);
    const next = {
      pending_id: pendingId,
      update_of: target,
      text,
      category: typeof item.category === 'string' ? item.category : '',
      source: typeof item.source === 'string' ? item.source : '',
      source_ref: typeof item.source_ref === 'string' ? item.source_ref : '',
      provenance: typeof item.provenance === 'string' ? item.provenance : 'model',
      verified: item.verified === true,
      reason: typeof item.reason === 'string' ? item.reason : 'update',
      conflicts: Array.isArray(item.conflicts) ? item.conflicts.slice(0, 3) : [],
      first_seen_at: existing?.first_seen_at ?? now,
      last_seen_at: now,
      seen_count: Number.isInteger(existing?.seen_count) ? existing.seen_count + 1 : 1,
    };
    const rest = items.filter((row) => row.pending_id !== pendingId);
    rest.unshift(next);
    writeJson(this.knowledgePendingFile, {
      version: 1,
      updated_at: now,
      items: rest.slice(0, 30),
    }, { durable: false });
    this._bumpEpoch();
    this._pendingPromotionsCache = null;
    this._knowledgeStatsCache = null;
    return next;
  }

  /** Drop a proposal once the user confirms (or deletes) the target fact. */
  clearPendingPromotionFor(target, text) {
    const items = this.pendingPromotions();
    if (items.length === 0) return 0;
    const kept = items.filter((row) => !(row.update_of === target && row.text === text));
    const removed = items.length - kept.length;
    if (removed > 0) {
      writeJson(this.knowledgePendingFile, {
        version: 1,
        updated_at: nowIso(),
        items: kept,
      }, { durable: false });
      this._bumpEpoch();
      this._pendingPromotionsCache = null;
      this._knowledgeStatsCache = null;
    }
    return removed;
  }

  /**
   * Recent conflict reports, newest first, each with a computed `resolved` flag.
   *
   * This is an audit trail, not a queue: a report is never applied and never
   * appears in `documents()` or search. `resolved` means a later
   * `remember(..., { confirm: true })` wrote the same target document.
   */
  conflictLog(limit = 20) {
    const max = Number.isInteger(limit) && limit > 0 ? limit : 20;
    if (this._cacheFresh(this._conflictsCache)) {
      const cached = this._conflictsCache.value;
      return { ...cached, items: cached.items.slice(0, max) };
    }
    const lines = readJsonl(this.conflictsFile);
    const resolvedIds = new Set();
    for (const line of lines) {
      if (line?.type === 'resolved' && typeof line.conflict_id === 'string') {
        resolvedIds.add(line.conflict_id);
      }
    }
    const items = [];
    for (const line of lines) {
      if (line?.type !== 'conflict') continue;
      items.push({
        conflict_id: typeof line.conflict_id === 'string' ? line.conflict_id : '',
        at: typeof line.at === 'string' ? line.at : '',
        kind: typeof line.kind === 'string' ? line.kind : 'conflict',
        doc_id: typeof line.doc_id === 'string' ? line.doc_id : '',
        text: typeof line.text === 'string' ? line.text : '',
        category: typeof line.category === 'string' ? line.category : '',
        conflicts: Array.isArray(line.conflicts) ? line.conflicts.slice(0, 3) : [],
        resolved: typeof line.conflict_id === 'string' && resolvedIds.has(line.conflict_id),
      });
    }
    items.reverse();
    const value = {
      items,
      open: items.filter((row) => !row.resolved).length,
      total: items.length,
    };
    this._conflictsCache = { at: Date.now(), epoch: this._epoch(), value };
    return { ...value, items: items.slice(0, max) };
  }

  /**
   * Record one blocked write in `knowledge/conflicts.jsonl` and return the
   * result unchanged. Logging is best effort: the gate must still work when the
   * audit file cannot be written.
   */
  reportConflict(result) {
    if (!result || result.needs_confirm !== true) return result;
    const conflicts = Array.isArray(result.conflicts) ? result.conflicts.slice(0, 3) : [];
    const target = conflicts.find((row) => row && typeof row === 'object'
      && typeof row.doc_id === 'string');
    const text = typeof result.pending?.text === 'string' ? result.pending.text : '';
    const docId = typeof target?.doc_id === 'string' ? target.doc_id : '';
    const at = nowIso();
    const record = {
      type: 'conflict',
      conflict_id: `conf_${hash40(`${docId}\n${text}\n${at}`).slice(0, 12)}`,
      at,
      kind: typeof result.kind === 'string' ? result.kind : 'conflict',
      doc_id: docId,
      text,
      category: typeof result.pending?.category === 'string' ? result.pending.category : '',
      // Only what a user needs to judge: the old fact and the detected delta.
      conflicts: conflicts.map((row) => ({
        doc_id: row.doc_id,
        text: row.text,
        category: row.category,
        similarity: row.similarity,
        update: row.update === true,
        change: row.change ?? null,
      })),
    };
    try {
      appendJsonLine(this.conflictsFile, record);
    } catch {
      return result;
    }
    this._bumpEpoch();
    this._conflictsCache = null;
    return result;
  }

  /** Mark earlier reports for this document resolved after a confirmed write. */
  _settleConflicts(docId) {
    if (typeof docId !== 'string' || docId === '') return;
    const open = this.conflictLog(200).items
      .filter((row) => row.doc_id === docId && !row.resolved);
    if (open.length === 0) return;
    const at = nowIso();
    let wrote = false;
    for (const row of open.slice(0, 20)) {
      try {
        appendJsonLine(this.conflictsFile, {
          type: 'resolved',
          conflict_id: row.conflict_id,
          at,
          doc_id: docId,
        });
        wrote = true;
      } catch { /* audit only */ }
    }
    if (wrote) {
      this._bumpEpoch();
      this._conflictsCache = null;
    }
  }

  /**
   * Mine the three layers for knowledge and write it.
   *
   * Sources: the process log, the categorized archive, archived conversation
   * contexts (user-stated rules only) and decision reviews. Each mined item is
   * deduplicated against existing knowledge and remembered in a ledger, so a
   * second run adds nothing.
   *
   * @param {{dryRun?: boolean, limit?: number}} [options]
   * @returns {{dryRun: boolean, scanned: object, added: object[], merged: object[],
   *   pending: object[], skipped: number, remaining: number}}
   */
  promoteKnowledge(options = {}) {
    const dryRun = options.dryRun === true;
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 60;
    this.init();

    const ledger = this.promotedLedger();
    const already = new Set(Object.keys(ledger.refs));
    const candidates = [];
    const refs = [];
    const scanned = { staging: 0, archive: 0, contexts: 0, decisions: 0 };
    const skippedUnverified = { staging: 0, archive: 0 };

    for (const row of this.stagingRecords()) {
      // Unverified records are the model talking to itself. Leave them pending
      // (do not consume their refs), so they cannot be laundered into knowledge
      // and can still be mined after a real verification step.
      if (row.verify !== 'pass') {
        skippedUnverified.staging += 1;
        continue;
      }
      scanned.staging += 1;
      const ref = `staging:${String(row.dedup_id ?? '')}`;
      if (already.has(ref)) continue;
      refs.push(ref);
      for (const candidate of candidatesFromRecord(row, 'staging')) candidates.push(candidate);
    }
    for (const category of CATEGORIES) {
      for (const row of this.archiveEntries(category, 500)) {
        if (row.verify !== 'pass') {
          skippedUnverified.archive += 1;
          continue;
        }
        scanned.archive += 1;
        const ref = `archive:${String(row.dedup_id ?? '')}`;
        if (already.has(ref)) continue;
        refs.push(ref);
        for (const candidate of candidatesFromRecord(row, 'archive')) candidates.push(candidate);
      }
    }
    for (const meta of this.listContexts()) {
      const count = Number(meta.turn_count ?? 0);
      const contextId = String(meta.context_id);
      // Sequential turn refs let us skip an already mined context without
      // parsing its full turns again. Non-sequential numbering falls through to
      // the normal safe path.
      if (Number.isInteger(count) && count > 0) {
        let covered = true;
        for (let turn = 1; turn <= count; turn += 1) {
          if (!already.has(`context:${contextId}#turn${turn}`)) {
            covered = false;
            break;
          }
        }
        if (covered) continue;
      }
      const record = this.loadContext(meta.context_id);
      if (!record) continue;
      for (const turn of Array.isArray(record.turns) ? record.turns : []) {
        const ref = `context:${record.context_id}#turn${turn?.turn ?? '?'}`;
        if (already.has(ref)) continue;
        scanned.contexts += 1;
        refs.push(ref);
        for (const candidate of candidatesFromTurn(turn, record.context_id)) candidates.push(candidate);
      }
    }
    for (const row of this.decisionRecords(500)) {
      const ref = `decision:${String(row.decision_id ?? '')}`;
      if (already.has(ref)) continue;
      scanned.decisions += 1;
      refs.push(ref);
      for (const candidate of candidatesFromDecision(row)) candidates.push(candidate);
    }

    const fresh = candidates.filter((candidate) => !already.has(candidate.source_ref));
    const work = withTokens(this.documents());
    const added = [];
    const merged = [];
    const pending = [];
    const processedRefs = new Set();
    const promotedEntries = [];
    let skipped = 0;

    for (const candidate of fresh) {
      if (added.length + merged.length >= limit) break;
      const duplicate = findDuplicate(candidate.text, work);
      const record = {
        doc_id: duplicate ? duplicate.doc_id : knowledgeKey(candidate.text),
        text: candidate.text,
        category: candidate.category,
        source: candidate.source,
        tags: candidate.tags,
        url: candidate.url,
        confidence: candidate.confidence,
        provenance: candidate.provenance ?? 'model',
        verified: candidate.verified === true,
        evidence: [{ kind: candidate.source_ref.split(':')[0], ref: candidate.source_ref, at: new Date().toISOString() }],
      };

      if (dryRun) {
        // Preview only: report a material change as a pending update instead of
        // pretending it would silently merge.
        const change = duplicate ? materialChange(duplicate.text, candidate.text) : null;
        if (duplicate && change) {
          pending.push({
            update_of: duplicate.doc_id,
            text: candidate.text,
            category: candidate.category,
            source: candidate.source,
            source_ref: candidate.source_ref,
            reason: 'update',
            change,
          });
          skipped += 1;
          continue;
        }
        processedRefs.add(candidate.source_ref);
        if (duplicate) {
          merged.push({
            doc_id: duplicate.doc_id,
            text: duplicate.text,
            proposed_text: candidate.text,
            source_ref: candidate.source_ref,
            provenance: candidate.provenance ?? 'model',
            verified: candidate.verified === true,
            preserved: duplicate.text !== candidate.text,
          });
        } else {
          added.push({
            doc_id: record.doc_id,
            text: candidate.text,
            category: candidate.category,
            source: candidate.source,
            provenance: candidate.provenance ?? 'model',
            verified: candidate.verified === true,
          });
          work.push(withTokens([record])[0]);
        }
        continue;
      }

      // Mining may support an existing fact, but it may not rewrite it. A
      // material change comes back as `needs_confirm`; report it in `pending`
      // for the caller to confirm, and leave the source ref unconsumed so a
      // later review still sees it. Nothing is queued in pending/ anymore.
      const saved = this.remember(record, { preserveText: true });
      if (saved?.needs_confirm) {
        const item = {
          ...(saved.pending ?? {
            doc_id: duplicate?.doc_id ?? record.doc_id,
            text: candidate.text,
            category: candidate.category,
          }),
          update_of: saved.pending?.update_of ?? duplicate?.doc_id ?? '',
          source: candidate.source,
          source_ref: candidate.source_ref,
          provenance: candidate.provenance ?? 'model',
          verified: candidate.verified === true,
          reason: saved.kind ?? 'update',
          conflicts: Array.isArray(saved.conflicts) ? saved.conflicts : [],
        };
        pending.push(item);
        skipped += 1;
        continue;
      }
      processedRefs.add(candidate.source_ref);
      if (saved?.merged) {
        merged.push({
          doc_id: saved.doc_id,
          text: saved.text,
          proposed_text: candidate.text,
          source_ref: candidate.source_ref,
          provenance: candidate.provenance ?? 'model',
          verified: candidate.verified === true,
          preserved: saved.preserved_text === true,
        });
      } else {
        added.push({
          doc_id: saved.doc_id,
          text: saved.text,
          category: saved.category,
          source: saved.source,
          provenance: saved.provenance,
          verified: saved.verified === true,
        });
        work.push(withTokens([saved])[0]);
      }
      if (!dryRun) promotedEntries.push({ ref: candidate.source_ref, doc_id: saved.doc_id });
    }

    // Batch ledger writes: a per-candidate write re-serialized the whole ledger
    // for every mined fact.
    if (!dryRun && promotedEntries.length > 0) this.markPromoted(promotedEntries);

    // An item that produced no candidate can never produce one later, so it is
    // consumed as well — otherwise "待提炼" would never reach zero. Candidate
    // refs left over the per-run budget stay pending for the next run.
    const candidateRefs = new Set(candidates.map((candidate) => candidate.source_ref));
    if (!dryRun) {
      const consumed = [];
      for (const ref of refs) {
        if (already.has(ref)) continue;
        if (candidateRefs.has(ref) && !processedRefs.has(ref)) continue;
        consumed.push({ ref, doc_id: '' });
      }
      if (consumed.length > 0) this.markPromoted(consumed);
    }

    return {
      dryRun,
      scanned,
      added,
      merged,
      pending,
      skipped,
      skippedUnverified,
      remaining: Math.max(0, fresh.length - processedRefs.size),
    };
  }

  // ---- decisions ---------------------------------------------------------

  /** Persist one decision review record. */
  recordDecision(result) {
    this.init();
    const file = path.join(this.decisionDir, `${safeStem(result.decision_id, 'decision')}.json`);
    writeJson(file, result);
    // Only the decision views depend on this file. Bumping the global epoch
    // here made every auto-logged turn invalidate the knowledge/staging views
    // too, so the next status re-scanned layers that had not changed.
    this._invalidateDecisions();
    return { file: this.relative(file) };
  }

  /** `{outcome: count}` and total decisions. */
  decisionStats() {
    if (this._cacheFresh(this._decisionsCache?.stats)) {
      return { ...this._decisionsCache.stats.value };
    }
    const byOutcome = {};
    let total = 0;
    for (const file of listJsonFiles(this.decisionDir)) {
      const data = this._readJsonCached(file);
      if (!data || typeof data.outcome !== 'string') continue;
      total += 1;
      byOutcome[data.outcome] = (byOutcome[data.outcome] ?? 0) + 1;
    }
    const value = { total, byOutcome };
    this._decisionsCache = { ...(this._decisionsCache ?? {}), stats: { at: Date.now(), epoch: this._epoch(), value } };
    return { ...value };
  }

  /** Recent decision records, newest first. */
  decisionRecords(limit = 100) {
    const cache = this._decisionsCache?.rows;
    if (cache && cache.limit >= limit && this._cacheFresh(cache)) return cache.rows.slice(0, limit);
    const rows = [];
    for (const file of listJsonFiles(this.decisionDir)) {
      const data = this._readJsonCached(file);
      if (!data || typeof data.decision_id !== 'string') continue;
      rows.push({
        decision_id: data.decision_id,
        decision: data.decision,
        kind: typeof data.kind === 'string' ? data.kind : 'review',
        risk_level: data.risk_level,
        outcome: data.outcome,
        approved: data.approved === true,
        reviewed: data.reviewed === true,
        thesis: data.thesis,
        antithesis: data.antithesis,
        reason: data.reason,
        timestamp: data.timestamp,
      });
    }
    rows.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    this._decisionsCache = {
      ...(this._decisionsCache ?? {}),
      rows: { at: Date.now(), epoch: this._epoch(), limit, rows },
    };
    return rows.slice(0, limit);
  }

  // ---- contexts (archived conversation windows) -------------------------

  /**
   * Store one archived conversation window.
   *
   * @param {{label?: string, sessionId?: string, turnFrom: number, turnTo: number,
   *   turns: Array<object>, text: string, chars: number}} input
   */
  saveContext(input) {
    this.init();
    const now = new Date();
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
      + `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    let contextId = `context_${stamp}_${Math.random().toString(16).slice(2, 6)}`;
    while (fs.existsSync(path.join(this.contextDir, `${contextId}.json`))) {
      contextId = `context_${stamp}_${Math.random().toString(16).slice(2, 6)}`;
    }

    const record = {
      context_id: contextId,
      label: typeof input.label === 'string' && input.label.trim() !== '' ? input.label.trim() : 'manual',
      session_id: typeof input.sessionId === 'string' ? input.sessionId : '',
      created_at: nowIso(now),
      turn_from: input.turnFrom,
      turn_to: input.turnTo,
      turn_count: Array.isArray(input.turns) ? input.turns.length : 0,
      chars: input.chars ?? 0,
      turns: Array.isArray(input.turns) ? input.turns : [],
      text: input.text ?? '',
    };
    // Raw event rows preserve the original event payloads, including
    // tool/call arguments and developer messages. The rendered `turns`/`text`
    // fields are display-shaped; restore applies its own budget and tool-result
    // cap when reading these rows.
    if (Array.isArray(input.raw_events) && input.raw_events.length > 0) {
      record.raw_events = input.raw_events;
    }
    if (typeof input.model_summary === 'string' && input.model_summary.trim() !== '') {
      record.model_summary = input.model_summary.trim();
    }
    writeJson(path.join(this.contextDir, `${contextId}.json`), record);
    this._bumpEpoch();
    this._invalidateContexts();
    return {
      context_id: record.context_id,
      label: record.label,
      created_at: record.created_at,
      turn_from: record.turn_from,
      turn_to: record.turn_to,
      turn_count: record.turn_count,
      chars: record.chars,
      file: this.relative(path.join(this.contextDir, `${contextId}.json`)),
    };
  }

  /** Context archive metadata, newest first. */
  listContexts() {
    if (this._cacheFresh(this._contextsCache)) return this._contextsCache.rows.slice();
    const rows = [];
    for (const file of listJsonFiles(this.contextDir)) {
      const data = this._readJsonCached(file);
      if (!data || typeof data.context_id !== 'string') continue;
      rows.push({
        context_id: data.context_id,
        label: data.label ?? '',
        session_id: data.session_id ?? '',
        created_at: data.created_at ?? '',
        turn_from: data.turn_from ?? 0,
        turn_to: data.turn_to ?? 0,
        turn_count: data.turn_count ?? 0,
        chars: data.chars ?? 0,
        // The panel renders the archived text inside a collapsible row, so the
        // list carries a capped copy; the full text stays in contexts/<id>.json.
        text: typeof data.text === 'string' ? data.text.slice(0, 6000) : '',
        model_summary: typeof data.model_summary === 'string' ? data.model_summary.slice(0, 600) : '',
      });
    }
    rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    this._contextsCache = { at: Date.now(), epoch: this._epoch(), rows };
    return rows.slice();
  }

  /** Load one archived context by exact id or id prefix. */
  loadContext(idOrPrefix) {
    const value = String(idOrPrefix ?? '').trim();
    if (value === '') return null;
    const exact = this._readJsonCached(path.join(this.contextDir, `${value}.json`));
    if (exact) return exact;
    let match = null;
    for (const row of this.listContexts()) {
      if (!row.context_id.startsWith(value)) continue;
      if (!match || String(row.created_at) > String(match.created_at)) match = row;
    }
    return match ? this._readJsonCached(path.join(this.contextDir, `${match.context_id}.json`)) : null;
  }

  /** Record the last compaction attempt so the panel and status can show it. */
  writeCompactionStatus(input) {
    this.init();
    writeJson(this.compactionStatusFile, { at: nowIso(), ...input }, { durable: false });
  }

  /** Last compaction attempt, or null when none has run. */
  readCompactionStatus() {
    return readJson(this.compactionStatusFile);
  }

  // ---- overview ----------------------------------------------------------

  /** Model-facing summary of every layer. */
  status() {
    const stagingFiles = listJsonlFiles(this.stagingDir);
    const staged = this.stagingRecords();
    const snapshots = this.listSnapshots();
    const knowledge = this.knowledgeStats();
    const decisions = this.decisionStats();
    const recent = staged.slice(-5).map((row) => ({
      kind: row.kind,
      content: clip(row.content, 120),
      timestamp: row.timestamp,
    }));

    return {
      root: this.root,
      staging: { files: stagingFiles.length, entries: staged.length },
      archive: this.archiveStats(),
      snapshots: {
        count: snapshots.length,
        latest: snapshots.length > 0 ? snapshots[snapshots.length - 1].snapshot_id : null,
      },
      knowledge: {
        documents: knowledge.documents,
        categories: knowledge.categories,
        sources: knowledge.sources,
        pending: this.pendingKnowledge(),
        pendingUpdates: this.pendingPromotions().length,
        conflicts: this.conflictLog(5),
      },
      decisions,
      contexts: this.listContexts().length,
      recent,
    };
  }
}
