#!/usr/bin/env node
/**
 * Metadata consistency checks a normal linter cannot catch.
 *
 * The package version appears in four places the README promises to keep in
 * sync (package.json, the badge, the install command and the "current version"
 * line), plus docs/features.md and CHANGELOG.md. A release that bumps only
 * package.json ships a README that tells users the previous version is current;
 * this script makes that fail fast. Run with `npm run check`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULTS } from '../lib/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const index = JSON.parse(fs.readFileSync(path.join(root, 'market', 'index.json'), 'utf8'));
const plugin = index.plugins?.[0];
const problems = [];
const warnings = [];
const version = manifest.version;

const readText = (file) => fs.readFileSync(path.join(root, file), 'utf8');

if (!plugin) problems.push('market/index.json 没有 plugins[0]');
for (const entry of plugin?.versions ?? []) {
  const engine = entry.engines?.dsh;
  if (engine !== manifest.engines?.dsh) {
    problems.push(`${entry.version} 的 engines.dsh=${JSON.stringify(engine)}，应为 ${JSON.stringify(manifest.engines?.dsh)}`);
  }
}

// Version references that must move together.
const versionChecks = [
  ['README.md', `status-stable%20${version}`, '状态徽章'],
  ['README.md', `version-${version}`, '版本徽章'],
  ['README.md', `dsh-ai-for-memory@${version}`, '安装命令'],
  ['README.md', `当前版本 **${version}**`, '当前版本行'],
  ['docs/features.md', `对应版本：**${version}**`, '功能页对应版本'],
  ['docs/installation.md', `dsh-ai-for-memory@${version}`, '安装文档版本'],
];
for (const [file, needle, label] of versionChecks) {
  if (!readText(file).includes(needle)) problems.push(`${file} 缺少${label}：${needle}`);
}

// The lockfile root version must follow the manifest too; npm ci tolerates a
// stale root version, so without this check it silently drifts for releases.
const lock = JSON.parse(readText('package-lock.json'));
if (lock.version !== version) problems.push(`package-lock.json version=${lock.version}，应为 ${version}`);
if (lock.packages?.['']?.version !== version) {
  problems.push(`package-lock.json packages[""].version=${lock.packages?.['']?.version}，应为 ${version}`);
}

const changelog = readText('CHANGELOG.md');
if (!changelog.includes(`## ${version}（`)) problems.push(`CHANGELOG.md 没有 ${version} 的小节`);

// The bundle patch is the only row DSH mounts for this package. Keep its id,
// name and config keys in step with the manifest/defaults: a stale key is
// silently ignored by the loader and looks like a settings bug in the panel.
const patch = readText('cordis.patch.yml');
if (!patch.includes('- insert:')) problems.push('cordis.patch.yml 缺少 insert 行');
if (!patch.includes(`name: ${manifest.name}`)) problems.push(`cordis.patch.yml 缺少 name: ${manifest.name}`);
const patchKeys = [...patch.matchAll(/^ {8}([A-Za-z0-9_]+):/gm)].map((match) => match[1]);
for (const key of patchKeys) {
  if (!Object.hasOwn(DEFAULTS, key)) problems.push(`cordis.patch.yml 的 config.${key} 不是已知配置项`);
}

// The npm tarball must contain every runtime file the entry points import.
const requiredFiles = ['index.js', 'client.js', 'lib', 'scripts', 'cordis.patch.yml', 'icon.svg', 'locale/*.json', 'docs', 'README.md', 'CHANGELOG.md', 'LICENSE'];
for (const entry of requiredFiles) {
  if (!(manifest.files ?? []).includes(entry)) problems.push(`package.json files 缺少 ${entry}`);
}
if (typeof manifest.engines?.node !== 'string') problems.push('package.json engines.node 缺失');

// The checked-in index can only list published versions: between bumping
// package.json and publishing, the newest entry is legitimately older. The
// market workflow rebuilds the deployed index from npm after publish.
if (plugin?.versions?.[0]?.version !== version) {
  warnings.push(`索引最新版本 ${plugin?.versions?.[0]?.version} 与 package.json ${version} 不一致`
    + '（发布后由 market 工作流重建线上索引；若已发布则说明忘了提交重建结果）');
}

if (problems.length > 0) {
  console.error(`metadata check failed:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
for (const warning of warnings) console.warn(`warning: ${warning}`);
console.log(`metadata ok: ${plugin.versions.length} 个版本，engines.dsh=${manifest.engines?.dsh}，版本引用一致 ${version}`);
