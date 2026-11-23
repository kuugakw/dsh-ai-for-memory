#!/usr/bin/env node
/**
 * Build the plugin index for DSH's experimental "Custom plugin indexes"
 * feature (https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/plugin-market.md).
 *
 * It reads this package's metadata and the public npm registry, then writes
 * market/index.json with every published version that still ships the DSH
 * bundle manifest. Run it after a release, or let .github/workflows/market.yml
 * do it for a v* tag.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const pkg = manifest.name;
const firstVersion = '0.5.1';
const iconPath = path.join(root, 'market', 'icons', 'ai-for-memory.svg');
const registry = 'https://registry.npmjs.org';

function fetchJson(url) {
  return fetch(url, { headers: { 'User-Agent': `dsh-ai-for-memory-index/1` } }).then((res) => {
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
  });
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

async function packument() {
  const urls = [`${registry}/${pkg}`, `https://registry.npmmirror.com/${pkg}`];
  let lastError;
  for (const url of urls) {
    try {
      return await fetchJson(url);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

const data = await packument();
const versions = Object.entries(data.versions || {})
  .filter(([version, meta]) => {
    if (meta.deprecated) return false;
    if (!meta.dsh?.bundle) return false;
    return compareVersions(version, firstVersion) >= 0;
  })
  .sort((a, b) => compareVersions(b[0], a[0]));

if (versions.length === 0) {
  console.error(`no publishable versions of ${pkg} found`);
  process.exit(1);
}

const [latestVersion, latest] = versions[0];
const published = (version) => Math.floor(new Date(data.time?.[version] ?? Date.now()).getTime() / 1000);

const repository = latest.repository ?? manifest.repository;
const repoUrl = typeof repository === 'string' ? repository : repository?.url;

const index = {
  format: 1,
  title: { en: 'AI for Memory', zh: 'AI for Memory 插件索引' },
  description: {
    en: 'Layered project memory for DeepSeek Harness: context cleanup and restore, knowledge search, risk-reviewed decisions, and a Web panel.',
    zh: '面向 DeepSeek Harness 的项目级记忆插件：上下文清理与恢复、知识检索、风险决策审查和 Web 面板。',
  },
  metadata: {
    categories: {
      memory: { title: { en: 'Memory & context', zh: '记忆与上下文' } },
    },
    labels: {
      context: { title: { en: 'Context', zh: '上下文' } },
      repair: { title: { en: 'Data repair', zh: '数据修复' } },
      panel: { title: { en: 'Web panel', zh: '面板' } },
    },
  },
  plugins: [
    {
      name: pkg,
      title: { en: 'AI for Memory', zh: 'AI for Memory' },
      description: {
        en: 'Layered project memory for DSH: six memory layers, context cleanup/restore, BM25/SQL/RAG search, risk-reviewed decisions, and an optional Web panel.',
        zh: '面向 DSH 的六层项目记忆：上下文清理与恢复、BM25/SQL/RAG 检索、风险决策审查、可选 Web 面板。',
      },
      icon: 'icons/ai-for-memory.svg',
      author: typeof latest.author === 'string' ? latest.author : latest.author?.name ?? 'kuugakw',
      homepage: 'https://github.com/kuugakw/dsh-ai-for-memory#readme',
      repository: { url: repoUrl },
      metadata: {
        category: 'memory',
        labels: ['context', 'repair', 'panel'],
      },
      versions: versions.map(([version, meta]) => {
        const entry = {
          version,
          publishTimestamp: published(version),
          source: { type: 'npm' },
        };
        if (meta.engines?.dsh) entry.engines = { dsh: meta.engines.dsh };
        return entry;
      }),
    },
  ],
};

if (!fs.existsSync(iconPath)) {
  fs.mkdirSync(path.dirname(iconPath), { recursive: true });
  fs.copyFileSync(path.join(root, 'icon.svg'), iconPath);
}

fs.writeFileSync(path.join(root, 'market', 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
console.log(`wrote market/index.json for ${pkg}@${latestVersion} with ${index.plugins[0].versions.length} versions`);
