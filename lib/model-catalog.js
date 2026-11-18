/**
 * Discover user-provided model folders inside the plugin.
 *
 * The plugin deliberately does not run model inference. A model folder is a
 * declaration of an OpenAI-compatible local server (llama.cpp, Ollama, LM Studio,
 * vLLM, ...) plus the model name to send. The panel can then fill the endpoint
 * fields without copying paths or names by hand.
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
      models.push({
        id: `${category}/${modelEntry.name}`,
        category,
        label,
        folder: modelEntry.name,
        path: path.relative(root, modelDir).split(path.sep).join('/'),
        baseUrl,
        model: modelName,
        configured,
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
