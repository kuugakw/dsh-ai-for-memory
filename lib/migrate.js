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
 *   - a missing schema.json on an existing store is treated as the **oldest
 *     known layout** (v1) and migrated forward; the rules must be idempotent so
 *     running them twice is harmless. Skipping the chain would leave a v1 store
 *     unstamped and unredacted.
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

import { SCHEMA_VERSION, nowIso, readJson, redactDeep, withFileLockSync, writeJson } from './util.js';

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
export function writeSchemaVersion(root, version, options = /** @type {any} */ ({})) {
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
/** Data directories whose JSON/JSONL files are rewritten by migrations. */
const DATA_DIRS = ['staging', 'archive', 'snapshots', 'knowledge', 'decisions', 'contexts', 'pending'];

/** Every memory data file under `root`, excluding backups and schema.json. */
export function dataFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'backups' || entry.name === 'schema.json') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(json|jsonl)$/i.test(entry.name)) {
        out.push(full);
      }
    }
  };
  for (const name of DATA_DIRS) walk(path.join(root, name));
  return out;
}

/**
 * Replace a text file through a temp file + fsync + rename.
 *
 * The migration used a bare writeFileSync for JSONL: a kill in the middle left a
 * half-written line, and the panels had no hint that a rollback was needed. This
 * is the same discipline `writeJson` uses, for the same reason.
 */
function writeTextDurable(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } catch {
    // Directory fsync is a durability extra; some platforms refuse to open dirs.
  }
}

/**
 * Ordered forward migrations.
 *
 * v1 → v2: 0.5.7 started redacting secrets on write, but everything written by
 * earlier builds was still plaintext on disk. This step rewrites the whole
 * corpus through `redactDeep`, so knowledge, context archives, staging rows and
 * decisions stop leaking keys through export, MCP clients and Git sync. It is
 * idempotent: redacting an already-redacted value changes nothing.
 */
export const MIGRATIONS = [{
  from: 1,
  to: 2,
  description: 'redact secrets that were written before 0.5.7',
  files: (store) => dataFiles(store.root),
  run: (store) => {
    // The user can opt out of redaction (a deliberately recorded config line);
    // the migration must not rewrite their data against that choice.
    if (store.redactSecrets === false) return;
    for (const file of dataFiles(store.root)) {
      if (file.endsWith('.json')) {
        const data = readJson(file);
        if (data === null) continue;
        const next = redactDeep(data);
        // Most corpora carry no secret at all. Rewriting every file through
        // writeJson (fsync + rename + dir fsync) made an upgrade freeze init for
        // ~10 s on a 3000-doc store; an unchanged file must not be rewritten.
        if (JSON.stringify(next) === JSON.stringify(data)) continue;
        writeJson(file, next, { durable: true });
        continue;
      }
      const raw = fs.readFileSync(file, 'utf8');
      const lines = raw.split('\n').filter((line) => line.trim() !== '');
      const redacted = [];
      let changed = false;
      for (const line of lines) {
        try {
          const nextLine = JSON.stringify(redactDeep(JSON.parse(line)));
          if (nextLine !== line) changed = true;
          redacted.push(nextLine);
        } catch {
          // A torn or foreign line is preserved verbatim; it is not ours to drop.
          redacted.push(line);
        }
      }
      if (!changed) continue;
      writeTextDurable(file, `${redacted.join('\n')}\n`);
    }
  },
}];

/**
 * Expand `from → to` into the ordered steps that must run.
 *
 * @returns {Array<any>} steps, or a gap error when the chain is broken
 */
export function planMigrations(from, to, steps = MIGRATIONS) {
  const ordered = [...steps]
    .filter((step) => Number.isInteger(step?.from) && Number.isInteger(step?.to) && step.to > step.from)
    .sort((left, right) => left.to - right.to);
  let version = from;
  const plan = [];
  for (const step of ordered) {
    // Steps at or below the current version are already applied; including them
    // would look like a chain break when `from` is past their `to`.
    if (step.to <= version) continue;
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
 * @param {{root: string, _migrations?: Array<any>, _schemaVersion?: number, [key: string]: any}} store
 * @param {{steps?: Array<any>, to?: number, [key: string]: any}} [options]
 * @returns {{migrated: boolean, from: number, to: number, backupDir: string}}
 */
export function migrateStore(store, options = /** @type {any} */ ({})) {
  // Two DSH windows (or the panel and the host) can init the same root at the
  // same time; migration rewrites every file, so it takes the same lock as the
  // other read-modify-write paths.
  return withFileLockSync(schemaFilePath(store.root), () => migrateLocked(store, options));
}

function migrateLocked(store, options = /** @type {any} */ ({})) {
  const steps = options.steps ?? store._migrations ?? MIGRATIONS;
  const to = options.to ?? store._schemaVersion ?? SCHEMA_VERSION;
  const current = readSchemaVersion(store.root);
  // A store without schema.json predates the file: it is v1, not "current".
  // Migrating it again is harmless (the steps are idempotent), skipping it is not.
  const from = current === null ? 1 : current.version;
  if (from > to) {
    throw new Error(
      `记忆数据由更新版本的插件写入（schema v${String(from)}），当前插件只到 v${String(to)}；`
      + '请升级插件后再读写这个目录',
    );
  }
  const plan = planMigrations(from, to, steps);
  if (plan.length === 0) {
    // Old store already at the current layout: stamp it so the next run skips.
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
      // The memory root is 0700; the backup must not be more permissive, or
      // another account on the same host could list doc ids and snapshot ids.
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.copyFileSync(file, target);
    }
    step.run?.(store, { backupDir, from: step.from, to: step.to });
  }
  writeSchemaVersion(store.root, to, { note: `migrated from v${from}` });
  console.log(`[ai-for-memory] 记忆数据已从 v${from} 迁移到 v${to}；备份在 ${backupDir}`
    + '（与语料同体积，含脱敏前的明文，确认无误后可自行删除或设置 backupRetentionDays 自动清理）');
  return { migrated: true, from, to, backupDir };
}
