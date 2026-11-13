/**
 * Conversation-scoped memory: one independent store per conversation, plus the
 * shared (legacy) store at the memory root.
 *
 * Layout:
 *
 *   <root>/                      shared store — every conversation may read it
 *     staging/ archive/ snapshots/ knowledge/ decisions/ contexts/
 *     sessions/
 *       s_<hash16>/
 *         session.json           conversation metadata
 *         staging/ archive/ snapshots/ knowledge/ decisions/ contexts/
 *         compaction_status.json
 *
 * A conversation is addressed by its Session id; the directory name is a stable
 * hash of that id so any Session id (UUID, opaque string) becomes a safe path
 * segment without leaking it into the filesystem. `session.json` keeps the real
 * id, the workspace and the parent Session so the panel can label the row and a
 * later conversation can discover the others.
 */

import fs from 'node:fs';
import path from 'node:path';

import { MemoryStore } from './store.js';
import { ensureDir, hash40, nowIso, readJson, writeJson } from './util.js';

/** Directory under the memory root that holds one store per conversation. */
export const SESSIONS_DIR = 'sessions';

/** Metadata file inside one conversation directory. */
export const SESSION_META_FILE = 'session.json';

/** `sessionKey` output shape; the UI and the resolver rely on it. */
const SESSION_KEY_RE = /^s_[0-9a-f]{16}$/;

/**
 * Stable, filesystem-safe directory name for one Session id.
 *
 * Returns `null` for an empty id so callers can fall back to the shared store
 * instead of creating a nameless conversation.
 */
export function sessionKey(sessionId) {
  const id = String(sessionId ?? '').trim();
  if (id === '') return null;
  return `s_${hash40(id).slice(0, 16)}`;
}

/** True when the value looks like a conversation key. */
export function isSessionKey(value) {
  return typeof value === 'string' && SESSION_KEY_RE.test(value);
}

/** Short human-readable handle used in tool output and fallbacks. */
export function shortSessionId(sessionId) {
  const id = String(sessionId ?? '').trim();
  if (id === '') return '未知对话';
  return id.length <= 10 ? id : `${id.slice(0, 8)}…`;
}

/**
 * Manage every conversation store under one memory root.
 *
 * The class is stateless apart from a `MemoryStore` cache: all state lives in
 * `session.json` files, so two processes agree and a crash never loses the
 * mapping from a Session id to its directory.
 */
export class MemoryScopes {
  /**
   * @param {string} root - absolute memory root.
   * @param {{maxContentChars?: number, maxSnapshotBytes?: number, defaultTopK?: number}} [options]
   */
  constructor(root, options = {}) {
    this.root = path.resolve(root);
    this.sessionsDir = path.join(this.root, SESSIONS_DIR);
    this.options = {
      maxContentChars: options.maxContentChars,
      maxSnapshotBytes: options.maxSnapshotBytes,
      defaultTopK: options.defaultTopK,
    };
    this.stores = new Map();
  }

  /** Store for the shared (root-level, pre-isolation) layer. */
  sharedStore() {
    return this.storeAt(this.root, 'shared');
  }

  /** Absolute directory of one conversation. */
  sessionDir(key) {
    if (!isSessionKey(key)) throw new Error(`对话目录名不合法：${String(key)}`);
    return path.join(this.sessionsDir, key);
  }

  /** Store for one conversation key (no metadata side effect). */
  sessionStore(key) {
    return this.storeAt(this.sessionDir(key), key);
  }

  /** Cached `MemoryStore` factory; stores are cheap wrappers around the root. */
  storeAt(dir, cacheKey) {
    let store = this.stores.get(cacheKey);
    if (!store) {
      store = new MemoryStore(dir, this.options);
      this.stores.set(cacheKey, store);
    }
    return store;
  }

  /**
   * Resolve (and record) the store for one Session id.
   *
   * @param {string} sessionId
   * @param {object} [meta] - fields to persist into session.json.
   * @returns {{store: MemoryStore, key: string, meta: object}}
   */
  sessionStoreFor(sessionId, meta = {}) {
    const key = sessionKey(sessionId);
    if (key === null) throw new Error('对话 id 不能为空');
    const merged = this.touch(key, { ...meta, session_id: String(sessionId) });
    return { store: this.sessionStore(key), key, meta: merged };
  }

  /**
   * Record a conversation without writing memory data.
   *
   * @param {string} sessionId
   * @param {object} [meta]
   */
  ensureSession(sessionId, meta = {}) {
    const key = sessionKey(sessionId);
    if (key === null) return null;
    this.touch(key, { ...meta, session_id: String(sessionId) });
    return key;
  }

  /** Read one conversation's metadata, or null. */
  readMeta(key) {
    if (!isSessionKey(key)) return null;
    const data = readJson(path.join(this.sessionDir(key), SESSION_META_FILE));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data;
  }

  /** Merge fields into session.json; creation keeps `created_at`. */
  touch(key, patch) {
    const dir = this.sessionDir(key);
    ensureDir(dir);
    const file = path.join(dir, SESSION_META_FILE);
    const previous = readJson(file);
    const base = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {};
    const now = nowIso();
    const merged = {
      format: 1,
      ...base,
      ...patch,
      key,
      created_at: typeof base.created_at === 'string' ? base.created_at : now,
      updated_at: now,
    };
    // Never persist `undefined` fields; they would disappear in JSON anyway.
    for (const name of Object.keys(merged)) {
      if (merged[name] === undefined || merged[name] === null) delete merged[name];
    }
    writeJson(file, merged);
    return merged;
  }

  /**
   * Record the DSH-generated conversation title.
   *
   * Titles change rarely and this runs after every turn, so an unchanged title
   * must not rewrite the metadata file. A user-set `label` always wins on read.
   */
  setTitle(key, title) {
    const value = String(title ?? '').trim();
    if (value === '') return this.readMeta(key);
    const current = this.readMeta(key) ?? {};
    if (current.auto_title === value) return current;
    return this.touch(key, { auto_title: value });
  }

  /** Turn cross-conversation access on or off for one conversation. */
  setPublic(key, isPublic) {
    return this.touch(key, { public: isPublic === true });
  }

  /** Every stored conversation, newest activity first. */
  listSessions() {
    if (!fs.existsSync(this.sessionsDir)) return [];
    const rows = [];
    for (const name of fs.readdirSync(this.sessionsDir)) {
      if (!isSessionKey(name)) continue;
      const meta = this.readMeta(name) ?? { key: name, session_id: '' };
      rows.push({
        key: name,
        sessionId: typeof meta.session_id === 'string' ? meta.session_id : '',
        parentSessionId: typeof meta.parent_session_id === 'string' ? meta.parent_session_id : '',
        workspace: typeof meta.workspace === 'string' ? meta.workspace : '',
        agentPreset: typeof meta.agent_preset === 'string' ? meta.agent_preset : '',
        label: typeof meta.label === 'string' ? meta.label : '',
        title: typeof meta.auto_title === 'string' ? meta.auto_title : '',
        // Display name: an explicit label wins over the automatic DSH title.
        name: typeof meta.label === 'string' && meta.label !== ''
          ? meta.label
          : (typeof meta.auto_title === 'string' ? meta.auto_title : ''),
        public: meta.public !== false,
        createdAt: typeof meta.created_at === 'string' ? meta.created_at : '',
        updatedAt: typeof meta.updated_at === 'string' ? meta.updated_at : '',
      });
    }
    rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return rows;
  }

  /**
   * Resolve a conversation from a key, a Session id, or a unique id/key prefix.
   *
   * @param {string} candidate
   * @returns {{key: string, sessionId: string, meta: object}|null}
   */
  resolve(candidate) {
    const value = String(candidate ?? '').trim();
    if (value === '') return null;
    const rows = this.listSessions();
    const exact = rows.find((row) => row.key === value || (row.sessionId !== '' && row.sessionId === value));
    if (exact) return { key: exact.key, sessionId: exact.sessionId, meta: this.readMeta(exact.key) ?? exact };
    if (value.length < 4) return null;
    const byPrefix = rows.filter((row) => row.key.startsWith(value)
      || (row.sessionId !== '' && row.sessionId.startsWith(value)));
    if (byPrefix.length !== 1) return null;
    const row = byPrefix[0];
    return { key: row.key, sessionId: row.sessionId, meta: this.readMeta(row.key) ?? row };
  }

  /** Layer counts for one conversation (zeroes when it has no data). */
  counts(key) {
    const store = this.sessionStore(key);
    return {
      staging: store.stagingRecords().length,
      archive: store.archivedCount(),
      snapshots: store.listSnapshots().length,
      knowledge: store.documents().length,
      decisions: store.decisionStats().total,
      contexts: store.listContexts().length,
    };
  }

  /** Layer counts for the shared store. */
  sharedCounts() {
    const store = this.sharedStore();
    return {
      staging: store.stagingRecords().length,
      archive: store.archivedCount(),
      snapshots: store.listSnapshots().length,
      knowledge: store.documents().length,
      decisions: store.decisionStats().total,
      contexts: store.listContexts().length,
    };
  }

  /** True when the shared layer holds at least one record of any kind. */
  sharedHasData() {
    return Object.values(this.sharedCounts()).some((count) => count > 0);
  }
}
