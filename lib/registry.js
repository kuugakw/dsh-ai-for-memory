// @ts-check
/**
 * Global registry of memory roots.
 *
 * Memory stays per workspace by default, but the UI needs a place to discover
 * every project's store. Each write path records its absolute root here, under
 * `$DSH_HOME/ai-for-memory/roots.json`; the UI only ever reads roots present
 * in this file (plus the configured fixed root), so the HTTP API never becomes
 * a generic file reader.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { dshHome, withFileLockSync, writeJson } from './util.js';

/** Default registry directory: `$DSH_HOME/ai-for-memory`. */
export function defaultRegistryDir(env = process.env) {
  return path.join(dshHome(env), 'ai-for-memory');
}

function registryFile(dir) {
  return path.join(dir, 'roots.json');
}

/** Windows paths compare case-insensitively; others exactly. */
export function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** True when a path sits inside the OS temp directory (where test roots live). */
function underTemp(target) {
  try {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(target));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

/**
 * Test/CI roots are created by `test/*.test.mjs` via mkdtemp (`agm-test-*`).
 * When a test suite forgets to point DSH_HOME at a temp directory they leak
 * into the real registry and the panel starts on an empty root (all counters
 * zero). They are safe to prune: no real project is called `agm-test-*`.
 */
function isTestRootRow(row) {
  const root = typeof row?.root === 'string' ? row.root : '';
  const workspace = typeof row?.workspace === 'string' ? row.workspace : '';
  return /(^|[\\/])agm-test-[^\\/]*/i.test(root) || /(^|[\\/])agm-test-[^\\/]*/i.test(workspace);
}

/** Prefer an existing, non-temp root; keep old behaviour when nothing exists. */
function chooseDefaultRoot(roots) {
  if (roots.length === 0) return null;
  const existing = roots.filter(isDirectory);
  const preferred = existing.filter((root) => !underTemp(root) && !isTestRootRow({ root }));
  return preferred[0] ?? existing[0] ?? roots[0] ?? null;
}

/** Read the registry; corrupt or missing files degrade to an empty list. */
export function readRoots(dir = defaultRegistryDir()) {
  try {
    const data = JSON.parse(fs.readFileSync(registryFile(dir), 'utf8'));
    if (!data || !Array.isArray(data.roots)) return [];
    return data.roots.filter((row) => row && typeof row.root === 'string');
  } catch {
    return [];
  }
}

const seen = new Set();

/**
 * Record one root (idempotent per process).
 *
 * @param {string} root - absolute memory root.
 * @param {string|null} workspace - session workspace that wrote it.
 * @param {string} [dir] - registry directory.
 */
export function rememberRoot(root, workspace, dir = defaultRegistryDir()) {
  const absolute = path.resolve(root);
  const key = `${path.resolve(dir)}\n${process.platform === 'win32' ? absolute.toLowerCase() : absolute}`;
  // Re-write when the registry file disappeared externally, not only on first use.
  if (seen.has(key) && fs.existsSync(registryFile(dir))) return absolute;
  seen.add(key);

  const entry = {
    root: absolute,
    workspace: workspace ? path.resolve(workspace) : null,
    label: workspace ? (path.basename(workspace) || workspace) : (path.basename(absolute) || absolute),
    updatedAt: new Date().toISOString(),
  };

  try {
    // Several sessions (and the panel) register roots concurrently; read inside
    // the lock so a slower writer does not drop the other's entry.
    withFileLockSync(registryFile(dir), () => {
      const current = readRoots(dir);
      const index = current.findIndex((row) => samePath(row.root, absolute));
      if (index >= 0) current[index] = { ...current[index], ...entry };
      else current.unshift(entry);
      current.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      writeJson(registryFile(dir), { version: 1, roots: current.slice(0, 100) });
    });
  } catch {
    // A read-only home must not break memory writes.
  }
  return absolute;
}

/**
 * Resolve a requested root against the registry (plus configured fixed roots).
 * Returns null when the request names an unknown path.
 */
export function resolveRegisteredRoot(candidate, dir = defaultRegistryDir(), extras = []) {
  const roots = readRoots(dir).map((row) => row.root);
  const fixed = [];
  for (const extra of extras) {
    if (typeof extra === 'string' && extra.trim() !== '') fixed.push(path.resolve(extra));
  }
  const all = [...new Set([...fixed, ...roots])];
  if (all.length === 0) return null;
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    // A configured fixed root is the deployment's primary memory directory;
    // without one, skip test/temp roots so the panel cannot open on an empty
    // `agm-test-*` directory while a real project root exists.
    return fixed.length > 0 ? fixed[0] : chooseDefaultRoot(all);
  }
  return all.find((root) => samePath(root, candidate)) ?? null;
}

/**
 * Drop test-suite roots (`agm-test-*`) that leaked into the global registry.
 * Called from the panel state route, never from a tool write path.
 *
 * @param {string} [dir]
 * @returns {number} number of removed rows
 */
export function pruneTestRoots(dir = defaultRegistryDir()) {
  try {
    const current = readRoots(dir);
    const kept = current.filter((row) => !isTestRootRow(row));
    if (kept.length === current.length) return 0;
    withFileLockSync(registryFile(dir), () => {
      writeJson(registryFile(dir), { version: 1, roots: kept.slice(0, 100) });
    });
    return current.length - kept.length;
  } catch {
    return 0;
  }
}

/** Display rows for the root picker, deduplicated and fixed-root first. */
export function listRootRows(dir = defaultRegistryDir(), fixedRoot = '') {
  const rows = readRoots(dir).map((row) => ({
    root: row.root,
    label: row.label || path.basename(row.root) || row.root,
    workspace: row.workspace ?? null,
    updatedAt: row.updatedAt ?? '',
    fixed: false,
  }));
  if (typeof fixedRoot === 'string' && fixedRoot.trim() !== '') {
    const absolute = path.resolve(fixedRoot);
    const existing = rows.find((row) => samePath(row.root, absolute));
    if (existing) {
      existing.fixed = true;
      // A fixed root is shared by every project; the last writer's workspace
      // name would be misleading, so label it by its role.
      existing.label = '固定记忆目录';
    } else {
      rows.unshift({
        root: absolute,
        label: '固定记忆目录',
        workspace: null,
        updatedAt: '',
        fixed: true,
      });
    }
  }
  return rows;
}
