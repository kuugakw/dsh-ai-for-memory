/**
 * Discover user-provided model folders inside the plugin.
 *
 * The plugin does not implement tensor math or download weights. A model folder
 * either declares an OpenAI-compatible local server (llama.cpp, Ollama, LM Studio,
 * vLLM, ...), or contains a GGUF that `lib/local-engine.js` can start with
 * `llama-server`. The panel can then fill the endpoint fields without copying
 * paths or names by hand.
 *
 * Layout:
 *
 *   models/
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
import { fileURLToPath } from 'node:url';

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

/**
 * List categories and models under the plugin's `models/` directory.
 *
 * Categories are intentionally not limited to Embedding/Rerank: a future
 * capability can be added by creating another folder. Known categories are
 * sorted first for a stable panel.
 *
 * @param {string} [modelsRoot]
 * @returns {{root: string, categories: Array<{name: string, models: object[]}>}}
 */
export function listLocalModels(modelsRoot = '') {
  const root = modelsRoot === ''
    ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'models')
    : path.resolve(modelsRoot);
  const empty = { root, categories: [] };
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return empty;
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
      let modelFile = '';
      if (modelPath !== '') {
        modelFile = path.isAbsolute(modelPath) ? modelPath : path.resolve(modelDir, modelPath);
      } else {
        modelFile = findGguf(modelDir);
      }
      const runnable = (engine === '' || engine === 'llama.cpp')
        && (modelFile !== '' || modelPath !== '');
      models.push({
        id: `${category}/${modelEntry.name}`,
        category,
        label,
        folder: modelEntry.name,
        path: path.relative(root, modelDir).split(path.sep).join('/'),
        baseUrl,
        model: modelName,
        configured,
        engine: engine === '' && runnable ? 'llama.cpp' : engine,
        modelPath: modelPath !== '' ? modelPath : (modelFile === '' ? '' : path.basename(modelFile)),
        runnable,
        error: parsed.error ?? '',
        manifest: manifestFile,
      });
    }
    models.sort((left, right) => left.label.localeCompare(right.label));
    categories.push({ name: category, models });
  }

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
  return { root, categories };
}

/** The model categories the plugin currently understands for its own features. */
export const MODEL_CAPABILITIES = KNOWN_CAPABILITIES;
