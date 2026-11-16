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
} from './util.js';
import { search as searchDocs } from './retrieval.js';
import {
  EXTRACTION_VERSION,
  candidatesFromDecision,
  candidatesFromRecord,
  candidatesFromTurn,
  findConflicts,
  findDuplicate,
  knowledgeKey,
  normalizeCategory,
  normalizeKnowledge,
  withTokens,
} from './knowledge.js';

const START_MARKER = 'START_MARKER';
const ARCHIVE_ENTRY = 'ARCHIVE_ENTRY';

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
    this.compactionStatusFile = path.join(this.root, 'compaction_status.json');
    this.promotedLedgerFile = path.join(this.knowledgeDir, '_promoted.json');
    this.maxContentChars = options.maxContentChars ?? 20000;
    this.maxSnapshotBytes = options.maxSnapshotBytes ?? 262144;
    this.defaultTopK = options.defaultTopK ?? 5;
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
    ]) {
      ensureDir(dir);
    }
    return this;
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
    appendJsonLine(file, record);
    return { ...record, category: CATEGORY_MAP[kind] };
  }

  /** Read every staging record, oldest file first. */
  stagingRecords() {
    const records = [];
    for (const file of listJsonlFiles(this.stagingDir)) records.push(...readJsonl(file));
    return records;
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
      if (!processed.has(category)) {
        processed.set(category, new Set(
          readJsonl(this.categoryFile(category))
            .filter((row) => row.type !== START_MARKER && row.dedup_id)
            .map((row) => row.dedup_id),
        ));
      }
      return processed.get(category);
    };

    const pending = [];
    for (const record of staged) {
      if (!record.dedup_id) {
        stats.failed += 1;
        continue;
      }
      const targets = forced !== null ? [forced] : [CATEGORY_MAP[record.kind] ?? 'action_logs'];
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
    return stats;
  }

  /** Absolute path of one category file. */
  categoryFile(category) {
    if (!CATEGORIES.includes(category)) throw new Error(`未知归档分类：${category}`);
    return path.join(this.archiveDir, `${category}.jsonl`);
  }

  /** Number of archive entries (markers excluded), globally or per category. */
  archivedCount(category = null) {
    const countFile = (file) => readJsonl(file).filter((row) => row.type !== START_MARKER).length;
    if (category !== null) return countFile(this.categoryFile(category));
    return listJsonlFiles(this.archiveDir).reduce((sum, file) => sum + countFile(file), 0);
  }

  /** Recent archive entries of one category, newest first. */
  archiveEntries(category, limit = 50) {
    const rows = readJsonl(this.categoryFile(category))
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
    const stats = {};
    for (const file of listJsonlFiles(this.archiveDir)) {
      const category = path.basename(file, '.jsonl');
      stats[category] = readJsonl(file).filter((row) => row.type !== START_MARKER).length;
    }
    return stats;
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

  // ---- knowledge ---------------------------------------------------------

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
   * `{ confirm: true }`. Programmatic mining passes `confirm: true` because it
   * merges near-identical statements rather than replacing a user decision.
   *
   * @param {{doc_id?: string, text: string, category?: string, source?: string,
   *   tags?: string[], url?: string, confidence?: number, evidence?: object[]}} input
   * @param {{confirm?: boolean}} [options]
   */
  remember(input, options = {}) {
    const doc = normalizeKnowledge(input);
    if (doc.text.length > this.maxContentChars) {
      throw new Error(`text 过长（${doc.text.length} 字符，上限 ${this.maxContentChars}）`);
    }

    this.init();
    if (options.confirm !== true) {
      const conflicts = findConflicts(doc.text, withTokens(this.documents()));
      if (conflicts.length > 0) {
        return {
          needs_confirm: true,
          pending: { doc_id: doc.doc_id, text: doc.text, category: doc.category },
          conflicts,
        };
      }
    }
    const file = path.join(this.knowledgeDir, `${safeStem(doc.doc_id, 'doc')}.json`);
    const previous = readJson(file);
    const now = nowIso();
    const data = {
      ...doc,
      created_at: typeof previous?.created_at === 'string' ? previous.created_at : now,
      updated_at: now,
      revision: Number.isInteger(previous?.revision) ? previous.revision + 1 : 1,
    };
    if (previous) {
      // Provenance accumulates: the same fact confirmed in another layer is
      // stronger evidence, not a replacement. The first producer stays the
      // named source; later producers show up in the evidence trail.
      const evidence = [...(Array.isArray(previous.evidence) ? previous.evidence : [])];
      for (const item of doc.evidence) evidence.push(item);
      data.evidence = evidence.slice(-20);
      const tags = [...new Set([
        ...(Array.isArray(previous.tags) ? previous.tags : []),
        ...doc.tags,
      ])].slice(0, 8);
      data.tags = tags;
      if (doc.url === '' && typeof previous.url === 'string') data.url = previous.url;
      const previousSource = typeof previous.source === 'string' ? previous.source : '';
      data.source = previousSource !== '' && previousSource !== 'unknown' ? previousSource : doc.source;
      if (typeof previous.confidence === 'number') {
        data.confidence = Math.max(previous.confidence, doc.confidence);
      }
    }
    writeJson(file, data);
    return { ...data, merged: Boolean(previous), file: this.relative(file) };
  }

  /** Every knowledge document, newest first. */
  documents() {
    const docs = [];
    for (const file of listJsonFiles(this.knowledgeDir)) {
      if (path.basename(file) === path.basename(this.promotedLedgerFile)) continue;
      const data = readJson(file);
      if (!data || typeof data.doc_id !== 'string' || typeof data.text !== 'string') continue;
      docs.push({
        doc_id: data.doc_id,
        text: data.text,
        // Legacy documents may carry a pre-taxonomy category; reading through
        // the normalizer keeps the corpus in one closed set.
        category: normalizeCategory(data.category),
        source: typeof data.source === 'string' ? data.source : 'unknown',
        tags: Array.isArray(data.tags) ? data.tags.filter((tag) => typeof tag === 'string') : [],
        url: typeof data.url === 'string' ? data.url : '',
        confidence: typeof data.confidence === 'number' ? data.confidence : 0.8,
        evidence: Array.isArray(data.evidence) ? data.evidence : [],
        created_at: typeof data.created_at === 'string' ? data.created_at : '',
        updated_at: typeof data.updated_at === 'string' ? data.updated_at : '',
        revision: Number.isInteger(data.revision) ? data.revision : 1,
      });
    }
    docs.sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
    return docs;
  }

  /** Search knowledge documents; see `retrieval.search`. */
  search(query, options = {}) {
    return searchDocs(this.documents(), query, {
      topK: options.topK ?? this.defaultTopK,
      category: options.category ?? null,
      mode: options.mode ?? 'hybrid',
    });
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
      fs.rmSync(path.join(this.knowledgeDir, `${safeStem(docId, 'doc')}.json`));
      // Forget the mining ledger entry too, so a corrected extraction can
      // re-mine the same layer item instead of being blocked forever.
      const ledger = this.promotedLedger();
      const refs = {};
      for (const [ref, entry] of Object.entries(ledger.refs)) {
        if (entry && entry.doc_id === docId) continue;
        refs[ref] = entry;
      }
      writeJson(this.promotedLedgerFile, { version: EXTRACTION_VERSION, updated_at: nowIso(), refs });
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
    const docs = this.documents();
    const categories = {};
    const sources = {};
    for (const doc of docs) {
      categories[doc.category] = (categories[doc.category] ?? 0) + 1;
      sources[doc.source] = (sources[doc.source] ?? 0) + 1;
    }
    return { documents: docs.length, categories, sources };
  }

  /** Ledger of layer items already mined into knowledge. */
  promotedLedger() {
    const data = readJson(this.promotedLedgerFile);
    // A ledger written by an older extractor is stale: re-evaluate the corpus
    // with the current rules instead of trusting the previous pass.
    if (!data || data.version !== EXTRACTION_VERSION) {
      return { updated_at: '', refs: {} };
    }
    const refs = typeof data.refs === 'object' && data.refs !== null ? data.refs : {};
    return { updated_at: typeof data.updated_at === 'string' ? data.updated_at : '', refs };
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
    // Keep the ledger bounded without losing the newest entries.
    const keys = Object.keys(ledger.refs);
    if (keys.length > 4000) {
      for (const key of keys.slice(0, keys.length - 4000)) delete ledger.refs[key];
    }
    writeJson(this.promotedLedgerFile, { version: EXTRACTION_VERSION, updated_at: now, refs: ledger.refs });
  }

  /**
   * Rough count of layer items not yet mined. Used for the "待提炼" line: it is
   * an upper bound (one item can yield no candidate at all), not a promise.
   */
  pendingKnowledge() {
    const ledger = this.promotedLedger();
    const mined = Object.keys(ledger.refs).length;
    let total = this.stagingRecords().length + this.archivedCount();
    for (const row of this.listContexts()) total += Number(row.turn_count ?? 0);
    total += this.decisionStats().total;
    return Math.max(0, total - mined);
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
   *   skipped: number, remaining: number}}
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

    for (const row of this.stagingRecords()) {
      scanned.staging += 1;
      refs.push(`staging:${String(row.dedup_id ?? '')}`);
      for (const candidate of candidatesFromRecord(row, 'staging')) candidates.push(candidate);
    }
    for (const category of CATEGORIES) {
      for (const row of this.archiveEntries(category, 500)) {
        scanned.archive += 1;
        refs.push(`archive:${String(row.dedup_id ?? '')}`);
        for (const candidate of candidatesFromRecord(row, 'archive')) candidates.push(candidate);
      }
    }
    for (const meta of this.listContexts()) {
      const record = this.loadContext(meta.context_id);
      if (!record) continue;
      for (const turn of Array.isArray(record.turns) ? record.turns : []) {
        scanned.contexts += 1;
        refs.push(`context:${record.context_id}#turn${turn?.turn ?? '?'}`);
        for (const candidate of candidatesFromTurn(turn, record.context_id)) candidates.push(candidate);
      }
    }
    for (const row of this.decisionRecords(500)) {
      scanned.decisions += 1;
      refs.push(`decision:${String(row.decision_id ?? '')}`);
      for (const candidate of candidatesFromDecision(row)) candidates.push(candidate);
    }

    const fresh = candidates.filter((candidate) => !already.has(candidate.source_ref));
    const work = withTokens(this.documents());
    const added = [];
    const merged = [];
    const processedRefs = new Set();
    let skipped = 0;

    for (const candidate of fresh) {
      if (added.length + merged.length >= limit) break;
      processedRefs.add(candidate.source_ref);
      const duplicate = findDuplicate(candidate.text, work);
      const record = {
        doc_id: duplicate ? duplicate.doc_id : knowledgeKey(candidate.text),
        text: candidate.text,
        category: candidate.category,
        source: candidate.source,
        tags: candidate.tags,
        url: candidate.url,
        confidence: candidate.confidence,
        evidence: [{ kind: candidate.source_ref.split(':')[0], ref: candidate.source_ref, at: new Date().toISOString() }],
      };
      if (duplicate) {
        merged.push({ doc_id: duplicate.doc_id, text: candidate.text, source_ref: candidate.source_ref });
      } else {
        added.push({ doc_id: record.doc_id, text: candidate.text, category: candidate.category, source: candidate.source });
        work.push(withTokens([record])[0]);
      }
      if (!dryRun) {
        // Mining merges near-identical statements from the process log; it never
        // overrides a fact the user confirmed, so it skips the confirmation gate.
        this.remember(record, { confirm: true });
        this.markPromoted([{ ref: candidate.source_ref, doc_id: record.doc_id }]);
      }
    }

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
      skipped,
      remaining: Math.max(0, fresh.length - processedRefs.size),
    };
  }

  // ---- decisions ---------------------------------------------------------

  /** Persist one decision review record. */
  recordDecision(result) {
    this.init();
    const file = path.join(this.decisionDir, `${safeStem(result.decision_id, 'decision')}.json`);
    writeJson(file, result);
    return { file: this.relative(file) };
  }

  /** `{outcome: count}` and total decisions. */
  decisionStats() {
    const byOutcome = {};
    let total = 0;
    for (const file of listJsonFiles(this.decisionDir)) {
      const data = readJson(file);
      if (!data || typeof data.outcome !== 'string') continue;
      total += 1;
      byOutcome[data.outcome] = (byOutcome[data.outcome] ?? 0) + 1;
    }
    return { total, byOutcome };
  }

  /** Recent decision records, newest first. */
  decisionRecords(limit = 100) {
    const rows = [];
    for (const file of listJsonFiles(this.decisionDir)) {
      const data = readJson(file);
      if (!data || typeof data.decision_id !== 'string') continue;
      rows.push({
        decision_id: data.decision_id,
        decision: data.decision,
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
    writeJson(path.join(this.contextDir, `${contextId}.json`), record);
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
    const rows = [];
    for (const file of listJsonFiles(this.contextDir)) {
      const data = readJson(file);
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
      });
    }
    rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return rows;
  }

  /** Load one archived context by exact id or id prefix. */
  loadContext(idOrPrefix) {
    const value = String(idOrPrefix ?? '').trim();
    if (value === '') return null;
    const exact = readJson(path.join(this.contextDir, `${value}.json`));
    if (exact) return exact;
    let match = null;
    for (const file of listJsonFiles(this.contextDir)) {
      const data = readJson(file);
      if (data && typeof data.context_id === 'string' && data.context_id.startsWith(value)) {
        if (!match || String(data.created_at) > String(match.created_at)) match = data;
      }
    }
    return match;
  }

  /** Record the last compaction attempt so the panel and status can show it. */
  writeCompactionStatus(input) {
    this.init();
    writeJson(this.compactionStatusFile, { at: nowIso(), ...input });
  }

  /** Last compaction attempt, or null when none has run. */
  readCompactionStatus() {
    return readJson(this.compactionStatusFile);
  }

  // ---- overview ----------------------------------------------------------

  /** Model-facing summary of every layer. */
  status() {
    const stagingFiles = listJsonlFiles(this.stagingDir);
    const stagingCount = stagingFiles.reduce((sum, file) => sum + readJsonl(file).length, 0);
    const snapshots = this.listSnapshots();
    const knowledge = this.knowledgeStats();
    const decisions = this.decisionStats();
    const recent = this.stagingRecords().slice(-5).map((row) => ({
      kind: row.kind,
      content: clip(row.content, 120),
      timestamp: row.timestamp,
    }));

    return {
      root: this.root,
      staging: { files: stagingFiles.length, entries: stagingCount },
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
      },
      decisions,
      contexts: this.listContexts().length,
      recent,
    };
  }
}
