#!/usr/bin/env node
/**
 * noImplicitAny debt ratchet.
 *
 * `tsconfig.json` still has `noImplicitAny: false`: turning it on today produces
 * ~1.3k errors, mostly implicit `any` callback parameters. This script counts
 * those errors and fails only when the count grows. Reduce the budget as
 * modules are annotated; never raise it to make a change pass.
 *
 *   npm run typecheck:strict
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET = 1221;

const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--noImplicitAny'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 128 * 1024 * 1024,
});
const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
const errors = output.split(/\r?\n/).filter((line) => /error TS\d+/.test(line));
const byFile = new Map();
for (const line of errors) {
  const match = /^([^(]+)\(/.exec(line);
  if (!match) continue;
  const file = match[1].trim();
  byFile.set(file, (byFile.get(file) ?? 0) + 1);
}

console.log(`noImplicitAny errors: ${errors.length}（budget ${BUDGET}）`);
const top = [...byFile.entries()].sort((left, right) => right[1] - left[1]).slice(0, 6);
for (const [file, count] of top) console.log(`  ${String(count).padStart(4)}  ${file}`);

if (errors.length > BUDGET) {
  console.error(`noImplicitAny grew by ${errors.length - BUDGET}: annotate the new callbacks or lower the change`);
  process.exit(1);
}
if (errors.length < BUDGET) {
  console.warn(`noImplicitAny improved by ${BUDGET - errors.length}: lower BUDGET in scripts/check-implicit-any.mjs`);
}
console.log('noImplicitAny ratchet ok');
