/**
 * DSH workspace resolution.
 *
 * A conversation's live working directory moves around while you work (opening
 * a sub-folder does not create a new workspace), so it is the wrong grouping
 * key. DSH itself already groups sessions by the workspace that opened them:
 *
 *   <home>/.dsh/sessions/--D-ai-~5DE5~4F5C~533A--/session-<id>/session.v4.jsonl.zstd
 *
 * The directory name is the workspace path encoded (`\` → `-`, other
 * non-alphanumerics → `~XXXX` UTF-16 escapes). Grouping memory conversations by
 * that bucket means one group per workspace, and a new group appears only when
 * a new workspace is actually created in DSH.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** `<DSH_HOME or ~/.dsh>/sessions` — where DSH keeps one bucket per workspace. */
export function dshSessionsDir(env = process.env) {
  const home = String(env?.DSH_HOME ?? '').trim();
  const base = home !== '' ? home : path.join(os.homedir(), '.dsh');
  return path.join(base, 'sessions');
}

/**
 * Encode a workspace path the way DSH names its bucket directory.
 *
 * @param {string} workspace
 * @returns {string} e.g. `--D-ai-~5DE5~4F5C~533A--`
 */
export function encodeWorkspace(workspace) {
  const value = String(workspace ?? '').trim();
  if (value === '') return '';
  let encoded = '';
  for (const char of value) {
    const code = char.codePointAt(0);
    if (char === '\\' || char === '/') encoded += '-';
    else if (code < 128 && /[A-Za-z0-9._]/.test(char)) encoded += char;
    else if (code < 0x10000) encoded += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
    else {
      // Surrogate pair: encode both UTF-16 units separately.
      for (let i = 0; i < 2; i += 1) {
        const unit = char.charCodeAt(i);
        encoded += `~${unit.toString(16).toUpperCase().padStart(4, '0')}`;
      }
    }
  }
  return `--${encoded}--`;
}

/**
 * Best-effort decode of a bucket name back into a path.
 *
 * Hyphens are ambiguous (DSH encodes both separators and the drive colon as
 * `-`), so the result is repaired against the disk by
 * {@link resolveWorkspacePath} before it is shown.
 */
export function decodeWorkspaceBucket(bucket) {
  const value = String(bucket ?? '');
  if (!value.startsWith('--') || !value.endsWith('--') || value.length <= 4) return '';
  const inner = value.slice(2, -2);
  if (inner === '') return '';
  const parts = inner.split('-').map((part) => part.replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))));
  const drive = /^[A-Za-z]$/.test(parts[0]) || /^[A-Za-z]:$/.test(parts[0]);
  let out = drive ? `${parts[0].replace(/:$/, '')}:` : parts[0];
  for (let index = 1; index < parts.length; index += 1) out += `\\${parts[index]}`;
  return out;
}

/**
 * Turn a decoded path into one that actually exists.
 *
 * DSH writes separators and literal hyphens as the same character, so a naive
 * decode can point at a path that was never there. Segments are re-grouped with
 * hyphens until every level exists again, which recovers `…/default-workspace`
 * as well as plain `D:\ai\工作区`.
 */
export function resolveWorkspacePath(decoded) {
  const value = String(decoded ?? '').trim();
  if (value === '') return '';
  if (fs.existsSync(value)) return value;
  const parts = value.split('\\').filter((part) => part !== '');
  if (parts.length < 2) return value;
  const head = /^[A-Za-z]$/.test(parts[0]) ? `${parts[0]}:` : parts[0];
  return fitSegments(head, parts.slice(1), 0) ?? value;
}

/** Depth-first re-grouping of decoded segments into directories that exist. */
function fitSegments(current, parts, index) {
  if (index === parts.length) return current;
  for (let take = 1; index + take <= parts.length; take += 1) {
    const candidate = `${current}\\${parts.slice(index, index + take).join('-')}`;
    if (!fs.existsSync(candidate)) continue;
    const restored = fitSegments(candidate, parts, index + take);
    if (restored !== null) return restored;
  }
  return null;
}

/**
 * Map DSH session ids to the workspace that opened them.
 *
 * @param {string} dir - DSH sessions directory.
 * @returns {Map<string, string>} sessionId → workspace path
 */
export function workspaceIndex(dir = dshSessionsDir()) {
  const index = new Map();
  let buckets = [];
  try {
    buckets = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return index;
  }
  for (const bucket of buckets) {
    const workspace = resolveWorkspacePath(decodeWorkspaceBucket(bucket));
    if (workspace === '') continue;
    let children = [];
    try {
      children = fs.readdirSync(path.join(dir, bucket));
    } catch {
      continue;
    }
    for (const child of children) {
      // DSH names the directory `session-<id>`; a few installs store the bare
      // id. Index both spellings so a memory record matches either way.
      index.set(child, workspace);
      if (child.startsWith('session-')) index.set(child.slice('session-'.length), workspace);
    }
  }
  return index;
}

let cache = { at: 0, dir: '', index: new Map() };

/**
 * Cached {@link workspaceIndex}; the panel asks for state on every action and
 * the sessions directory changes rarely.
 *
 * @param {string} [dir]
 * @param {number} [ttlMs]
 */
export function workspaceIndexCached(dir = dshSessionsDir(), ttlMs = 5000) {
  const now = Date.now();
  if (cache.dir === dir && now - cache.at < ttlMs) return cache.index;
  const index = workspaceIndex(dir);
  cache = { at: now, dir, index };
  return index;
}

/** Reset the module cache (tests). */
export function resetWorkspaceCache() {
  cache = { at: 0, dir: '', index: new Map() };
}
