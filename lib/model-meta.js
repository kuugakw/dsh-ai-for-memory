/**
 * Metadata for loose GGUF files placed directly in the user models root.
 *
 * A loose file has no model folder to hold `model.json`, so its user-selected
 * kind, ctx-size and port live in one small sidecar. Keeping it out of the
 * GGUF path means moving/renaming a weight file does not rewrite a large file.
 */

import fs from 'node:fs';
import path from 'node:path';

const META_FILE = '.model-meta.json';

function metaFile(root) {
  return path.join(root, META_FILE);
}

export function readLooseMeta(root) {
  const empty = { version: 1, files: {} };
  try {
    const data = JSON.parse(fs.readFileSync(metaFile(root), 'utf8'));
    if (!data || typeof data !== 'object' || typeof data.files !== 'object' || data.files === null) {
      return empty;
    }
    return { version: 1, files: data.files };
  } catch {
    return empty;
  }
}

export function writeLooseMeta(root, filename, patch = {}) {
  const file = path.basename(String(filename ?? ''));
  if (file === '') throw new Error('缺少模型文件名');
  const data = readLooseMeta(root);
  const previous = data.files[file] && typeof data.files[file] === 'object' ? data.files[file] : {};
  data.files[file] = { ...previous, ...patch };
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(metaFile(root), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return data.files[file];
}
