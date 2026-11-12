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

import { writeJson } from './util.js';

/** Default registry directory: `$DSH_HOME/ai-for-memory`. */
export function defaultRegistryDir(env = process.env) {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'ai-for-memory');
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

  const roots = readRoots(dir);
  const entry = {
    root: absolute,
    workspace: workspace ? path.resolve(workspace) : null,
    label: workspace ? (path.basename(workspace) || workspace) : (path.basename(absolute) || absolute),
    updatedAt: new Date().toISOString(),
  };
  const index = roots.findIndex((row) => samePath(row.root, absolute));
  if (index >= 0) roots[index] = { ...roots[index], ...entry };
  else roots.unshift(entry);
  roots.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

  try {
    writeJson(registryFile(dir), { version: 1, roots: roots.slice(0, 100) });
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
    // A configured fixed root is the deployment's primary memory directory.
    return all[0];
  }
  return all.find((root) => samePath(root, candidate)) ?? null;
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
