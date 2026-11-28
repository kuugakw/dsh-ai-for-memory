#!/usr/bin/env node
/**
 * Coverage gate: global thresholds plus per-file floors.
 *
 * Node's built-in `--test-coverage-lines/-functions/-branches` flags only check
 * the whole suite, so a 109 KB module (lib/api.js) can sit near 30% while every
 * aggregate stays green. This runner parses the coverage table Node prints and
 * enforces a floor per core module as well: a file may improve freely, but it
 * may not silently regress below the level it already had.
 *
 * The numbers in FLOORS are a ratchet, not a target: raise them when a module
 * improves, never lower one to make a change pass.
 *
 * Run via `npm run coverage` (the tests workflow only calls it on ubuntu +
 * Node 22; the text table is stable across the supported Node versions).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const GLOBAL = { lines: 80, branches: 65, functions: 80 };

/** Per-file floors for the modules large enough to hide behind the average. */
const FLOORS = {
  'api.js': { lines: 65, branches: 50, functions: 72 },
  'index.js': { lines: 66, branches: 24, functions: 40 },
  'tools.js': { lines: 82, branches: 54, functions: 70 },
  'store.js': { lines: 91, branches: 76, functions: 90 },
  'knowledge-query.js': { lines: 88, branches: 66, functions: 92 },
  'knowledge-sqlite.js': { lines: 79, branches: 48, functions: 60 },
  'session-repair.js': { lines: 84, branches: 66, functions: 86 },
  'context-management.js': { lines: 79, branches: 67, functions: 79 },
  'ui-state.js': { lines: 89, branches: 52, functions: 70 },
  'local-engine.js': { lines: 75, branches: 60, functions: 82 },
};

const testScript = String(manifest.scripts?.test ?? '');
const match = /^node --test (.+)$/.exec(testScript);
if (!match) {
  console.error(`coverage: cannot read test file list from package.json scripts.test (${testScript})`);
  process.exit(1);
}
const files = match[1].trim().split(/\s+/);

const result = spawnSync(
  process.execPath,
  ['--test', '--experimental-test-coverage', ...files],
  { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
);
if (result.error) {
  console.error(`coverage: failed to run the suite: ${result.error.message}`);
  process.exit(1);
}
const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
if (result.status !== 0) {
  process.stdout.write(output);
  console.error(`coverage: the test suite failed (exit ${result.status})`);
  process.exit(result.status ?? 1);
}

// `name | line % | branch % | funcs % | uncovered`. Node 22 prints full
// relative paths (`lib/api.js`); newer versions group by directory and print
// bare basenames. Both shapes map to the same floor entry.
const rows = new Map();
let global = null;
for (const line of output.split(/\r?\n/)) {
  const row = /^\S*\s+([A-Za-z0-9_./\\-]+\.js)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/.exec(line);
  if (row) {
    const name = row[1].split(/[\\/]/).pop();
    rows.set(name, { lines: Number(row[2]), branches: Number(row[3]), functions: Number(row[4]) });
    continue;
  }
  const total = /all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/.exec(line);
  if (total) global = { lines: Number(total[1]), branches: Number(total[2]), functions: Number(total[3]) };
}

const failures = [];
if (!global) {
  failures.push('coverage table is missing the "all files" row');
} else {
  for (const [metric, floor] of Object.entries(GLOBAL)) {
    if (global[metric] < floor) failures.push(`global ${metric} ${global[metric]}% < ${floor}%`);
  }
}
for (const [file, floor] of Object.entries(FLOORS)) {
  const row = rows.get(file);
  if (!row) {
    failures.push(`${file}: not present in the coverage table`);
    continue;
  }
  for (const [metric, minimum] of Object.entries(floor)) {
    if (row[metric] < minimum) failures.push(`${file} ${metric} ${row[metric]}% < ${minimum}%`);
  }
}

if (failures.length > 0) {
  console.error(`coverage gate failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`coverage ok: global lines ${global.lines}% / functions ${global.functions}% / branches ${global.branches}%`);
console.log(`per-file floors met: ${Object.keys(FLOORS).join(', ')}`);
