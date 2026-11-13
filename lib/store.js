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

  /** Upsert one knowledge document. */
  remember(input) {
    const docId = String(input?.doc_id ?? '').trim();
    const text = String(input?.text ?? '');
    const category = String(input?.category ?? '').trim();
    if (docId === '') throw new Error('doc_id 必须为非空字符串');
    if (text.trim() === '') throw new Error('text 必须为非空字符串');
    if (category === '') throw new Error('category 必须为非空字符串');
    if (text.length > this.maxContentChars) {
      throw new Error(`text 过长（${text.length} 字符，上限 ${this.maxContentChars}）`);
    }

    this.init();
    const file = path.join(this.knowledgeDir, `${safeStem(docId, 'doc')}.json`);
    const data = {
      doc_id: docId,
      text,
      category,
      updated_at: nowIso(),
    };
    if (input?.metadata && typeof input.metadata === 'object') data.metadata = input.metadata;
    writeJson(file, data);
    return { ...data, file: this.relative(file) };
  }

  /** Every knowledge document. */
  documents() {
    const docs = [];
    for (const file of listJsonFiles(this.knowledgeDir)) {
      const data = readJson(file);
      if (!data || typeof data.doc_id !== 'string' || typeof data.text !== 'string') continue;
      docs.push({
        doc_id: data.doc_id,
        text: data.text,
        category: typeof data.category === 'string' ? data.category : 'unknown',
      });
    }
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
    const documents = this.documents();
    const docCategories = {};
    for (const doc of documents) docCategories[doc.category] = (docCategories[doc.category] ?? 0) + 1;
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
      knowledge: { documents: documents.length, categories: docCategories },
      decisions,
      contexts: this.listContexts().length,
      recent,
    };
  }
}
