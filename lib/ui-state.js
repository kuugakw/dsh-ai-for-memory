/**
 * Build the JSON snapshot the Web panel renders.
 *
 * Everything is read from the filesystem on demand; limits keep the response
 * small enough to be useful in a panel and safe against a huge memory store.
 */

import { clip } from './util.js';

const DEFAULT_LIMIT = 100;

/**
 * @param {import('./store.js').MemoryStore} store
 * @param {{limit?: number}} [options]
 */
export function buildUiState(store, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : DEFAULT_LIMIT;

  const stagingAll = store.stagingRecords();
  const staging = stagingAll.slice(-limit).reverse().map((row) => ({
    dedup_id: row.dedup_id,
    kind: row.kind,
    content: clip(row.content, 2000),
    source: row.source,
    risk: row.risk,
    verify: row.verify,
    timestamp: row.timestamp,
    entry_index: row.entry_index,
  }));

  const archive = Object.entries(store.archiveStats()).map(([category, count]) => ({
    category,
    count,
    entries: store.archiveEntries(category, 20),
  }));

  const snapshotRows = store.listSnapshots();
  const snapshots = snapshotRows.slice(-30).reverse().map((row) => {
    const data = store.loadSnapshot(row.snapshot_id);
    return {
      snapshot_id: row.snapshot_id,
      name: row.name,
      timestamp: row.timestamp,
      state_size: row.state_size,
      state_text: clip(JSON.stringify(data?.state ?? {}, null, 2), 4000),
    };
  });

  const knowledgeDocs = store.documents();
  const knowledge = knowledgeDocs.slice(0, 200).map((doc) => ({
    doc_id: doc.doc_id,
    category: doc.category,
    text: clip(doc.text, 2000),
  }));

  const decisionStats = store.decisionStats();
  const decisions = store.decisionRecords(limit);

  return {
    generatedAt: new Date().toISOString(),
    root: store.root,
    counts: {
      staging: stagingAll.length,
      archive: store.archivedCount(),
      snapshots: snapshotRows.length,
      knowledge: knowledgeDocs.length,
      decisions: decisionStats.total,
    },
    decisionsByOutcome: decisionStats.byOutcome,
    staging,
    archive,
    snapshots,
    knowledge,
    decisions,
  };
}
