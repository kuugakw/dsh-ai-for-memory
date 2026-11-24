/**
 * Shared helpers for AI for Memory: ids, filenames, JSONL I/O and anchors.
 *
 * Everything here is plain Node (no `@deepseek-ai/*` imports) so the whole
 * store can be exercised in a normal `node --test` run without booting DSH.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Coarse classifications a staged record can carry. */
export const KINDS = [
  'action', 'screenshot', 'decision', 'reasoning', 'error', 'state', 'digest', 'unknown',
];

/** Risk levels understood by the decision review. */
export const RISKS = ['low', 'medium', 'high'];

/** Verification states for staged records. */
export const VERIFIES = ['pending', 'pass', 'fail', 'skip'];

/**
 * Format version written into persisted JSON records. Bump whenever the on-disk
 * shape changes in a way a reader must know about, so future migrations can
 * distinguish old data instead of guessing.
 */
export const SCHEMA_VERSION = 1;

/** The archive categories shipped with AI for Memory. */
export const CATEGORIES = [
  'ui_facts',
  'action_logs',
  'decisions_reasoning',
  'ui_maps',
  'errors_fixes',
  'behavior_tristate',
  'snapshots',
];

/**
 * Coarse kind -> archive category. This is deliberately a small, explicit
 * table instead of heuristics: the routing must be predictable.
 */
export const CATEGORY_MAP = Object.freeze({
  action: 'action_logs',
  screenshot: 'ui_facts',
  decision: 'decisions_reasoning',
  reasoning: 'decisions_reasoning',
  error: 'errors_fixes',
  state: 'behavior_tristate',
  digest: 'action_logs',
  unknown: 'action_logs',
});

/** Zero-pad to two digits. */
export function pad(n) {
  return String(n).padStart(2, '0');
}

/** UTC ISO timestamp (stable across machines). */
export function nowIso(date = new Date()) {
  return date.toISOString();
}

/** Local hour bucket used by the rolling staging files, e.g. `20261112T2100`. */
export function hourKey(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `T${pad(date.getHours())}00`;
}

/** 40-char SHA-256 prefix, matching the dedup id shape of MemoryLayer. */
export function hash40(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 40);
}

/** Short stable digest used when an id has to become a filename. */
export function hash8(text) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, 8);
}

/**
 * Make an identifier safe to use as a filename stem.
 *
 * A name that only contains `[A-Za-z0-9_-]` is kept as-is. Anything else is
 * replaced and suffixed with a digest of the original, so `a/b` and `a:b`
 * cannot collide on `a_b`. The result is stable across runs.
 */
export function safeStem(name, fallback = 'item') {
  const raw = String(name ?? '');
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
  if (safe && safe === raw) return safe;
  return safe ? `${safe}_${hash8(raw)}` : `${fallback}_${hash8(raw)}`;
}

/** Recursive mkdir. */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Resolve `$DSH_HOME` with the `~/.dsh` fallback.
 *
 * Apart from an unset variable, reject the literal strings "undefined" and
 * "null": `process.env.DSH_HOME = undefined` stores the string, and path
 * interpolation turns it into a relative `undefined/` directory inside the
 * working tree. DSH_HOME is always set inside a real DSH process, so this only
 * protects standalone runs and tests; the fallback must still be absolute.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string} absolute DSH home directory
 */
export function dshHome(env = process.env) {
  const raw = String(env?.DSH_HOME ?? '').trim();
  if (raw !== '' && raw !== 'undefined' && raw !== 'null') return path.resolve(raw);
  return path.join(os.homedir(), '.dsh');
}

/** Read a JSONL file, skipping blank and malformed lines (crash safety). */
export function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      const value = JSON.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value)) out.push(value);
    } catch {
      // A crash can leave a torn last line; it must not hide earlier records.
    }
  }
  return out;
}

/**
 * Count every non-empty physical line, including a torn last line.
 *
 * Entry indexes must never be reused: after a crash the torn line still owns
 * its index, so the next record gets a fresh dedup id instead of colliding
 * with the one that was being written.
 */
export function countPhysicalLines(file) {
  if (!fs.existsSync(file)) return 0;
  let count = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim()) count += 1;
  }
  return count;
}

/** Flush one file to disk. Best effort: some filesystems/platforms refuse. */
function fsyncFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r+');
    fs.fsyncSync(fd);
  } catch {
    // Durability is best effort (e.g. a filesystem without fsync support).
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Flush a directory entry so a rename survives a crash. Windows cannot fsync a
 * directory, but NTFS journals metadata; the file data was already flushed
 * before the rename, which is the part a power loss could otherwise lose.
 */
function fsyncDir(dir) {
  if (process.platform === 'win32') return;
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Not supported everywhere; best effort.
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Append one JSON line.
 *
 * `durable: false` skips the fsync for high-frequency bookkeeping (usage
 * counters, staging events) where losing the last line after a power cut is
 * acceptable; user data (knowledge, archives, snapshots, contexts) keeps it.
 */
export function appendJsonLine(file, value, options = {}) {
  const append = () => {
    ensureDir(path.dirname(file));
    let prefix = '';
    if (fs.existsSync(file)) {
      const { size } = fs.statSync(file);
      if (size > 0) {
        const fd = fs.openSync(file, 'r');
        try {
          const last = Buffer.alloc(1);
          fs.readSync(fd, last, 0, 1, size - 1);
          if (last[0] !== 0x0a) prefix = '\n';
        } finally {
          fs.closeSync(fd);
        }
      }
    }
    const line = `${prefix}${JSON.stringify(value)}\n`;
    if (options?.durable === false) {
      fs.appendFileSync(file, line, 'utf8');
      return;
    }
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeSync(fd, line, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  };
  // User data (archives, conflict reports) is appended under a lock: two
  // writers can otherwise interleave inside one line. High-frequency
  // bookkeeping (staging) stays lock-free on purpose: a crash there is
  // already tolerated by the torn-line reader, and a lock per event would
  // serialize every tool call.
  if (options?.durable === false) return append();
  return withFileLockSync(file, append, { timeoutMs: 3000, staleMs: 5000 });
}

/**
 * Write JSON through a temp file + rename so a crash cannot leave half a file.
 *
 * `durable` (default true) fsyncs the temp file before the rename and the
 * directory after it, so a power cut cannot lose the last write: without the
 * first fsync the rename can publish an empty/partial file; without the second
 * the rename itself may not be on disk. `durable: false` keeps the old cheap
 * path for derived files (usage counters, compaction status).
 */
export function writeJson(file, value, options = {}) {
  const durable = options?.durable !== false;
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (durable) fsyncFile(tmp);
  fs.renameSync(tmp, file);
  if (durable) fsyncDir(path.dirname(file));
}

/*
 * Cross-process mutual exclusion for read-modify-write files.
 *
 * `writeJson` is an atomic *write*, not an exclusive one: two processes that
 * read the same file, change it and rename it back both "succeed", and the
 * later rename silently drops the earlier update. DSH can have several writers
 * at once (a host process, the Web panel's API server, an MCP client), so the
 * shared state files take a lock around the whole read-modify-write section.
 *
 * The lock is a directory: `mkdir` is atomic on every filesystem we care about
 * (including NTFS), and a directory carries its owner record plus an mtime that
 * lets a later writer tell a live lock from one left behind by a crash. There is
 * deliberately no daemon and no dependency: the plugin stays zero-dependency.
 */

const LOCK_POLL_MS = 20;
// Windows can report these while a just-released lock directory is still in
// the delete-pending state; they mean "retry", not "fail".
const LOCK_CONTENTION = new Set(['EEXIST', 'EPERM', 'EACCES', 'ENOENT', 'ENOTEMPTY', 'EBUSY']);

/** Lock directory guarding `file`; the file's neighbours are never touched. */
export function fileLockPath(file) {
  return `${file}.lock`;
}

function lockAge(lockDir) {
  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs;
  } catch {
    return null;
  }
}

/** Move a stale lock out of the way; false means another writer won the race. */
function stealLock(lockDir) {
  const stale = `${lockDir}.stale-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(lockDir, stale);
  } catch {
    return false;
  }
  try { fs.rmSync(stale, { recursive: true, force: true }); } catch { /* best effort */ }
  return true;
}

function createLock(lockDir) {
  fs.mkdirSync(lockDir);
  try {
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
      pid: process.pid, host: os.hostname(), at: Date.now(),
    }));
  } catch {
    // The directory itself is the lock; the owner record is diagnostic only.
  }
}

function lockOptions(options = {}) {
  return {
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 5000,
    staleMs: Number.isFinite(options.staleMs) ? options.staleMs : 10000,
  };
}

function lockTimeout(lockDir, timeoutMs) {
  return new Error(`等待文件锁超时（${timeoutMs}ms）：${lockDir}。`
    + '如果确认没有其他进程在写这份数据，可以删除该 .lock 目录后重试。');
}

function sleepBlocking(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` while holding the cross-process lock for `target` (sync).
 *
 * @template T
 * @param {string} target - file whose read-modify-write section is protected
 * @param {() => T} fn
 * @param {{timeoutMs?: number, staleMs?: number}} [options]
 * @returns {T}
 */
export function withFileLockSync(target, fn, options = {}) {
  const { timeoutMs, staleMs } = lockOptions(options);
  const lockDir = fileLockPath(target);
  ensureDir(path.dirname(lockDir));
  const started = Date.now();
  for (;;) {
    try {
      createLock(lockDir);
      break;
    } catch (error) {
      if (!LOCK_CONTENTION.has(error?.code)) throw error;
      const age = lockAge(lockDir);
      // A crashed writer leaves the directory behind; anything older than
      // `staleMs` cannot be a live critical section on this storage.
      if (age !== null && age > staleMs && stealLock(lockDir)) continue;
      if (Date.now() - started >= timeoutMs) throw lockTimeout(lockDir, timeoutMs);
      sleepBlocking(LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    // Another writer may have stolen a stale lock already; release is best effort.
    try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Async variant of {@link withFileLockSync} for callers that await their work.
 *
 * @template T
 * @param {string} target
 * @param {() => Promise<T> | T} fn
 * @param {{timeoutMs?: number, staleMs?: number}} [options]
 * @returns {Promise<T>}
 */
export async function withFileLock(target, fn, options = {}) {
  const { timeoutMs, staleMs } = lockOptions(options);
  const lockDir = fileLockPath(target);
  ensureDir(path.dirname(lockDir));
  const started = Date.now();
  for (;;) {
    try {
      createLock(lockDir);
      break;
    } catch (error) {
      if (!LOCK_CONTENTION.has(error?.code)) throw error;
      const age = lockAge(lockDir);
      if (age !== null && age > staleMs && stealLock(lockDir)) continue;
      if (Date.now() - started >= timeoutMs) throw lockTimeout(lockDir, timeoutMs);
      await new Promise((resolve) => { setTimeout(resolve, LOCK_POLL_MS); });
    }
  }
  try {
    return await fn();
  } finally {
    // Another writer may have stolen a stale lock already; release is best effort.
    try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** Read JSON, returning null on any failure. */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** All `*.json` files in a directory, sorted by name. */
export function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
    .map((name) => path.join(dir, name));
}

/** All `*.jsonl` files in a directory, sorted by name. */
export function listJsonlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort()
    .map((name) => path.join(dir, name));
}

/** Truncate long text for model-facing summaries. */
export function clip(text, limit = 400) {
  const value = String(text ?? '');
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/**
 * Insertion-ordered LRU with an entry cap and an optional weight budget.
 *
 * Some caches in this plugin are process-wide (parsed files, derived views),
 * and a long DSH session reads many memory roots and conversations. A plain Map
 * would therefore keep every parsed value until exit. `weight` is the source
 * file's byte size, a cheap proxy for the parsed value's footprint. A single
 * value heavier than the whole budget is not retained at all: caching it would
 * evict everything else and still exceed the limit.
 */
export class BoundedCache {
  /** @param {{maxEntries?: number, maxBytes?: number}} [options] */
  constructor(options = {}) {
    const maxEntries = Number(options.maxEntries ?? 1000);
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError('BoundedCache: maxEntries 必须是正整数');
    }
    const maxBytes = Number(options.maxBytes ?? 0);
    if (!Number.isFinite(maxBytes) || maxBytes < 0) {
      throw new TypeError('BoundedCache: maxBytes 必须是非负数');
    }
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this._bytes = 0;
    this._map = new Map();
  }

  get size() { return this._map.size; }

  get bytes() { return this._bytes; }

  /** The cached value, refreshed as most-recently-used; undefined when absent. */
  get(key) {
    const entry = this._map.get(key);
    if (entry === undefined) return undefined;
    // Map iteration follows insertion order: re-insert to mark it as used.
    this._map.delete(key);
    this._map.set(key, entry);
    return entry.value;
  }

  /** Store one value; `weight` is excluded from the budget when not positive. */
  set(key, value, weight = 0) {
    const size = Number.isFinite(weight) && weight > 0 ? weight : 0;
    this.delete(key);
    if (this.maxBytes > 0 && size > this.maxBytes) return this;
    this._map.set(key, { value, weight: size });
    this._bytes += size;
    this._trim();
    return this;
  }

  delete(key) {
    const entry = this._map.get(key);
    if (entry === undefined) return false;
    this._map.delete(key);
    this._bytes = Math.max(0, this._bytes - entry.weight);
    return true;
  }

  clear() {
    this._map.clear();
    this._bytes = 0;
  }

  _trim() {
    while (this._map.size > this.maxEntries
      || (this.maxBytes > 0 && this._bytes > this.maxBytes)) {
      const oldest = this._map.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }
}
