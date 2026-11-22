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
function withSource(row, source, extra = {}) {
  return {
    ...row,
    ...extra,
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
  const knowledgePendingRows = [];
  const knowledgeConflictRows = [];
  let knowledgeConflictOpen = 0;
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
    const usage = store.knowledgeUsage();
    const weights = store.knowledgeWeights();
    for (const doc of docs) {
      const hit = usage[doc.doc_id];
      knowledgeRows.push(withSource(doc, source, {
        hits: Number.isInteger(hit?.count) ? hit.count : 0,
        weight: weights[doc.doc_id] ?? 0,
        last_used_at: typeof hit?.at === 'string' ? hit.at : '',
      }));
    }
    for (const row of store.pendingPromotions()) knowledgePendingRows.push(withSource(row, source));
    const conflicts = store.conflictLog(50);
    // `open` is computed from the whole log; the panel list is intentionally
    // capped at 50 rows, so counting the returned items would stop at 50.
    knowledgeConflictOpen += conflicts.open;
    for (const row of conflicts.items) knowledgeConflictRows.push(withSource(row, source));

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
    .sort((left, right) => String(right.updated_at ?? right.created_at ?? '')
      .localeCompare(String(left.updated_at ?? left.created_at ?? '')))
    .slice(0, 200)
    .map((doc) => ({
      doc_id: doc.doc_id,
      category: doc.category,
      text: clip(doc.text, 2000),
      source: typeof doc.source === 'string' ? doc.source : 'unknown',
      tags: Array.isArray(doc.tags) ? doc.tags.slice(0, 8) : [],
      url: typeof doc.url === 'string' ? doc.url : '',
      confidence: typeof doc.confidence === 'number' ? doc.confidence : 0.8,
      provenance: typeof doc.provenance === 'string' ? doc.provenance : 'authored',
      verified: doc.verified === true,
      hits: doc.hits,
      weight: doc.weight,
      last_used_at: doc.last_used_at,
      evidence_count: Array.isArray(doc.evidence) ? doc.evidence.length : 0,
      revision: Number.isInteger(doc.revision) ? doc.revision : 1,
      changes_count: Array.isArray(doc.changes) ? doc.changes.length : 0,
      last_change_kind: Array.isArray(doc.changes) && doc.changes.length > 0
        ? String(doc.changes[doc.changes.length - 1]?.kind ?? '')
        : '',
      last_change_at: Array.isArray(doc.changes) && doc.changes.length > 0
        ? String(doc.changes[doc.changes.length - 1]?.at ?? '')
        : '',
      previous_text: Array.isArray(doc.changes) && doc.changes.length > 0
        ? clip(String(doc.changes[doc.changes.length - 1]?.previous_text ?? ''), 600)
        : '',
      created_at: doc.created_at ?? '',
      updated_at: doc.updated_at ?? '',
      session_key: doc.session_key,
      session_id: doc.session_id,
      session_label: doc.session_label,
      session_scope: doc.session_scope,
    }));
  // How much of the three layers has not been mined yet — the panel uses it to
  // tell the user whether "提炼" still has work to do.
  const knowledgePending = sources
    .reduce((sum, source) => sum + source.store.pendingKnowledge(), 0);

  const knowledgePendingUpdates = knowledgePendingRows
    .sort((left, right) => String(right.last_seen_at ?? '')
      .localeCompare(String(left.last_seen_at ?? '')))
    .slice(0, 50)
    .map((row) => ({
      pending_id: row.pending_id,
      update_of: row.update_of,
      text: clip(row.text, 2000),
      category: row.category,
      source: row.source,
      source_ref: row.source_ref,
      reason: row.reason,
      conflicts: Array.isArray(row.conflicts) ? row.conflicts.slice(0, 3) : [],
      first_seen_at: row.first_seen_at,
      last_seen_at: row.last_seen_at,
      seen_count: row.seen_count,
      origin_label: row.origin_label,
      origin_key: row.origin_key,
      origin_scope: row.origin_scope,
    }));

  // Conflict-gate audit trail. Not a queue: nothing here will be applied; the
  // panel shows it so a model that forgets to relay the question is still
  // visible to the user.
  const knowledgeConflicts = knowledgeConflictRows
    .sort((left, right) => String(right.at ?? '').localeCompare(String(left.at ?? '')))
    .slice(0, 50)
    .map((row) => ({
      conflict_id: row.conflict_id,
      at: row.at,
      kind: row.kind,
      doc_id: row.doc_id,
      text: clip(row.text, 2000),
      category: row.category,
      resolved: row.resolved === true,
      conflicts: Array.isArray(row.conflicts) ? row.conflicts.slice(0, 3).map((item) => ({
        doc_id: item?.doc_id ?? '',
        text: clip(item?.text ?? '', 600),
        category: item?.category ?? '',
        similarity: item?.similarity,
        update: item?.update === true,
        change: item?.change ?? null,
      })) : [],
      origin_label: row.origin_label,
      origin_key: row.origin_key,
      origin_scope: row.origin_scope,
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
      irreversible: typeof row.irreversible === 'boolean' ? row.irreversible : null,
      recoverable_via: row.recoverable_via,
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
      // The panel renders the archived text only when the row is expanded, so the
      // payload stays capped; the full text remains in contexts/<id>.json.
      text: typeof row.text === 'string' ? row.text.slice(0, 6000) : '',
      model_summary: typeof row.model_summary === 'string' ? row.model_summary.slice(0, 600) : '',
    }));

  return {
    generatedAt: new Date().toISOString(),
    scope: sources.length === 1 ? (sources[0].scope ?? 'session') : 'all',
    counts,
    knowledgePending,
    decisionsByOutcome,
    staging,
    archive,
    snapshots,
    knowledge,
    knowledgeTotal: knowledgeRows.length,
    knowledgeReturned: knowledge.length,
    knowledgeLimit: 200,
    knowledgeLimited: knowledgeRows.length > 200,
    knowledgePendingUpdates,
    knowledgeConflicts,
    knowledgeConflictOpen,
    decisions,
    contexts,
  };
}
