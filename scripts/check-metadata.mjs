#!/usr/bin/env node
/**
 * Cheap metadata checks that a linter would not catch: the checked-in plugin
 * index must agree with this package's manifest. Run with `npm run check`.
 *
 * (The same check belongs in CI; updating .github/workflows requires a token
 * with the `workflow` scope, which the release automation does not have.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const index = JSON.parse(fs.readFileSync(path.join(root, 'market', 'index.json'), 'utf8'));
const plugin = index.plugins?.[0];
const problems = [];

if (!plugin) problems.push('market/index.json 没有 plugins[0]');
for (const entry of plugin?.versions ?? []) {
  const engine = entry.engines?.dsh;
  if (engine !== manifest.engines?.dsh) {
    problems.push(`${entry.version} 的 engines.dsh=${JSON.stringify(engine)}，应为 ${JSON.stringify(manifest.engines?.dsh)}`);
  }
}
if (plugin?.versions?.[0]?.version !== manifest.version) {
  problems.push(`索引最新版本 ${plugin?.versions?.[0]?.version} 与 package.json ${manifest.version} 不一致（发布后忘了重建索引？）`);
}

if (problems.length > 0) {
  console.error(`metadata check failed:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`metadata ok: ${plugin.versions.length} 个版本，engines.dsh=${manifest.engines?.dsh}，最新 ${manifest.version}`);
