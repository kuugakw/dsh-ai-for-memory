/**
 * Knowledge-base export.
 *
 * This exists for the "the machine must not forget" case: a knowledge base can
 * be fully necessary, already compressed as far as it goes, and still larger
 * than the disk has room for. Forgetting damages precision, so the answer is to
 * export the whole thing (every field, including evidence) to a portable file
 * and move it elsewhere — nothing is dropped from the export.
 *
 * Two formats:
 * - `json` is lossless: the exact documents plus metadata, suitable for backup,
 *   diffing, and a future `import`;
 * - `markdown` is for humans: one section per category, every fact with its
 *   source/url/tags/evidence, so the file can be read without any tool.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CATEGORIES } from './util.js';
import { readRagIndex } from './rag.js';

export const EXPORT_VERSION = 1;
export const EXPORT_FORMATS = Object.freeze(['json', 'markdown']);

/** Normalize a user-supplied format name. */
export function normalizeExportFormat(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'md' || text === 'markdown') return 'markdown';
  if (text === '' || text === 'json') return 'json';
  return '';
}

/** Full, lossless export of one store's knowledge layer. */
export function buildKnowledgeExport(store, options = {}) {
  const docs = store.documents().map((doc) => ({
    doc_id: doc.doc_id,
    text: doc.text,
    category: doc.category,
    source: doc.source,
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    url: typeof doc.url === 'string' ? doc.url : '',
    confidence: typeof doc.confidence === 'number' ? doc.confidence : 0.8,
    evidence: Array.isArray(doc.evidence) ? doc.evidence : [],
    created_at: typeof doc.created_at === 'string' ? doc.created_at : '',
    updated_at: typeof doc.updated_at === 'string' ? doc.updated_at : '',
    revision: Number.isInteger(doc.revision) ? doc.revision : 1,
  }));
  return {
    kind: 'ai-for-memory-knowledge',
    version: EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    scope: options.scope === 'shared' ? 'shared' : 'session',
    label: String(options.label ?? ''),
    session_id: String(options.sessionId ?? ''),
    counts: { total: docs.length },
    docs,
  };
}

/** JSON export: compact, lossless, import-friendly. */
export function formatExportJson(bundle) {
  return `${JSON.stringify(bundle)}\n`;
}

function yamlValue(value) {
  const text = String(value ?? '');
  return /[:"\n]/.test(text) ? JSON.stringify(text) : text;
}

/** Markdown export: readable, grouped by category, evidence included. */
export function formatExportMarkdown(bundle) {
  const lines = [];
  lines.push('# 知识库导出 / Knowledge base export');
  lines.push('');
  lines.push(`- 导出时间（exported_at）：${bundle.exported_at}`);
  lines.push(`- 范围（scope）：${bundle.scope}${bundle.label ? `（${bundle.label}）` : ''}`);
  if (bundle.session_id !== '') lines.push(`- 对话（session_id）：${bundle.session_id}`);
  lines.push(`- 知识总数（total）：${bundle.counts?.total ?? 0}`);
  lines.push(`- 格式版本（version）：${bundle.version}`);
  lines.push('');
  const byCategory = new Map(CATEGORIES.map((category) => [category, []]));
  for (const doc of bundle.docs) {
    if (!byCategory.has(doc.category)) byCategory.set(doc.category, []);
    byCategory.get(doc.category).push(doc);
  }
  for (const [category, docs] of byCategory) {
    if (docs.length === 0) continue;
    lines.push(`## ${category}（${docs.length}）`);
    lines.push('');
    for (const doc of docs) {
      lines.push(`### ${doc.doc_id}`);
      lines.push('');
      lines.push(doc.text);
      lines.push('');
      const meta = [`来源 ${yamlValue(doc.source)}`];
      if (doc.url !== '') meta.push(`出处 ${doc.url}`);
      if (doc.tags.length > 0) meta.push(`标签 ${doc.tags.join('、')}`);
      meta.push(`置信度 ${doc.confidence}`);
      if (doc.created_at !== '') meta.push(`创建 ${doc.created_at}`);
      if (doc.updated_at !== '') meta.push(`更新 ${doc.updated_at}`);
      lines.push(`- ${meta.join('｜')}`);
      if (doc.evidence.length > 0) {
        const refs = doc.evidence
          .map((item) => {
            if (item && typeof item === 'object') {
              const parts = [item.kind, item.ref, item.at].filter((part) => typeof part === 'string' && part !== '');
              return parts.join(':');
            }
            return String(item);
          })
          .filter((text) => text !== '');
        if (refs.length > 0) lines.push(`- 证据：${refs.join('；')}`);
      }
      lines.push('');
    }
  }
  if (bundle.docs.length === 0) {
    lines.push('（知识库为空 / empty knowledge base）');
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function stampOf(iso) {
  return String(iso).replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
}

function safeName(text) {
  const clean = String(text ?? '')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return clean !== '' ? clean : 'knowledge';
}

/** Suggested attachment name, e.g. `knowledge-本对话-2026-11-17_22-00-00.json`. */
export function defaultExportFileName(bundle, format) {
  const ext = format === 'markdown' ? 'md' : 'json';
  const label = safeName(bundle.label !== '' ? bundle.label : bundle.scope);
  return `knowledge-${label}-${stampOf(bundle.exported_at)}.${ext}`;
}

/** Content + filename for the panel download and the API route. */
export function knowledgeExportPayload(store, options = {}) {
  const format = normalizeExportFormat(options.format);
  if (format === '') {
    return { ok: false, error: 'format 只支持 json 或 markdown' };
  }
  const bundle = buildKnowledgeExport(store, options);
  const content = format === 'markdown' ? formatExportMarkdown(bundle) : formatExportJson(bundle);
  return {
    ok: true,
    filename: defaultExportFileName(bundle, format),
    mime: format === 'markdown' ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8',
    format,
    content,
    bytes: Buffer.byteLength(content, 'utf8'),
    docs: bundle.docs.length,
    bundle,
  };
}

/**
 * Write an export to disk.
 *
 * `dest` may be a full file path (`.json` / `.md`) or a directory; when it is
 * empty the export goes to `<store.root>/exports/`. A directory on another
 * disk is the normal case: the whole point is to move data off a full disk.
 */
export function writeKnowledgeExport(store, options = {}) {
  const payload = knowledgeExportPayload(store, options);
  if (payload.ok !== true) return payload;
  const rawDest = typeof options.dest === 'string' ? options.dest.trim() : '';
  const ext = payload.format === 'markdown' ? '.md' : '.json';
  let file;
  if (rawDest !== '' && /\.(json|md|markdown)$/i.test(rawDest)) {
    file = path.resolve(rawDest);
  } else {
    const dir = rawDest !== '' ? path.resolve(rawDest) : path.join(store.root, 'exports');
    file = path.join(dir, payload.filename);
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, payload.content);
  } catch (error) {
    return { ok: false, error: `写导出文件失败：${error?.message ?? error}` };
  }
  return {
    ok: true,
    path: file,
    bytes: payload.bytes,
    docs: payload.docs,
    format: payload.format,
    filename: path.basename(file),
  };
}

/** The three things that can be exported from the knowledge layer. */
export const EXPORT_TYPES = Object.freeze(['knowledge', 'sql', 'rag']);

/** Normalize one export type (`sqlite`/`db`/`index` aliases accepted). */
export function normalizeExportType(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'sql' || text === 'sqlite' || text === 'db') return 'sql';
  if (text === 'rag' || text === 'index' || text === 'vector') return 'rag';
  if (text === '' || text === 'knowledge' || text === 'json' || text === 'md' || text === 'markdown') {
    return 'knowledge';
  }
  return '';
}

/** Normalize a multi-selection of export types; `[]` means invalid input. */
export function normalizeExportTypeList(value) {
  const list = Array.isArray(value) ? value : [value ?? 'knowledge'];
  const out = [];
  for (const item of list) {
    const type = normalizeExportType(item);
    if (type === '') return [];
    if (!out.includes(type)) out.push(type);
  }
  return out;
}

/** Build a complete, queryable SQLite copy directly from the JSON base. */
export function knowledgeSqlitePayload(store) {
  const builtin = typeof process.getBuiltinModule === 'function'
    ? process.getBuiltinModule('node:sqlite') : null;
  if (!builtin || typeof builtin.DatabaseSync !== 'function') {
    return { ok: false, error: '当前 Node 不支持 node:sqlite（需要 Node 22.5+），无法导出 SQLite。' };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-export-sql-'));
  const file = path.join(dir, 'knowledge.sqlite');
  try {
    const db = new builtin.DatabaseSync(file);
    db.exec(`CREATE TABLE knowledge_docs (
      doc_id TEXT PRIMARY KEY, text TEXT NOT NULL, category TEXT NOT NULL,
      source TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
      confidence REAL NOT NULL DEFAULT 0.8, evidence TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1
    );`);
    const insert = db.prepare(`INSERT INTO knowledge_docs
      (doc_id, text, category, source, url, tags, confidence, evidence, created_at, updated_at, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const docs = store.documents();
    db.exec('BEGIN');
    for (const doc of docs) {
      insert.run(
        doc.doc_id,
        doc.text,
        doc.category,
        doc.source,
        doc.url,
        JSON.stringify(doc.tags ?? []),
        doc.confidence ?? 0.8,
        JSON.stringify(doc.evidence ?? []),
        doc.created_at ?? '',
        doc.updated_at ?? '',
        doc.revision ?? 1,
      );
    }
    db.exec('COMMIT');
    db.exec('CREATE INDEX knowledge_docs_updated ON knowledge_docs(updated_at);');
    db.close();
    const buffer = fs.readFileSync(file);
    return { ok: true, type: 'sql', buffer, bytes: buffer.length, docs: docs.length };
  } catch (error) {
    return { ok: false, error: `生成 SQLite 导出失败：${error?.message ?? error}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The RAG vector index as one portable JSON file.
 *
 * On disk the index is sharded; export merges it into one self-contained JSON
 * shape so the vectors + text can be moved as a single file.
 */
export function ragIndexPayload(store) {
  const index = readRagIndex(store.root);
  if (!index) {
    return { ok: false, error: 'RAG 索引还没建立（先在面板点「建立/更新 RAG 索引」或 aim_memory action=index）。' };
  }
  const content = `${JSON.stringify(index)}\n`;
  return { ok: true, type: 'rag', buffer: Buffer.from(content, 'utf8'), bytes: Buffer.byteLength(content, 'utf8') };
}

/**
 * Build one artifact of any supported type.
 *
 * `knowledge` honours `format` (json/markdown); `sql` is a complete `.sqlite`
 * built from the JSON base; `rag` is the vector index file as-is. Binary types
 * return `buffer`, text types return `content`, so callers can pick the right
 * writer/transport.
 */
export function exportArtifact(store, options = {}) {
  const type = normalizeExportType(options.type);
  const label = options.label !== undefined && String(options.label) !== '' ? String(options.label) : 'knowledge';
  const stamp = stampOf(new Date().toISOString());
  if (type === '') return { ok: false, error: 'type 只支持 knowledge / sql / rag' };
  if (type === 'knowledge') {
    const payload = knowledgeExportPayload(store, options);
    if (payload.ok !== true) return payload;
    return {
      ok: true,
      type,
      filename: payload.filename,
      mime: payload.mime,
      content: payload.content,
      bytes: payload.bytes,
      docs: payload.docs,
    };
  }
  if (type === 'sql') {
    const payload = knowledgeSqlitePayload(store);
    if (!payload.ok) return payload;
    return {
      ...payload,
      filename: `knowledge-${safeName(label)}-${stamp}.sqlite`,
      mime: 'application/vnd.sqlite3',
      content: undefined,
    };
  }
  const payload = ragIndexPayload(store);
  if (!payload.ok) return payload;
  return {
    ...payload,
    filename: `knowledge-rag-index-${stamp}.json`,
    mime: 'application/json; charset=utf-8',
    content: undefined,
  };
}

/**
 * Write any selection of artifacts to disk.
 *
 * With exactly one type a `dest` that ends in a known extension is used as the
 * full file path; otherwise `dest` is treated as a directory (default
 * `<store.root>/exports`) and every selected type gets its own file there.
 */
export function writeExportArtifacts(store, options = {}) {
  const types = normalizeExportTypeList(options.types ?? options.type ?? 'knowledge');
  if (types.length === 0) return { ok: false, error: 'types 只支持 knowledge / sql / rag' };
  const rawDest = typeof options.dest === 'string' ? options.dest.trim() : '';
  const destIsFile = rawDest !== '' && types.length === 1 && /\.[a-z0-9]+$/i.test(rawDest);
  const dir = rawDest === ''
    ? path.join(store.root, 'exports')
    : destIsFile ? path.dirname(path.resolve(rawDest)) : path.resolve(rawDest);
  const files = [];
  for (const type of types) {
    const artifact = exportArtifact(store, { ...options, type });
    if (!artifact.ok) return { ok: false, error: artifact.error, files };
    const file = destIsFile ? path.resolve(rawDest) : path.join(dir, artifact.filename);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, artifact.buffer ?? artifact.content);
    } catch (error) {
      return { ok: false, error: `写导出文件失败：${error?.message ?? error}`, files };
    }
    files.push({
      type,
      path: file,
      filename: path.basename(file),
      bytes: artifact.bytes,
      docs: artifact.docs ?? 0,
    });
  }
  return {
    ok: true,
    files,
    bytes: files.reduce((sum, row) => sum + row.bytes, 0),
  };
}
