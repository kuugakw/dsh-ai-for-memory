/**
 * Shared helpers for AI for Memory: ids, filenames, JSONL I/O and anchors.
 *
 * Everything here is plain Node (no `@deepseek-ai/*` imports) so the whole
 * store can be exercised in a normal `node --test` run without booting DSH.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Coarse classifications a staged record can carry. */
export const KINDS = [
  'action', 'screenshot', 'decision', 'reasoning', 'error', 'state', 'digest', 'unknown',
];

/** Risk levels understood by the decision review. */
export const RISKS = ['low', 'medium', 'high'];

/** Verification states for staged records. */
export const VERIFIES = ['pending', 'pass', 'fail', 'skip'];

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

/**
 * Append one JSON object as a line.
 *
 * If the file ends without a newline (a crash during the previous write), a
 * newline is inserted first; otherwise the new record would be glued to the
 * torn fragment and both lines would become unparseable.
 */
export function appendJsonLine(file, value) {
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
  fs.appendFileSync(file, `${prefix}${JSON.stringify(value)}\n`, 'utf8');
}

/** Write JSON through a temp file + rename so a crash cannot leave half a file. */
export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
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
