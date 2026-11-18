/**
 * DSH workspace resolution.
 *
 * A conversation's live working directory moves around while you work (opening
 * a sub-folder does not create a new workspace), so it is the wrong grouping
 * key. DSH itself already groups sessions by the workspace that opened them:
 *
 *   <home>/.dsh/sessions/--D-ai-~5DE5~4F5C~533A--/session-<id>/session.v4.jsonl.zstd
 *
 * The directory name is the workspace path encoded (`/`, `\` and the drive
 * colon → `-`, other non-alphanumerics → `~XXXX` UTF-16 escapes). Grouping
 * memory conversations by that bucket means one group per workspace, and a new
 * group appears only when a new workspace is actually created in DSH.
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
  // Keep this in sync with DSH's `projectKey`: separators and the drive colon
  // collapse to one `-`, safe characters are literal, everything else is a
  // UTF-16 unit escape. In particular do NOT escape `:` as `~003A`; DSH uses
  // `-` for it, which is why `D:\ai` becomes `--D-ai--`.
  let separatorRun = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const char = String.fromCharCode(code);
    if (char === '/' || char === '\\' || char === ':') {
      if (!separatorRun) encoded += '-';
      separatorRun = true;
    } else if (code < 128 && /[A-Za-z0-9._-]/.test(char)) {
      encoded += char;
      separatorRun = false;
    } else {
      encoded += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  const slug = encoded.replace(/^-+/, '').slice(0, 251) || 'root';
  return `--${slug}--`;
}

/**
 * Best-effort decode of a bucket name back into a path.
 *
 * A bucket has no explicit "Windows vs POSIX" bit. A one-letter first segment
 * is treated as a Windows drive (`D:\...`); everything else is decoded as an
 * absolute POSIX path (`/tmp/...`). The resolver below also tries the other
 * interpretation, so a POSIX workspace literally named `/C/foo` still lands
 * on the existing directory when there is one.
 *
 * Hyphens are ambiguous (DSH encodes separators and literal hyphens as the
 * same `-`), so the result is repaired against the disk by
 * {@link resolveWorkspacePath} before it is shown.
 */
export function decodeWorkspaceBucket(bucket) {
  const value = String(bucket ?? '');
  if (!value.startsWith('--') || !value.endsWith('--') || value.length <= 4) return '';
  const inner = value.slice(2, -2);
  if (inner === '') return '';
  const parts = inner.split('-').map((part) => part.replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))));
  const drive = /^[A-Za-z]$/.test(parts[0]);
  if (drive) return `${parts[0]}:\\${parts.slice(1).join('\\')}`;
  const segments = parts.filter((part) => part !== '');
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

/**
 * Turn a decoded path into one that actually exists.
 *
 * The bucket format is lossy: it does not say whether the original path used
 * Windows or POSIX separators, and it collapses separators and literal hyphens.
 * Try both interpretations against the disk, then regroup hyphen-split
 * segments until every level exists. When nothing exists, return a normalized
 * path in the decoded style instead of the raw backslash string (the old
 * behaviour made POSIX workspaces look like `\tmp\...` and split each one into
 * its own group).
 */
export function resolveWorkspacePath(decoded) {
  const value = String(decoded ?? '').trim();
  if (value === '') return '';
  if (fs.existsSync(value)) return value;

  const candidates = workspaceCandidates(value);
  for (const candidate of candidates) {
    if (candidate.path !== value && fs.existsSync(candidate.path)) return candidate.path;
  }
  for (const candidate of candidates) {
    const restored = fitSegments(candidate);
    if (restored !== null) return restored;
  }
  const origin = candidates.find((candidate) => candidate.origin) ?? candidates[0];
  return origin?.path ?? value;
}

/** Build the plausible path interpretations for one decoded string. */
function workspaceCandidates(value) {
  const out = [];
  const push = (style, root, parts, origin) => {
    const joined = parts.join(style === 'win32' ? '\\' : '/');
    const display = style === 'win32'
      ? (root === '' ? joined : `${root}${joined === '' ? '\\' : `\\${joined}`}`)
      : `${root}${joined}`;
    const normalized = style === 'win32' ? path.win32.normalize(display) : path.posix.normalize(display);
    if (normalized !== '' && !out.some((candidate) => candidate.path === normalized)) {
      out.push({ style, root, parts, origin, path: normalized });
    }
  };

  const win = /^([A-Za-z]):(?:[\\/]|$)/.exec(value);
  if (win !== null) {
    const rest = value.slice(2).replace(/^[\\/]+/, '').split(/[\\/]+/).filter(Boolean);
    push('win32', `${win[1]}:`, rest, true);
    push('posix', '/', [win[1], ...rest], false);
    return out;
  }
  if (value.startsWith('/')) {
    const rest = value.slice(1).split('/').filter(Boolean);
    push('posix', '/', rest, true);
    if (/^[A-Za-z]$/.test(rest[0] ?? '')) push('win32', `${rest[0]}:`, rest.slice(1), false);
    return out;
  }
  if (value.includes('\\')) {
    const parts = value.split('\\').filter(Boolean);
    push('win32', '', parts, true);
    push('posix', '/', value.replace(/\\/g, '/').split('/').filter(Boolean), false);
    return out;
  }
  push('posix', '/', value.split('/').filter(Boolean), true);
  return out;
}

/** Depth-first re-grouping of hyphen-split segments into directories that exist. */
function fitSegments(candidate) {
  const { style, root, parts } = candidate;
  const join = (current, segment) => {
    if (style === 'win32') return current === '' ? segment : `${current}${current.endsWith('\\') ? '' : '\\'}${segment}`;
    return current === '/' ? `/${segment}` : `${current}/${segment}`;
  };
  const normalize = (current) => (style === 'win32' ? path.win32.normalize(current) : path.posix.normalize(current));

  const search = (current, index) => {
    if (index >= parts.length) return normalize(current);
    for (let take = 1; index + take <= parts.length; take += 1) {
      const next = join(current, parts.slice(index, index + take).join('-'));
      if (!fs.existsSync(next)) continue;
      const restored = search(next, index + take);
      if (restored !== null) return restored;
    }
    return null;
  };

  return search(root === '' && style === 'win32' ? '' : root, 0);
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
