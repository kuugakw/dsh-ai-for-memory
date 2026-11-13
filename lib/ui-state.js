/**
 * Build the JSON snapshot the Web panel renders.
 *
 * The panel can show one conversation, the shared layer, or every conversation
 * merged. This builder always receives an explicit list of sources, so merging
 * stays deterministic and each row keeps the conversation it came from.
 *
 * Everything is read from the filesystem on demand; limits keep the response
 * small enough to be useful in a panel and safe against a huge memory store.
 */

import { MemoryStore } from './store.js';
import { clip } from './util.js';

const DEFAULT_LIMIT = 100;

/**
 * Normalize the accepted argument shapes.
 *
 * A bare `MemoryStore` keeps working (it becomes the shared source), which is
 * what the store-level tests and older callers use.
 *
 * @param {MemoryStore|Array<object>} input
 */
function normalizeSources(input) {
  if (input instanceof MemoryStore || (input && typeof input.stagingDir === 'string')) {
    return [{ store: input, scope: 'shared', key: '', sessionId: '', label: '共享' }];
  }
  if (!Array.isArray(input)) return [];
  return input.filter((source) => source && source.store);
}

/** Attach the origin conversation to one row. */
function withSource(row, source) {
  return {
    ...row,
    session_key: source.key ?? '',
    session_id: source.sessionId ?? '',
    session_label: source.label ?? '',
    session_scope: source.scope ?? 'session',
  };
}

/**
 * @param {MemoryStore|Array<{store: MemoryStore, scope?: string, key?: string,
 *   sessionId?: string, label?: string}>} input
 * @param {{limit?: number}} [options]
 */
export function buildUiState(input, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : DEFAULT_LIMIT;
  const sources = normalizeSources(input);

  const stagingRows = [];
  const archiveGroups = new Map();
  const snapshotRows = [];
  const knowledgeRows = [];
  const decisionRows = [];
  const contextRows = [];
  const counts = {
    staging: 0, archive: 0, snapshots: 0, knowledge: 0, decisions: 0, contexts: 0,
  };
  const decisionsByOutcome = {};

  for (const source of sources) {
    const store = source.store;

    const staged = store.stagingRecords();
    counts.staging += staged.length;
    for (const row of staged) stagingRows.push(withSource(row, source));

    const archived = store.archiveStats();
    for (const [category, count] of Object.entries(archived)) {
      counts.archive += count;
      let group = archiveGroups.get(category);
      if (!group) {
        group = { category, count: 0, entries: [] };
        archiveGroups.set(category, group);
      }
      group.count += count;
      for (const entry of store.archiveEntries(category, 20)) {
        group.entries.push(withSource({ ...entry, category }, source));
      }
    }

    const snapshots = store.listSnapshots();
    counts.snapshots += snapshots.length;
    for (const row of snapshots) {
      snapshotRows.push(withSource(row, source));
    }

    const docs = store.documents();
    counts.knowledge += docs.length;
    for (const doc of docs) knowledgeRows.push(withSource(doc, source));

    const stats = store.decisionStats();
    counts.decisions += stats.total;
    for (const [outcome, value] of Object.entries(stats.byOutcome)) {
      decisionsByOutcome[outcome] = (decisionsByOutcome[outcome] ?? 0) + value;
    }
    for (const row of store.decisionRecords(limit)) decisionRows.push(withSource(row, source));

    const contexts = store.listContexts();
    counts.contexts += contexts.length;
    for (const row of contexts) contextRows.push(withSource(row, source));
  }

  const byTimestampDesc = (left, right) => String(right.timestamp).localeCompare(String(left.timestamp));
  const byCreatedDesc = (left, right) => String(right.created_at).localeCompare(String(left.created_at));
  const byIdDesc = (left, right) => String(right.snapshot_id).localeCompare(String(left.snapshot_id));

  const staging = stagingRows
    .sort((left, right) => String(right.timestamp).localeCompare(String(left.timestamp)))
    .slice(0, limit)
    .map((row) => ({
      dedup_id: row.dedup_id,
      kind: row.kind,
      content: clip(row.content, 2000),
      source: row.source,
      risk: row.risk,
      verify: row.verify,
      timestamp: row.timestamp,
      entry_index: row.entry_index,
      session_key: row.session_key,
      session_id: row.session_id,
      session_label: row.session_label,
      session_scope: row.session_scope,
    }));

  const archive = [...archiveGroups.values()]
    .map((group) => ({
      category: group.category,
      count: group.count,
      entries: group.entries
        .sort(byTimestampDesc)
        .slice(0, 40)
        .map((row) => ({
          dedup_id: row.dedup_id,
          content: clip(row.content, 2000),
          kind: row.kind,
          risk: row.risk,
          verify: row.verify,
          source: row.source,
          timestamp: row.timestamp,
          category: row.category,
          session_key: row.session_key,
          session_id: row.session_id,
          session_label: row.session_label,
          session_scope: row.session_scope,
        })),
    }))
    .sort((left, right) => String(left.category).localeCompare(String(right.category)));

  const snapshots = snapshotRows
    .sort((left, right) => String(right.timestamp).localeCompare(String(left.timestamp)) || byIdDesc(left, right))
    .slice(0, 30)
    .map((row) => {
      const source = sources.find((candidate) => candidate.key === row.session_key
        && (candidate.sessionId ?? '') === (row.session_id ?? ''));
      const data = source ? source.store.loadSnapshot(row.snapshot_id) : null;
      return {
        snapshot_id: row.snapshot_id,
        name: row.name,
        timestamp: row.timestamp,
        state_size: row.state_size,
        state_text: clip(JSON.stringify(data?.state ?? {}, null, 2), 4000),
        session_key: row.session_key,
        session_id: row.session_id,
        session_label: row.session_label,
        session_scope: row.session_scope,
      };
    });

  const knowledge = knowledgeRows
    .sort((left, right) => String(right.timestamp).localeCompare(String(left.timestamp)))
    .slice(0, 200)
    .map((doc) => ({
      doc_id: doc.doc_id,
      category: doc.category,
      text: clip(doc.text, 2000),
      session_key: doc.session_key,
      session_id: doc.session_id,
      session_label: doc.session_label,
      session_scope: doc.session_scope,
    }));

  const decisions = decisionRows
    .sort(byTimestampDesc)
    .slice(0, limit)
    .map((row) => ({
      decision_id: row.decision_id,
      decision: row.decision,
      risk_level: row.risk_level,
      outcome: row.outcome,
      approved: row.approved === true,
      reviewed: row.reviewed === true,
      thesis: row.thesis,
      antithesis: row.antithesis,
      reason: row.reason,
      timestamp: row.timestamp,
      session_key: row.session_key,
      session_id: row.session_id,
      session_label: row.session_label,
      session_scope: row.session_scope,
    }));

  const contexts = contextRows
    .sort(byCreatedDesc)
    .map((row) => ({
      context_id: row.context_id,
      label: row.label,
      created_at: row.created_at,
      turn_from: row.turn_from,
      turn_to: row.turn_to,
      turn_count: row.turn_count,
      chars: row.chars,
      session_key: row.session_key,
      session_id: row.session_id,
      session_label: row.session_label,
      session_scope: row.session_scope,
    }));

  return {
    generatedAt: new Date().toISOString(),
    scope: sources.length === 1 ? (sources[0].scope ?? 'session') : 'all',
    counts,
    decisionsByOutcome,
    staging,
    archive,
    snapshots,
    knowledge,
    decisions,
    contexts,
  };
}
