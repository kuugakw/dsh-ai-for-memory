/**
 * On-disk schema version and forward migrations.
 *
 * Every store records its own data version in `<root>/schema.json`. The rules
 * are deliberately small:
 *
 *   - a store written by a **newer** plugin (schema.json > the running build's
 *     SCHEMA_VERSION) is refused instead of guessed at: reading it with older
 *     rules could silently drop fields;
 *   - a store from an **older** version is migrated in place, one ordered step
 *     at a time; each step runs exactly once and schema.json is bumped only
 *     after the whole plan succeeded;
 *   - files a step is about to rewrite are copied to
 *     `<root>/backups/schema-v<from>-<timestamp>/` first, so a failed migration
 *     can be restored without a manual backup;
 *   - a missing schema.json on an existing store is treated as the current
 *     version and written once (the v1 layout predates this file).
 *
 * A migration step is a plain object:
 *
 *   { from: 1, to: 2, description: '…',
 *     files: (store) => [store.knowledgeUsageFile],   // backed up first
 *     run: (store, { backupDir }) => { … } }
 *
 * `run` uses the store's own helpers (readJson/writeJson) so it stays testable
 * without booting DSH.
 */

import fs from 'node:fs';
import path from 'node:path';

import { SCHEMA_VERSION, nowIso, readJson, writeJson } from './util.js';

/** File holding the store data version; separate from the records themselves. */
export const SCHEMA_FILE = 'schema.json';

/** @param {string} root - memory root. */
export function schemaFilePath(root) {
  return path.join(root, SCHEMA_FILE);
}

/**
 * Read `<root>/schema.json`.
 *
 * @param {string} root
 * @returns {{version: number, updatedAt: string}|null}
 */
export function readSchemaVersion(root) {
  const data = readJson(schemaFilePath(root));
  if (!data || !Number.isInteger(data.schema_version)) return null;
  return {
    version: data.schema_version,
    updatedAt: typeof data.updated_at === 'string' ? data.updated_at : '',
  };
}

/** Write the store data version (and an optional human note). */
export function writeSchemaVersion(root, version, options = {}) {
  writeJson(schemaFilePath(root), {
    schema_version: version,
    updated_at: nowIso(),
    ...(typeof options.note === 'string' && options.note !== '' ? { note: options.note } : {}),
  });
}

/**
 * Ordered forward migrations. Empty today: v1 is the first public layout.
 *
 * Adding one: append `{ from: 1, to: 2, ... }`, bump `SCHEMA_VERSION` in
 * util.js, list the files it touches in `files`, write the transform in `run`,
 * and add a test that migrates a v1 fixture (see core.test.mjs).
 */
export const MIGRATIONS = [];

/**
 * Expand `from → to` into the ordered steps that must run.
 *
 * @returns {Array<object>} steps, or a gap error when the chain is broken
 */
export function planMigrations(from, to, steps = MIGRATIONS) {
  const ordered = [...steps]
    .filter((step) => Number.isInteger(step?.from) && Number.isInteger(step?.to) && step.to > step.from)
    .sort((left, right) => left.to - right.to);
  let version = from;
  const plan = [];
  for (const step of ordered) {
    if (step.to > to) break;
    if (step.from !== version) {
      throw new Error(`迁移链在 v${version} 处断裂：没有从 v${version} 出发的迁移步骤`);
    }
    plan.push(step);
    version = step.to;
  }
  return plan;
}

/**
 * Migrate one store to the running build's schema version.
 *
 * @param {{root: string, _migrations?: Array<object>, _schemaVersion?: number}} store
 * @param {{steps?: Array<object>, to?: number}} [options]
 * @returns {{migrated: boolean, from: number, to: number, backupDir: string}}
 */
export function migrateStore(store, options = {}) {
  const steps = options.steps ?? store._migrations ?? MIGRATIONS;
  const to = options.to ?? store._schemaVersion ?? SCHEMA_VERSION;
  const current = readSchemaVersion(store.root);
  const from = current === null ? to : current.version;
  if (from > to) {
    throw new Error(
      `记忆数据由更新版本的插件写入（schema v${String(from)}），当前插件只到 v${String(to)}；`
      + '请升级插件后再读写这个目录',
    );
  }
  const plan = planMigrations(from, to, steps);
  if (plan.length === 0) {
    // Old stores predate schema.json; stamp the layout they already use.
    if (current === null) writeSchemaVersion(store.root, to, { note: 'initialized' });
    return { migrated: false, from, to, backupDir: '' };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(store.root, 'backups', `schema-v${from}-${stamp}`);
  for (const step of plan) {
    const files = typeof step.files === 'function' ? step.files(store) : [];
    for (const file of files) {
      if (typeof file !== 'string' || !fs.existsSync(file)) continue;
      const target = path.join(backupDir, path.relative(store.root, file));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file, target);
    }
    step.run?.(store, { backupDir, from: step.from, to: step.to });
  }
  writeSchemaVersion(store.root, to, { note: `migrated from v${from}` });
  return { migrated: true, from, to, backupDir };
}
