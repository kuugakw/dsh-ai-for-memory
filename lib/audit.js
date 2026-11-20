/**
 * Small append-only action log for user-visible memory operations.
 *
 * It deliberately lives outside the memory layers: audits are about what the
 * panel did (confirm/delete/cleanup/sync), not another kind of project fact.
 * One JSONL file under the registry directory, capped on read.
 */

import fs from 'node:fs';
import path from 'node:path';

const FILE_NAME = 'audit.jsonl';
const MAX_READ = 200;

function auditFile(registryDir) {
  return path.join(registryDir, FILE_NAME);
}

export function appendAudit(registryDir, event = {}) {
  if (typeof registryDir !== 'string' || registryDir === '') return null;
  const file = auditFile(registryDir);
  const row = {
    at: new Date().toISOString(),
    action: String(event.action ?? 'unknown').slice(0, 80),
    root: String(event.root ?? '').slice(0, 1000),
    detail: event.detail === undefined ? '' : String(event.detail).slice(0, 2000),
  };
  try {
    fs.mkdirSync(registryDir, { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  } catch {
    // Auditing must never break the operation it describes.
    return null;
  }
  return row;
}

export function readAudit(registryDir, limit = MAX_READ) {
  if (typeof registryDir !== 'string' || registryDir === '') return [];
  const file = auditFile(registryDir);
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object') rows.push(row);
    } catch {
      // A torn last line is normal under a concurrent append; skip it.
    }
  }
  return rows.slice(-Math.max(1, Math.min(MAX_READ, Number(limit) || MAX_READ))).reverse();
}
