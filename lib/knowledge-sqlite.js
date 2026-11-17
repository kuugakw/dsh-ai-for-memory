/**
 * SQLite storage for the knowledge base.
 *
 * The default backend keeps one JSON file per document (`knowledge/<id>.json`),
 * which is easy to inspect and diff. This module adds an optional SQLite backend
 * (`knowledge/knowledge.sqlite`) for the cases where a single queryable file is
 * more useful: external tools can open it, and thousands of documents stay fast.
 *
 * It uses Node's built-in `node:sqlite` (Node 22.5+), so the plugin keeps its
 * no-dependency promise. When the module is missing, `sqliteAvailable()` is
 * false and the store falls back to JSON instead of failing.
 *
 * The JSON files stay in place as a mirror: switching back to JSON never loses
 * facts written while SQLite was active, and a first switch imports everything
 * that already existed.
 */

import fs from 'node:fs';
import path from 'node:path';

import { normalizeCategory } from './knowledge.js';

/** File name inside the knowledge directory. */
export const KNOWLEDGE_DB_FILE = 'knowledge.sqlite';

/** True when this Node build ships `node:sqlite`. */
export function sqliteAvailable() {
  try {
    if (typeof process.getBuiltinModule !== 'function') return false;
    const sqlite = process.getBuiltinModule('node:sqlite');
    return Boolean(sqlite && typeof sqlite.DatabaseSync === 'function');
  } catch {
    return false;
  }
}

/** Absolute path of the database used by one memory store. */
export function knowledgeDatabasePath(root) {
  return path.join(root, 'knowledge', KNOWLEDGE_DB_FILE);
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToDoc(row) {
  return {
    doc_id: row.doc_id,
    text: row.text,
    category: normalizeCategory(row.category),
    source: typeof row.source === 'string' && row.source !== '' ? row.source : 'unknown',
    tags: parseJsonArray(row.tags).filter((tag) => typeof tag === 'string'),
    url: typeof row.url === 'string' ? row.url : '',
    confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0.8,
    evidence: parseJsonArray(row.evidence),
    created_at: typeof row.created_at === 'string' ? row.created_at : '',
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : '',
    revision: Number.isInteger(Number(row.revision)) ? Number(row.revision) : 1,
  };
}

/**
 * Open (and initialize) the SQLite knowledge database.
 *
 * @param {string} root memory store root
 * @returns {{ path: string, documents: () => object[], getById: (id: string) => object|null,
 *   upsert: (doc: object) => void, remove: (id: string) => boolean, close: () => void }}
 */
export function openKnowledgeDatabase(root) {
  if (!sqliteAvailable()) {
    throw new Error('当前 Node 不支持 node:sqlite（需要 Node 22.5+）');
  }
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const file = knowledgeDatabasePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // WAL keeps readers (panel, external tools) from blocking a write.
  try {
    db.exec('PRAGMA journal_mode = WAL');
  } catch {
    // A read-only filesystem still allows an in-memory-ish fallback; the DDL
    // below will surface a real error if the file is truly unusable.
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_docs (
      doc_id     TEXT PRIMARY KEY,
      text       TEXT NOT NULL,
      category   TEXT NOT NULL DEFAULT 'project_facts',
      source     TEXT NOT NULL DEFAULT 'unknown',
      url        TEXT NOT NULL DEFAULT '',
      tags       TEXT NOT NULL DEFAULT '[]',
      confidence REAL NOT NULL DEFAULT 0.8,
      evidence   TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      revision   INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS knowledge_docs_updated ON knowledge_docs(updated_at);
  `);

  const insert = db.prepare(`
    INSERT INTO knowledge_docs
      (doc_id, text, category, source, url, tags, confidence, evidence, created_at, updated_at, revision)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(doc_id) DO UPDATE SET
      text = excluded.text,
      category = excluded.category,
      source = excluded.source,
      url = excluded.url,
      tags = excluded.tags,
      confidence = excluded.confidence,
      evidence = excluded.evidence,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      revision = excluded.revision
  `);
  const selectAll = db.prepare('SELECT * FROM knowledge_docs ORDER BY updated_at DESC');
  const selectOne = db.prepare('SELECT * FROM knowledge_docs WHERE doc_id = ?');
  const deleteOne = db.prepare('DELETE FROM knowledge_docs WHERE doc_id = ?');
  const count = db.prepare('SELECT COUNT(*) AS n FROM knowledge_docs');

  return {
    path: file,
    documents() {
      return selectAll.all().map(rowToDoc);
    },
    getById(docId) {
      const row = selectOne.get(String(docId));
      return row ? rowToDoc(row) : null;
    },
    upsert(doc) {
      insert.run(
        doc.doc_id,
        doc.text,
        doc.category,
        doc.source,
        doc.url,
        JSON.stringify(Array.isArray(doc.tags) ? doc.tags : []),
        Number.isFinite(doc.confidence) ? doc.confidence : 0.8,
        JSON.stringify(Array.isArray(doc.evidence) ? doc.evidence : []),
        doc.created_at ?? '',
        doc.updated_at ?? '',
        Number.isInteger(doc.revision) ? doc.revision : 1,
      );
    },
    remove(docId) {
      const result = deleteOne.run(String(docId));
      return Number(result.changes) > 0;
    },
    close() {
      db.close();
    },
    count() {
      return Number(count.get().n);
    },
  };
}
