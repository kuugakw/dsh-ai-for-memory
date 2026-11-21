/**
 * Where local model *configuration* lives.
 *
 * The plugin installation directory is replaced by `install_bundle` on
 * upgrade, so `model.json` (extraArgs, ctxSize, port, binary) must not live
 * there. User-owned config goes under `$DSH_HOME/ai-for-memory/models`; the
 * bundled `models/` directory is only an optional secondary scan source.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dshHome } from './util.js';

/** Stable user-owned model directory: `$DSH_HOME/ai-for-memory/models`. */
export function userModelsDir(env = process.env) {
  return path.join(dshHome(env), 'ai-for-memory', 'models');
}

/** Read-only/example models shipped inside the plugin (may vanish on update). */
export function installModelsDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'models');
}

/**
 * Default scan/start order. A model with the same `分类/文件夹` in both roots
 * resolves from the user directory first.
 */
export function defaultModelRoots(env = process.env) {
  return [userModelsDir(env), installModelsDir()];
}
