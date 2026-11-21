/**
 * Discover user-provided model folders.
 *
 * The plugin does not implement tensor math or download weights. A model folder
 * either declares an OpenAI-compatible local server (llama.cpp, Ollama, LM Studio,
 * vLLM, ...), or contains a GGUF that `lib/local-engine.js` can start with
 * `llama-server`. The panel can then fill the endpoint fields without copying
 * paths or names by hand.
 *
 * User configuration lives under `$DSH_HOME/ai-for-memory/models`; the plugin's
 * own `models/` is only a secondary scan source (it is replaced on update).
 *
 * Layout:
 *
 *   <user models>/
 *     Embedding/
 *       bge-m3/
 *         model.json
 *     Rerank/
 *       bge-reranker/
 *         model.json
 *     Routing/
 *       my-router/
 *         model.json
 *     <future category>/
 *       ...
 *
 * `model.json` is optional for display, but required before "use this model"
 * can fill an API endpoint. Keys:
 *
 *   {
 *     "name": "bge-m3",
 *     "baseUrl": "http://127.0.0.1:8080",
 *     "model": "bge-m3"
 *   }
 */

import fs from 'node:fs';
import path from 'node:path';

import { localEngineKind } from './local-engine.js';
import { defaultModelRoots } from './model-paths.js';

const KNOWN_CAPABILITIES = Object.freeze(['Embedding', 'Rerank', 'Routing']);

function parseManifest(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'model.json 必须是对象' };
    return { data };
  } catch (error) {
    return { error: `model.json 无法解析：${String(error?.message ?? error)}` };
  }
}

function safeText(value, fallback = '') {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

/** First GGUF inside a model folder; nested folders are checked too. */
function findGguf(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return '';
  }
  const direct = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.gguf'))
    .map((entry) => path.join(dir, entry.name))
    .sort()[0];
  if (direct !== undefined) return direct;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = findGguf(path.join(dir, entry.name));
    if (nested !== '') return nested;
  }
  return '';
}

function scanRoot(root, source) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const categories = [];
  for (const categoryEntry of entries) {
    if (!categoryEntry.isDirectory()) continue;
    const category = categoryEntry.name;
    const categoryDir = path.join(root, category);
    let modelEntries;
    try {
      modelEntries = fs.readdirSync(categoryDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const models = [];
    for (const modelEntry of modelEntries) {
      if (!modelEntry.isDirectory()) continue;
      const modelDir = path.join(categoryDir, modelEntry.name);
      const manifestFile = path.join(modelDir, 'model.json');
      const parsed = fs.existsSync(manifestFile) ? parseManifest(manifestFile) : { data: {} };
      const data = parsed.data ?? {};
      const baseUrl = safeText(data.baseUrl ?? data.url);
      const modelName = safeText(data.model, modelEntry.name);
      const label = safeText(data.name, modelEntry.name);
      const configured = baseUrl !== '' && modelName !== '';
      const engine = safeText(data.engine, '');
      const modelPath = safeText(data.modelPath ?? data.modelFile);
      const kind = localEngineKind(category);
      let modelFile = '';
      if (modelPath !== '') {
        modelFile = path.isAbsolute(modelPath) ? modelPath : path.resolve(modelDir, modelPath);
      } else {
        modelFile = findGguf(modelDir);
      }
      // Only Embedding/Rerank have a plugin-side consumer. Routing and future
      // folders stay visible for discovery, but must never be launched as an
      // embedding server.
      const runnable = kind !== ''
        && (engine === '' || engine === 'llama.cpp')
        && (modelFile !== '' || modelPath !== '');
      const unsupported = kind === '' ? '该分类仅预留，不支持本地引擎' : '';
      models.push({
        id: `${category}/${modelEntry.name}`,
        category,
        label,
        folder: modelEntry.name,
        kind,
        modelsRoot: root,
        source,
        path: path.relative(root, modelDir).split(path.sep).join('/'),
        baseUrl,
        model: modelName,
        configured,
        engine: engine === '' && runnable ? 'llama.cpp' : engine,
        modelPath: modelPath !== '' ? modelPath : (modelFile === '' ? '' : path.basename(modelFile)),
        ctxSize: Number.isInteger(Number(data.ctxSize)) ? Number(data.ctxSize) : 0,
        port: Number.isInteger(Number(data.port)) ? Number(data.port) : 0,
        runnable,
        error: parsed.error ?? unsupported,
        manifest: manifestFile,
      });
    }
    models.sort((left, right) => left.label.localeCompare(right.label));
    categories.push({ name: category, models });
  }
  return categories;
}

/**
 * List categories and models across the user config root and the optional
 * plugin-install root. The same `分类/文件夹` in the user root shadows the
 * install copy; explicit `modelsRoot` keeps the old single-root behaviour.
 *
 * @param {string} [modelsRoot]
 * @returns {{root: string, roots: Array<{dir: string, source: string, exists: boolean}>, categories: Array<{name: string, models: object[]}>}}
 */
export function listLocalModels(modelsRoot = '') {
  const explicit = typeof modelsRoot === 'string' && modelsRoot.trim() !== '';
  const roots = (explicit
    ? [{ dir: path.resolve(modelsRoot), source: 'custom' }]
    : defaultModelRoots().map((dir, index) => ({ dir, source: index === 0 ? 'user' : 'install' })))
    .map((row) => ({ ...row, exists: fs.existsSync(row.dir) }));
  const byCategory = new Map();
  const seen = new Set();
  for (const root of roots) {
    for (const category of scanRoot(root.dir, root.source)) {
      if (!byCategory.has(category.name)) byCategory.set(category.name, []);
      const target = byCategory.get(category.name);
      for (const model of category.models) {
        if (seen.has(model.id)) continue;
        seen.add(model.id);
        target.push(model);
      }
    }
  }
  const categories = [...byCategory.entries()]
    .map(([name, models]) => ({ name, models }));
  categories.sort((left, right) => {
    const leftKnown = KNOWN_CAPABILITIES.indexOf(left.name);
    const rightKnown = KNOWN_CAPABILITIES.indexOf(right.name);
    if (leftKnown !== -1 || rightKnown !== -1) {
      if (leftKnown === -1) return 1;
      if (rightKnown === -1) return -1;
      return leftKnown - rightKnown;
    }
    return left.name.localeCompare(right.name);
  });
  for (const category of categories) {
    category.models.sort((left, right) => left.label.localeCompare(right.label));
  }
  return {
    root: roots[0]?.dir ?? '',
    roots,
    categories,
  };
}

let modelCache = { at: 0, key: '', value: null };

/**
 * Cached {@link listLocalModels}; `/state` is polled by the panel and this
 * filesystem walk must not run on every render. Mirrors `workspaceIndexCached`.
 *
 * @param {string} [modelsRoot]
 * @param {number} [ttlMs]
 */
export function listLocalModelsCached(modelsRoot = '', ttlMs = 5000) {
  const key = typeof modelsRoot === 'string' && modelsRoot.trim() !== ''
    ? path.resolve(modelsRoot)
    : 'default';
  const now = Date.now();
  if (modelCache.key === key && now - modelCache.at < ttlMs) return modelCache.value;
  const value = listLocalModels(modelsRoot);
  modelCache = { at: now, key, value };
  return value;
}

/** Reset the module cache (tests, or after the user adds a model). */
export function resetLocalModelsCache() {
  modelCache = { at: 0, key: '', value: null };
}

/** The model categories the plugin currently understands for display. */
export const MODEL_CAPABILITIES = KNOWN_CAPABILITIES;
