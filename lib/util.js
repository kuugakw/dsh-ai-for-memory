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
export const SCHEMA_VERSION = 2;

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
  // Memory content is private to the OS account: 0700 keeps other local
  // accounts out even when the directory sits on a shared or synced disk.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
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
export function appendJsonLine(file, value, options = /** @type {any} */ ({})) {
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
      fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
      return;
    }
    const fd = fs.openSync(file, 'a', 0o600);
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
  return withFileLockSync(file, append, { timeoutMs: 8000, staleMs: 5000 });
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
export function writeJson(file, value, options = /** @type {any} */ ({})) {
  const durable = options?.durable !== false;
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  // 0600: the store holds conversation archives and knowledge, which can carry
  // secrets pasted into a chat. The temp file gets the final mode so the rename
  // publishes a private file, not a 0644 one for a moment.
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
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

/**
 * What the lock's owner record says about liveness.
 *
 * @returns {'alive'|'dead'|'missing'|'foreign'|'invalid'} `missing` is the
 *   crash window between `mkdir` and the owner write (or an unreadable owner
 *   record); `dead` means the pid is gone; `foreign` means another machine
 *   owns it on a shared drive, where pid liveness cannot be checked and only
 *   the age fallback applies.
 */
function lockOwnerState(lockDir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8');
  } catch {
    return 'missing';
  }
  let owner;
  try {
    owner = JSON.parse(raw);
  } catch {
    // Atomic owner writes mean a corrupt record implies a dead writer or an
    // older version; treat it like the empty-directory window, not like a live
    // foreign lock that must wait out the full stale window.
    return 'missing';
  }
  if (!owner || !Number.isInteger(owner.pid)) return 'missing';
  if (owner.host !== os.hostname()) return 'foreign';
  try {
    process.kill(owner.pid, 0);
    return 'alive';
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error?.code === 'EPERM' ? 'alive' : 'dead';
  }
}

// A lock directory without an owner record can only be the microseconds between
// `mkdir` and the owner write. If it stays empty this long, its creator died
// mid-acquisition (or the owner write was refused) and a writer may take over.
const LOCK_EMPTY_GRACE_MS = 1000;

function createLock(lockDir) {
  fs.mkdirSync(lockDir);
  // The nonce identifies *this* acquisition. A writer whose lock is stolen
  // while it is still working must not delete the thief's lock on release.
  const owner = { pid: process.pid, host: os.hostname(), at: Date.now(), nonce: crypto.randomUUID() };
  // Write the owner record through a temp file: a writer killed mid-write must
  // not leave a partial owner.json, or the next writer would wait for the age
  // fallback instead of recognising a crash.
  const tmp = path.join(lockDir, `owner.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(owner));
    fs.renameSync(tmp, path.join(lockDir, 'owner.json'));
  } catch {
    // The directory itself is the lock; the owner record is diagnostic only.
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
  return owner;
}

/**
 * Release only when the lock still belongs to this acquisition.
 *
 * A lock older than `staleMs` may have been stolen and replaced by another
 * writer while we were still inside the critical section. An unconditional
 * `rmSync` would delete *that* writer's lock and let a third writer in, so
 * every release compares the owner record (nonce/pid/host) first.
 */
function releaseLock(lockDir, owner) {
  let raw = null;
  try {
    raw = fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8');
  } catch {
    // The owner record was never written (or was already removed); treating the
    // directory as ours is safe because a stolen lock always has an owner.
  }
  if (raw !== null) {
    let current;
    try { current = JSON.parse(raw); } catch { current = null; }
    if (current && current.nonce && current.nonce !== owner.nonce) return;
    if (current && (current.pid !== owner.pid || current.host !== owner.host)) return;
  }
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function lockOptions(options = /** @type {any} */ ({})) {
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
 * @param {{timeoutMs?: number, staleMs?: number, [key: string]: any}} [options]
 * @returns {T}
 */
export function withFileLockSync(target, fn, options = /** @type {any} */ ({})) {
  const { timeoutMs, staleMs } = lockOptions(options);
  // A foreign lock can only be taken over once its age passes `staleMs`; a wait
  // shorter than that would always report a timeout before the takeover window
  // even opens (shared drive, default 5 s timeout vs 10 s stale). Only foreign
  // holders get this extended deadline: a live same-host owner is killed by
  // neither age nor pid, so the caller's timeout is the right bound there.
  const foreignWaitMs = Math.max(timeoutMs, staleMs + LOCK_POLL_MS);
  const lockDir = fileLockPath(target);
  ensureDir(path.dirname(lockDir));
  const started = Date.now();
  let owner;
  for (;;) {
    try {
      owner = createLock(lockDir);
      break;
    } catch (error) {
      if (!LOCK_CONTENTION.has(error?.code)) throw error;
      const age = lockAge(lockDir);
      // A crashed writer leaves the directory behind: its owner pid is gone, or
      // the owner record was never written. Both are take-over cases; the age
      // rule still covers unknown, foreign, or long-idle holders.
      const ownerState = lockOwnerState(lockDir);
      const abandoned = ownerState === 'missing' && age !== null && age > LOCK_EMPTY_GRACE_MS;
      const takeoverable = ownerState === 'dead' || abandoned || (age !== null && age > staleMs);
      if (takeoverable && stealLock(lockDir)) continue;
      // A foreign lock can only be taken over once its age passes `staleMs`; a
      // wait shorter than that would report a timeout before the takeover window
      // even opens (shared drive, default 5 s timeout vs 10 s stale).
      const deadline = ownerState === 'foreign' ? foreignWaitMs : timeoutMs;
      if (Date.now() - started >= deadline) throw lockTimeout(lockDir, deadline);
      sleepBlocking(LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    releaseLock(lockDir, owner);
  }
}

/**
 * Async variant of {@link withFileLockSync} for callers that await their work.
 *
 * @template T
 * @param {string} target
 * @param {() => Promise<T> | T} fn
 * @param {{timeoutMs?: number, staleMs?: number, [key: string]: any}} [options]
 * @returns {Promise<T>}
 */
export async function withFileLock(target, fn, options = /** @type {any} */ ({})) {
  const { timeoutMs, staleMs } = lockOptions(options);
  // Same rule as the sync variant: a foreign lock needs the extended deadline,
  // a live same-host lock does not.
  const foreignWaitMs = Math.max(timeoutMs, staleMs + LOCK_POLL_MS);
  const lockDir = fileLockPath(target);
  ensureDir(path.dirname(lockDir));
  const started = Date.now();
  let owner;
  for (;;) {
    try {
      owner = createLock(lockDir);
      break;
    } catch (error) {
      if (!LOCK_CONTENTION.has(error?.code)) throw error;
      const age = lockAge(lockDir);
      const ownerState = lockOwnerState(lockDir);
      const abandoned = ownerState === 'missing' && age !== null && age > LOCK_EMPTY_GRACE_MS;
      const takeoverable = ownerState === 'dead' || abandoned || (age !== null && age > staleMs);
      if (takeoverable && stealLock(lockDir)) continue;
      const deadline = ownerState === 'foreign' ? foreignWaitMs : timeoutMs;
      if (Date.now() - started >= deadline) throw lockTimeout(lockDir, deadline);
      await new Promise((resolve) => { setTimeout(resolve, LOCK_POLL_MS); });
    }
  }
  try {
    const result = fn();
    // A sync callback releases the lock without yielding: if the event loop
    // could run between `await` and release, a *sync* waiter (host hook) could
    // spin on Atomics.wait for the async holder's microtask — a self-deadlock.
    if (result && typeof /** @type {any} */ (result).then === 'function') return await result;
    return result;
  } finally {
    releaseLock(lockDir, owner);
  }
}

/** Read JSON, returning null on any failure. */
/**
 * Secrets that should never be persisted verbatim.
 *
 * The store is a long-lived local corpus: a key pasted into a chat reaches
 * `contexts/`, `staging/` and (via remember) `knowledge/`, then gets exported
 * and read by MCP clients. Redaction happens at the write boundary so those
 * files never hold the raw value; the replacement keeps a marker so the reader
 * knows something was removed.
 */
/**
 * Key names whose `key` segment is structural, not a credential. `primary_key`
 * and `sort_key` hold identifiers; redacting them loses data for no gain.
 */
const NON_SECRET_KEY_NAMES = new Set([
  'key', 'key_id', 'key_name', 'key_value',
  'primary_key', 'foreign_key', 'public_key', 'sort_key', 'partition_key',
  'routing_key', 'cache_key', 'shard_key', 'index_key', 'idempotency_key',
  'dedupe_key', 'group_key',
]);

/** Segments after `key` that describe the field rather than hold a credential. */
const STRUCTURAL_KEY_TAILS = new Set([
  'policy', 'name', 'id', 'type', 'format', 'algorithm', 'version', 'prefix',
  'suffix', 'header', 'field', 'column', 'path', 'file', 'url', 'endpoint',
  'length', 'size', 'count', 'enabled', 'mode', 'source', 'owner', 'scope',
]);

/** True when a key-like name such as `llm_key` or `openai_key_backup` may hold a credential. */
function isSensitiveKeyName(name) {
  const lower = String(name).toLowerCase();
  if (NON_SECRET_KEY_NAMES.has(lower)) return false;
  const segments = lower.split(/[-_]+/).filter(Boolean);
  if (segments.length === 0 || segments[0] === 'key') return false;
  const keyIndex = segments.indexOf('key');
  if (keyIndex < 0) return false;
  // `api_key_policy` names a policy, not a key; `openai_key_backup` is still a
  // credential name because `backup` is not structural.
  return !segments.slice(keyIndex + 1).some((segment) => STRUCTURAL_KEY_TAILS.has(segment));
}

const SECRET_RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED:private-key]'],
  // A Cookie/Set-Cookie header carries session tokens; redact the whole value
  // rather than trying to name every cookie. The header may sit after `curl -H`
  // on the same line, so the start is a line boundary or whitespace/quote.
  [/(^|[\s"'])(?:set-)?cookie\s*:\s*[^\r\n"']+/gi, '$1[REDACTED:cookie]'],
  // Azure storage keys are written as `AccountKey=...` inside a connection
  // string, often with no quotes or surrounding key/value punctuation.
  [/\b(accountkey|sharedkey)\s*=\s*[^;\s"']+/gi, '$1=[REDACTED:storage-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED:github-token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED:github-token]'],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, '[REDACTED:npm-token]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED:gitlab-token]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED:google-api-key]'],
  [/\bsk_(?:live|test)_[A-Za-z0-9]{10,}\b/g, '[REDACTED:stripe-key]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED:api-key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-access-key]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED:slack-token]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED:jwt]'],
  // No leading \b: environment-variable style names such as DB_PASSWORD= or
  // MY_SECRET= are adjacent to a word character (_) and would otherwise slip
  // through. The value still has to look like a credential (6+ chars).
  //
  // Quoted keys first: `{"api_key": "…"}` has a closing quote between the key
  // and the colon, so the unquoted rule below never sees `api_key:` and the
  // value stayed verbatim. The value may itself be quoted (JSON/YAML).
  [/(["'])((?:[A-Za-z0-9]+[_-])*(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key))\1(\s*:\s*)(["'])([^"'\n]{6,})\4/gi, '$1$2$1$3$4[REDACTED]$4'],
  [/\b((?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key))(\s*[=:]\s*)(["'])([^"'\n]{6,})\3/gi, '$1$2$3[REDACTED]$3'],
  [/((?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\s*[=:]\s*)([^\s"',;]{6,})/gi, '$1[REDACTED]'],
  // A passphrase may be a sentence with spaces, which the word rules above stop
  // at the first token. Redact the rest of the line.
  [/\b(passphrase|passcode)\s*[:=]\s*[^\r\n]+/gi, '$1=[REDACTED]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^:@\s/]*):([^@\s/]{3,})@/gi, '$1:[REDACTED]@'],
  // Authorization headers and bearer-style grants. The scheme can sit behind a
  // raw header name or a quoted JSON key (`"authorization": "Bearer ..."`), and
  // the token is the secret even when the key name itself is not in the list
  // above.
  [/\b(authorization\b["']?\s*[:=]\s*["']?)(?:bearer|basic|digest|negotiate|token)\s+[A-Za-z0-9._~+/=*-]{1,}/gi, '$1[REDACTED]'],
  [/\b(bearer|basic|digest|negotiate)\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{4,}/gi, '$1 [REDACTED]'],
  // Keys that carry a secret word as one `-`/`_` segment: `x-secret-key`,
  // `client_secret`, `secret_token`. The secret word has to be a segment, so a
  // key that merely mentions a policy after `api_key` (api_key_policy) stays a
  // name, not a credential.
  [/(["'])((?:[A-Za-z0-9]+[-_])*secret(?:[-_][A-Za-z0-9]+)*)\1(\s*:\s*)(["'])([^"'\n]{1,})\4/gi, '$1$2$1$3$4[REDACTED]$4'],
  [/\b((?:[A-Za-z0-9]+[-_])*secret(?:[-_][A-Za-z0-9]+)*)(\s*[:=]\s*)(["']?)([^"'\s,;]{1,})\3/gi, '$1$2$3[REDACTED]$3'],
  // Generic `*_key` names: `llm_key`, `openai_key_backup`, `service_key`.
  // A bare `key` and a few structural names (primary/sort/public key, ...) stay
  // untouched; that trade keeps identifiers readable without letting every
  // provider-specific key name through.
  [/(["']?)((?:[A-Za-z0-9]+[_-])*key(?:[_-][A-Za-z0-9]+)*)\1(\s*[:=]\s*)(["']?)([^"'\s,;]{6,})\4/gi,
    /** @type {any} */ ((match, quote, name, separator, valueQuote) => (
      isSensitiveKeyName(name)
        ? `${quote}${name}${quote}${separator}${valueQuote}[REDACTED]${valueQuote}`
        : match
    ))],
];

/** Replace recognizable credentials in one string. */
export function redactSecrets(text) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of SECRET_RULES) out = /** @type {any} */ (out.replace)(pattern, replacement);
  return out;
}

/**
 * Deep-copy a JSON value while redacting every string in it. Used for the
 * conversation archive, whose `raw_events` mirror the original messages.
 */
export function redactDeep(value, depth = 0) {
  if (depth > 10) return value;
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactDeep(item, depth + 1);
    return out;
  }
  return value;
}

/**
 * One-time chmod sweep for a store written before files were created 0600.
 *
 * The marker makes this run once per root: walking a large store on every
 * `init()` would turn every tool call into an O(files) syscall storm.
 *
 * @param {string} root
 * @param {string} [markerName]
 * @returns {boolean} whether the sweep ran
 */
export function hardenTreePermissions(root, markerName = '.permissions-0600') {
  const marker = path.join(root, markerName);
  try {
    if (fs.existsSync(marker)) return false;
  } catch {
    return false;
  }
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) {
          fs.chmodSync(full, 0o700);
          walk(full);
        } else if (entry.isFile()) {
          fs.chmodSync(full, 0o600);
        }
      } catch {
        // Windows and network filesystems may not support chmod; best effort.
      }
    }
  };
  walk(root);
  try {
    fs.writeFileSync(marker, '', { mode: 0o600 });
  } catch {
    // A read-only root just means the sweep repeats next time.
  }
  return true;
}

/** Read JSON, returning null on any failure. */
export function readJson(file) {  try {
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
  /** @param {{maxEntries?: number, maxBytes?: number, [key: string]: any}} [options] */
  constructor(options = /** @type {any} */ ({})) {
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

