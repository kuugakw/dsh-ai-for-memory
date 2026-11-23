/**
 * Minimal local inference engine.
 *
 * The plugin does not implement transformer math in Node. Instead this module
 * owns the lifecycle of a local llama.cpp server for a model folder under
 * `models/`:
 *
 *   models/Embedding/bge-m3/model.json
 *   models/Embedding/bge-m3/bge-m3-Q8_0.gguf
 *   models/Rerank/bge-reranker-v2-m3/model.json
 *   models/Rerank/bge-reranker-v2-m3/bge-reranker-v2-m3-Q8_0.gguf
 *
 * When asked to start a model it discovers the GGUF file, picks a loopback
 * port, starts `llama-server`, waits for `/health`, and returns the ordinary
 * OpenAI-compatible endpoint. The existing embed/rerank client then speaks to
 * it exactly like any other local service; the engine itself never downloads
 * weights.
 *
 * Nothing is started at import time. A model is only started or stopped by an
 * explicit panel/API request; a plugin reload adopts existing processes so it
 * does not spawn a duplicate, but it never kills them.
 */

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { defaultModelRoots, installModelsDir } from './model-paths.js';
import { inferModelKind } from './model-kind.js';
import { readLooseMeta, writeLooseMeta } from './model-meta.js';

const DEFAULT_MODELS_ROOT = installModelsDir();
const DEFAULT_STARTUP_TIMEOUT_MS = 120000;
const execFileAsync = promisify(execFile);
/** Embedding inputs are small; rerank sends bounded candidates. 8192 KV is waste. */
export const DEFAULT_CTX_SIZE = 2048;
/** Keep enough of llama-server's own diagnostics to explain a failed start. */
const STARTUP_LOG_LIMIT = 32000;
/** Legacy single-file journal; new installs use a directory with one file per model. */
const ENGINE_LOCK_FILE = '.engine.lock';
const ENGINE_LOCK_VERSION = 1;
/** @type {Map<string, EngineProcess>} */
const engines = new Map();
/**
 * Per-model start promise reserved before `freePort()` yields. `engines` has no
 * entry during dynamic port allocation, so two starts used to pass the checks
 * above, both await, and both spawn; the second `engines.set()` orphaned the
 * first live llama-server.
 */
const startLocks = new Map();
// Why a runnable model was not auto-started (usually: a usable configured
// endpoint already serves this kind). Kept module-level so the panel route can
// read it without threading a callback through the lifecycle.
const autoStartSkipNotes = new Map();
/** Start waits for this so a plugin reload cannot race adoption and spawn twice. */
let adoptionPromise = null;

function clean(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function parseManifest(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'model.json 必须是对象' };
    return { data };
  } catch (error) {
    return { error: `model.json 无法解析：${String(error?.message ?? error)}` };
  }
}

/** Find a GGUF file in the model folder (top-level first, then one level down). */
export function findModelFile(modelDir) {
  let entries;
  try {
    entries = fs.readdirSync(modelDir, { withFileTypes: true });
  } catch {
    return '';
  }
  const direct = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.gguf'))
    .map((entry) => path.join(modelDir, entry.name))
    .sort()
    [0];
  if (direct !== undefined) return direct;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = findModelFile(path.join(modelDir, entry.name));
    if (nested !== '') return nested;
  }
  return '';
}

/** Which local-engine runtime a category maps to; empty means unsupported. */
export function localEngineKind(category) {
  const value = String(category ?? '').toLowerCase();
  if (value.includes('rerank')) return 'rerank';
  if (value.includes('embed')) return 'embedding';
  return '';
}

/**
 * Resolve one model folder into everything needed to spawn llama-server.
 *
 * @param {{modelsRoot?: string, modelId: string}} input
 * @returns {{ok: true, model: object} | {ok: false, error: string}}
 */
export function resolveModel(input = {}) {
  const modelId = clean(input.modelId);
  const parts = modelId.split('/');
  if (parts.length !== 2 || parts.some((part) => part === '' || part === '.' || part === '..'
    || part.includes('\\'))) {
    return { ok: false, error: '模型 id 必须是「分类/文件夹」' };
  }
  const [category, folder] = parts;
  const explicitRoot = clean(input.modelsRoot);
  const roots = explicitRoot === '' ? defaultModelRoots() : [path.resolve(explicitRoot)];
  let root = '';
  let modelDir = '';
  let manifestFile = '';
  let data = {};
  let kind = '';
  let modelPath = '';
  let modelName = folder;
  if (category === 'Loose') {
    // A GGUF placed directly under models/ has no folder or model.json. Its
    // type comes from the filename, or from the sidecar the panel wrote when
    // the user explicitly marked it.
    if (folder === '' || folder !== path.basename(folder) || !folder.toLowerCase().endsWith('.gguf')) {
      return { ok: false, error: 'Loose 模型必须直接指向 models/ 下的一个 .gguf 文件' };
    }
    for (const candidate of roots) {
      const file = path.join(candidate, folder);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
      const meta = readLooseMeta(candidate).files?.[folder] ?? {};
      const marked = meta.kind === 'Embedding' || meta.kind === 'Rerank' ? meta.kind : '';
      kind = marked || inferModelKind(folder);
      if (kind === '' && input.allowUnclassified !== true) {
        return {
          ok: false,
          error: `无法从文件名判断 ${folder} 的类型；请在面板标记为 Embedding 或 Rerank，或把它放进 models/Embedding|Rerank 目录`,
        };
      }
      root = candidate;
      modelDir = candidate;
      modelPath = file;
      data = meta;
      modelName = clean(meta.model) || path.basename(folder, path.extname(folder));
      break;
    }
    if (modelPath === '') {
      return { ok: false, error: `models/ 下找不到 ${folder}` };
    }
  } else {
    kind = localEngineKind(category);
    if (kind === '') {
      return {
        ok: false,
        error: `分类 ${category} 不是本地引擎支持的分类；目前只支持 Embedding 和 Rerank，Routing 等预留分类不能启动 llama-server`,
      };
    }
    for (const candidate of roots) {
      const dir = path.join(candidate, category, folder);
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        root = candidate;
        modelDir = dir;
        break;
      }
    }
    if (modelDir === '') {
      return {
        ok: false,
        error: `模型目录不存在：${roots.map((candidate) => path.join(candidate, category, folder)).join(' 或 ')}`,
      };
    }
    manifestFile = path.join(modelDir, 'model.json');
    const parsed = fs.existsSync(manifestFile) ? parseManifest(manifestFile) : { data: {} };
    if (parsed.error) return { ok: false, error: parsed.error };
    data = parsed.data ?? {};
    // A user can mark an existing Embedding folder as Rerank. Honour the
    // explicit `kind` written by updateModelConfig; otherwise the folder name
    // still decides.
    const declaredKind = clean(data.kind).toLowerCase();
    if (declaredKind === 'rerank') kind = 'rerank';
    else if (declaredKind === 'embedding') kind = 'embedding';
    const configuredModel = clean(data.modelPath ?? data.modelFile);
    modelPath = configuredModel === ''
      ? ''
      : (path.isAbsolute(configuredModel) ? configuredModel : path.resolve(modelDir, configuredModel));
    if (modelPath === '' || !fs.existsSync(modelPath)) {
      modelPath = findModelFile(modelDir);
    }
    if (modelPath === '' || !fs.existsSync(modelPath)) {
      return {
        ok: false,
        error: `models/${modelId} 中没有 .gguf 权重；请把 GGUF 放进该文件夹，或在 model.json 写 "modelPath"`,
      };
    }
    modelName = clean(data.model) || folder;
  }

  const configuredBinary = clean(data.binary ?? data.enginePath);
  let binary = configuredBinary;
  if (binary === '') binary = clean(process.env.DSH_LLAMA_SERVER) || clean(process.env.LLAMA_SERVER) || 'llama-server';
  else if (!path.isAbsolute(binary) && /[\\/]/.test(binary)) binary = path.resolve(modelDir, binary);

  return {
    ok: true,
    model: {
      id: `${category}/${folder}`,
      category,
      folder,
      modelsRoot: root,
      kind,
      modelDir,
      manifestFile,
      binary,
      modelPath,
      model: modelName,
      pooling: clean(data.pooling),
      ctxSize: integer(data.ctxSize, DEFAULT_CTX_SIZE),
      port: integer(data.port, 0),
      startupTimeoutMs: integer(data.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS),
      extraArgs: Array.isArray(data.extraArgs)
        ? data.extraArgs.filter((value) => typeof value === 'string' && value.trim() !== '').map((value) => value.trim())
        : [],
      data,
    },
  };
}

/**
 * Persist the small per-model launch knobs the panel is allowed to edit.
 * The running child is not touched; the UI asks the user to restart it.
 */
export function updateModelConfig(input = {}) {
  const resolved = resolveModel({ modelsRoot: input.modelsRoot, modelId: input.modelId, allowUnclassified: true });
  if (!resolved.ok) return resolved;
  const model = resolved.model;
  const data = { ...(model.data ?? {}) };
  if (input.kind !== undefined) {
    const kind = String(input.kind ?? '').trim();
    if (kind === '') delete data.kind;
    else if (kind !== 'Embedding' && kind !== 'Rerank') {
      return { ok: false, error: 'kind 必须是 Embedding、Rerank，或留空使用目录/文件名推断' };
    } else {
      data.kind = kind;
    }
  }
  if (input.modelPath !== undefined) {
    const value = String(input.modelPath ?? '').trim();
    if (value.length > 1000) return { ok: false, error: 'modelPath 路径过长' };
    if (model.category === 'Loose') {
      if (value !== '' && value !== model.folder) {
        return { ok: false, error: 'Loose 模型的权重文件就是根目录下的 GGUF 文件，不能另行指定 modelPath' };
      }
    } else if (value === '') {
      delete data.modelPath;
      delete data.modelFile;
    } else {
      const candidate = path.isAbsolute(value) ? path.resolve(value) : path.resolve(model.modelDir, value);
      let stat = null;
      try { stat = fs.statSync(candidate); } catch { stat = null; }
      if (!stat?.isFile()) {
        return { ok: false, error: `modelPath 指向的文件不存在：${candidate}` };
      }
      data.modelPath = value;
      delete data.modelFile;
    }
  }
  if (input.ctxSize !== undefined) {
    const value = integer(input.ctxSize, 0);
    if (value < 256 || value > 131072) {
      return { ok: false, error: 'ctxSize 必须是 256~131072 的整数' };
    }
    data.ctxSize = value;
  }
  if (input.port !== undefined) {
    const value = integer(input.port, -1);
    if (value < 0 || value > 65535) return { ok: false, error: 'port 必须是 0~65535 的整数' };
    data.port = value;
  }
  if (input.pooling !== undefined) {
    const value = String(input.pooling ?? '').trim();
    if (value !== '' && !['cls', 'mean', 'last', 'none', 'rank'].includes(value)) {
      return { ok: false, error: 'pooling 必须是 cls / mean / last / none / rank，或留空' };
    }
    if (value === '') delete data.pooling;
    else data.pooling = value;
  }
  if (input.startupTimeoutMs !== undefined) {
    const value = integer(input.startupTimeoutMs, 0);
    if (value < 1000 || value > 600000) {
      return { ok: false, error: 'startupTimeoutMs 必须是 1000~600000 的整数' };
    }
    data.startupTimeoutMs = value;
  }
  if (input.binary !== undefined) {
    const value = String(input.binary ?? '').trim();
    if (value.length > 1000) return { ok: false, error: 'binary 路径过长' };
    if (value === '') delete data.binary;
    else data.binary = value;
  }
  if (input.extraArgs !== undefined) {
    const values = (Array.isArray(input.extraArgs) ? input.extraArgs : [])
      .map((value) => String(value ?? '').trim()).filter((value) => value !== '');
    if (values.length > 40 || values.some((value) => value.length > 500)) {
      return { ok: false, error: 'extraArgs 最多 40 项，每项不超过 500 字符' };
    }
    data.extraArgs = values;
  }
  try {
    if (model.category === 'Loose') {
      writeLooseMeta(model.modelsRoot, model.folder, data);
    } else {
      fs.writeFileSync(
        path.join(model.modelDir, 'model.json'),
        `${JSON.stringify(data, null, 2)}\n`,
        'utf8',
      );
    }
  } catch (error) {
    return { ok: false, error: `写入模型配置失败：${String(error?.message ?? error)}` };
  }
  return {
    ok: true,
    model: model.id,
    kind: data.kind || (model.category === 'Loose'
      ? inferModelKind(model.folder)
      : localEngineKind(model.category)),
    modelPath: clean(data.modelPath) || model.modelPath,
    ctxSize: integer(data.ctxSize, DEFAULT_CTX_SIZE),
    port: integer(data.port, 0),
    pooling: clean(data.pooling),
    startupTimeoutMs: integer(data.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS),
    binary: clean(data.binary),
    extraArgs: Array.isArray(data.extraArgs) ? data.extraArgs : [],
  };
}

/** Arguments used by llama-server; exported so tests can inspect them without spawning. */export function buildServerArgs(model, port) {
  const args = [
    '-m', model.modelPath,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--ctx-size', String(model.ctxSize || DEFAULT_CTX_SIZE),
  ];
  if (String(model.kind).toLowerCase() === 'rerank') {
    args.push('--reranking');
    // Rerankers need the rank pooling head, not the embedding folder's stale
    // `cls` value. Without rank, llama.cpp produces near-zero logits.
    args.push('--pooling', 'rank');
  } else {
    args.push('--embeddings');
    args.push('--pooling', model.pooling || 'cls');
  }
  args.push(...model.extraArgs);
  return args;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('无法分配本地端口'))));
    });
  });
}

/** Cheap change detector for model.json and the weight file. */
function fileFingerprint(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? `${stat.mtimeMs}:${stat.size}` : '';
  } catch {
    return '';
  }
}

function modelFingerprint(model) {
  return {
    manifest: fileFingerprint(model.manifestFile),
    weights: fileFingerprint(model.modelPath),
    modelPath: model.modelPath,
    model: model.model,
    kind: model.kind,
    binary: model.binary,
    pooling: model.pooling,
    ctxSize: model.ctxSize,
    extraArgs: Array.isArray(model.extraArgs) ? model.extraArgs : [],
  };
}

function sameFingerprint(left, right) {
  if (!left || !right) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function staleEngineResult(state) {
  state.stale = true;
  return {
    ok: false,
    stale: true,
    error: '模型配置已变更（model.json 或 GGUF 的 mtime/size 不一致）；请先停止当前引擎，再重新启动以应用新配置',
    engine: { ...engineStatus(state), stale: true },
  };
}

function engineLockPath(modelsRoot) {
  return path.join(path.resolve(modelsRoot || DEFAULT_MODELS_ROOT), ENGINE_LOCK_FILE);
}

function validLockRow(row) {
  return row && typeof row === 'object'
    && typeof row.id === 'string' && row.id !== ''
    && Number.isInteger(row.port) && row.port > 0
    && typeof row.modelPath === 'string' && row.modelPath !== '';
}

function parseLockRows(data) {
  const rows = Array.isArray(data) ? data : data?.engines;
  return Array.isArray(rows) ? rows.filter(validLockRow) : [];
}

function readLegacyLock(file) {
  try {
    return parseLockRows(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return [];
  }
}

/** One stable file per model id, so different models never overwrite each other. */
function lockFileName(id) {
  const digest = createHash('sha256').update(String(id)).digest('hex').slice(0, 24);
  return `${digest}.json`;
}

function writeLockFile(dir, row) {
  const file = path.join(dir, lockFileName(row.id));
  const payload = {
    version: ENGINE_LOCK_VERSION,
    updatedAt: new Date().toISOString(),
    engine: row,
  };
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    try {
      fs.renameSync(temp, file);
    } catch {
      fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      fs.rmSync(temp, { force: true });
    }
  } catch {
    // A read-only models directory must not prevent the engine from starting.
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * Turn the old single-file journal into the per-model directory exactly once.
 *
 * The old file is renamed aside before the directory is created; a crashed
 * migration therefore leaves the complete old journal in the backup path
 * instead of deleting it. Concurrent migrators fall back to the directory the
 * winner created.
 */
function ensureEngineLockDir(modelsRoot) {
  const dir = engineLockPath(modelsRoot);
  let stat = null;
  try { stat = fs.lstatSync(dir); } catch { stat = null; }
  if (stat?.isDirectory()) return dir;
  if (stat?.isFile()) {
    const rows = readLegacyLock(dir);
    const backup = `${dir}.legacy-${process.pid}-${Date.now()}`;
    try {
      fs.renameSync(dir, backup);
    } catch {
      // Another process may have already renamed the legacy file. Do not return
      // null here: creating the directory and writing our own row must still
      // work while that migration is in progress.
      try {
        if (fs.lstatSync(dir).isDirectory()) return dir;
      } catch { /* the path is currently between file and directory */ }
      try {
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      } catch {
        return null;
      }
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      for (const row of rows) writeLockFile(dir, row);
      fs.rmSync(backup, { force: true });
      return dir;
    } catch {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.renameSync(backup, dir);
      } catch { /* keep the backup if even the restore fails */ }
      return null;
    }
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

/**
 * Read the per-model startup journal. Legacy single-file journals are accepted
 * read-only and migrated lazily by the next save/remove.
 */
function readEngineLock(modelsRoot) {
  const dir = engineLockPath(modelsRoot);
  const byId = new Map();
  let stat = null;
  try { stat = fs.lstatSync(dir); } catch { stat = null; }
  if (stat?.isFile()) {
    for (const row of readLegacyLock(dir)) byId.set(row.id, row);
    return [...byId.values()];
  }
  if (!stat?.isDirectory()) return [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        const row = validLockRow(data?.engine) ? data.engine : data;
        if (validLockRow(row)) byId.set(row.id, row);
      } catch {
        // A single malformed entry must not hide the other models.
      }
    }
  } catch {
    // An unreadable directory is equivalent to no journal.
  }
  return [...byId.values()];
}

function lockRow(state) {
  return {
    id: state.id,
    kind: state.kind,
    pid: state.child?.pid ?? state.pid ?? null,
    port: state.port,
    model: state.model.model,
    modelPath: state.model.modelPath,
    baseUrl: state.baseUrl,
    command: state.command,
    startedAt: state.startedAt,
    fingerprint: state.fingerprint ?? null,
    ready: state.ready === true,
  };
}

function saveEngineLock(state) {
  const dir = ensureEngineLockDir(state.model.modelsRoot);
  if (dir === null) return;
  writeLockFile(dir, lockRow(state));
}

function readLockRow(dir, id) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, lockFileName(id)), 'utf8'));
    const row = validLockRow(data?.engine) ? data.engine : data;
    return validLockRow(row) ? row : null;
  } catch {
    return null;
  }
}

function sameLockIdentity(left, right) {
  if (!left || !right) return false;
  return left.id === right.id
    && left.pid === right.pid
    && left.port === right.port
    && left.modelPath === right.modelPath
    && left.startedAt === right.startedAt;
}

function removeEngineLock(stateOrRoot, id, expected) {
  const root = typeof stateOrRoot === 'string' ? stateOrRoot : stateOrRoot?.model?.modelsRoot;
  const key = typeof stateOrRoot === 'string' ? id : stateOrRoot?.id;
  if (!root || !key) return;
  const dir = ensureEngineLockDir(root);
  if (dir === null) return;
  const wanted = expected ?? (typeof stateOrRoot === 'object' ? lockRow(stateOrRoot) : null);
  // Conditional delete: another DSH process may have replaced this model's
  // lock with a newer process while we were probing/stopping the old one.
  if (wanted !== null) {
    const current = readLockRow(dir, key);
    if (!sameLockIdentity(current, wanted)) return;
  }
  try { fs.rmSync(path.join(dir, lockFileName(key)), { force: true }); } catch { /* best effort */ }
}

function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left === '' || right === '') return false;
  let a = left;
  let b = right;
  try { a = fs.realpathSync(a); } catch { /* keep the configured path */ }
  try { b = fs.realpathSync(b); } catch { /* keep the configured path */ }
  const normalize = (value) => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
  return normalize(a) === normalize(b);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error?.code === 'EPERM';
  }
}

function modelNamesFromProps(data) {
  if (!data || typeof data !== 'object') return [];
  return [
    data.model_path,
    data.model_name,
    data.model,
    data.default_generation_settings?.model,
    data.default_generation_settings?.model_path,
  ].filter((value) => typeof value === 'string' && value.trim() !== '');
}

/** Probe a lock entry; only a health + model match is adopted. */
async function probeLockedEngine(row) {
  if (row.pid !== null && row.pid !== undefined && !pidAlive(row.pid)) return { ok: false, reason: 'process-dead' };
  const base = `http://127.0.0.1:${row.port}`;
  try {
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
    if (!health.ok) return { ok: false, reason: `health-http-${health.status}` };
  } catch (error) {
    return { ok: false, reason: `health-${String(error?.message ?? error)}` };
  }
  const names = [];
  try {
    const props = await fetch(`${base}/props`, { signal: AbortSignal.timeout(2000) });
    if (props.ok) names.push(...modelNamesFromProps(await props.json()));
  } catch {
    // Older builds may not expose /props; /v1/models below is the fallback.
  }
  try {
    const listed = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(2000) });
    if (listed.ok) {
      const body = await listed.json();
      for (const item of Array.isArray(body?.data) ? body.data : []) {
        if (typeof item?.id === 'string') names.push(item.id);
      }
    }
  } catch {
    // No model catalog either.
  }
  const expected = [row.model, row.modelPath, path.basename(row.modelPath || '')].filter(Boolean);
  const matched = names.some((name) => expected.some((want) => want === name
    || path.basename(name) === want
    || samePath(name, row.modelPath)));
  if (!matched) return { ok: false, reason: 'model-mismatch' };
  return { ok: true, names };
}

/** Split a command line (quoted paths included) into arguments. */
function splitCommandLine(commandLine) {
  const args = [];
  let current = '';
  let quote = '';
  for (let index = 0; index < commandLine.length; index += 1) {
    const char = commandLine[index];
    if (quote !== '') {
      if (char === quote) {
        quote = '';
      } else if (char === '\\' && quote === '"'
        && (commandLine[index + 1] === '"' || commandLine[index + 1] === '\\')) {
        current += commandLine[index + 1];
        index += 1;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current !== '') {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current !== '') args.push(current);
  return args;
}

/**
 * Parse the command line of a llama-server process.
 *
 * @param {string} commandLine
 * @returns {{modelPath: string, port: number, args: string[]} | null}
 */
export function parseLlamaServerCommandLine(commandLine) {
  const args = splitCommandLine(String(commandLine ?? ''));
  const executable = (args[0] ?? '').split(/[\\/]/).pop().toLowerCase();
  if (!executable.startsWith('llama-server')) return null;
  let modelPath = '';
  let port = 0;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-m' || arg === '--model') {
      modelPath = args[index + 1] ?? '';
      index += 1;
    } else if (arg.startsWith('--model=')) {
      modelPath = arg.slice('--model='.length);
    } else if (arg === '--port') {
      port = Number(args[index + 1]);
      index += 1;
    } else if (arg.startsWith('--port=')) {
      port = Number(arg.slice('--port='.length));
    }
  }
  if (modelPath === '' || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { modelPath, port, args };
}

/** Windows needs command-line details that tasklist cannot provide. */
function powershellExecutable() {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const bundled = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(bundled) ? bundled : 'powershell.exe';
}

/** Enumerate llama-server processes; a failed enumeration is just an empty list. */
async function listLlamaServerProcesses() {
  try {
    if (process.platform === 'win32') {
      const script = "Get-CimInstance Win32_Process -Filter \"Name LIKE 'llama-server%'\" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
      const { stdout } = await execFileAsync(powershellExecutable(), [
        '-NoProfile', '-NonInteractive', '-Command', script,
      ], { windowsHide: true, timeout: 6000, maxBuffer: 1024 * 1024 });
      const parsed = JSON.parse(stdout || '[]');
      return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
        pid: Number(row?.ProcessId),
        ppid: Number(row?.ParentProcessId),
        commandLine: String(row?.CommandLine ?? ''),
      })).filter((row) => Number.isInteger(row.pid) && row.pid > 0 && row.commandLine !== '');
    }
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,args='], {
      timeout: 6000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.split(/\r?\n/).map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      return match ? { pid: Number(match[1]), ppid: Number(match[2]), commandLine: match[3] } : null;
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * A PID is not an identity: Windows and Unix can recycle it. Before an adopted
 * process may be signalled, prove that it is still the llama-server for this
 * model and port rather than whatever process inherited the old PID.
 */
async function processBelongsToState(state) {
  const pid = Number.isInteger(state?.pid) ? state.pid : 0;
  if (pid <= 0) return false;
  const rows = await listLlamaServerProcesses();
  const row = rows.find((candidate) => candidate.pid === pid);
  if (!row) return false;
  const parsed = parseLlamaServerCommandLine(row.commandLine);
  if (!parsed) return false;
  const expectedPath = state.model?.modelPath;
  if (!expectedPath || !samePath(parsed.modelPath, expectedPath)) return false;
  return parsed.port === state.port;
}

/**
 * A custom binary may not appear in the OS process table (our Windows query
 * only matches names beginning with llama-server), but a healthy engine with
 * the exact model on the recorded port is still safe to stop.
 */
async function isVerifiedEngineProcess(state) {
  if (await processBelongsToState(state)) return true;
  try {
    return (await probeLockedEngine(lockRow(state))).ok;
  } catch {
    return false;
  }
}

/** Map an absolute model path back to `category/folder` (or `Loose/file.gguf`). */
function modelIdFromPath(modelsRoot, modelPath) {
  const relative = path.relative(path.resolve(modelsRoot), path.resolve(modelPath));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const parts = relative.split(path.sep).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return { id: `Loose/${parts[0]}`, category: 'Loose' };
  return { id: `${parts[0]}/${parts[1]}`, category: parts[0] };
}

/**
 * Recover plugin-owned llama-server processes whose lock file was lost (for
 * example by an older plugin build that deleted it after a failed health probe).
 * Only processes whose model lives under this models root are considered.
 */
async function discoverLiveEngines(modelsRoot) {
  const root = path.resolve(modelsRoot || DEFAULT_MODELS_ROOT);
  const rows = await listLlamaServerProcesses();
  for (const row of rows) {
    const parsed = parseLlamaServerCommandLine(row.commandLine);
    if (!parsed) continue;
    const info = modelIdFromPath(root, parsed.modelPath);
    if (!info) continue;
    const known = engines.get(info.id);
    if (known && (known.ready === true || (Number.isInteger(known.pid) && pidAlive(known.pid)))) continue;
    const modelPath = path.resolve(parsed.modelPath);
    const resolved = resolveModel({ modelsRoot: root, modelId: info.id });
    const folder = info.id.split('/')[1] ?? '';
    const model = resolved.ok ? resolved.model : {
      id: info.id,
      category: info.category,
      folder,
      modelsRoot: root,
      kind: localEngineKind(info.category),
      modelDir: path.dirname(modelPath),
      manifestFile: '',
      binary: '',
      modelPath,
      model: path.basename(modelPath, path.extname(modelPath)),
      pooling: '',
      ctxSize: 0,
      extraArgs: [],
      data: {},
    };
    if (!samePath(model.modelPath, modelPath)) {
      model.modelPath = modelPath;
      model.model = path.basename(modelPath, path.extname(modelPath));
      model.modelDir = path.dirname(modelPath);
    }
    const lock = {
      id: info.id,
      kind: model.kind,
      pid: row.pid,
      port: parsed.port,
      model: model.model,
      modelPath,
      baseUrl: `http://127.0.0.1:${parsed.port}`,
      command: row.commandLine,
      startedAt: '',
    };
    const probe = await probeLockedEngine(lock);
    const state = {
      id: info.id,
      kind: model.kind,
      model,
      port: parsed.port,
      baseUrl: lock.baseUrl,
      command: row.commandLine,
      child: null,
      pid: row.pid,
      adopted: true,
      fingerprint: modelFingerprint(model),
      stale: false,
      ready: probe.ok,
      starting: false,
      exited: false,
      error: probe.ok ? '' : `llama-server 进程仍在运行（pid=${row.pid}），但接管探测失败：${probe.reason}；请先停止该进程。`,
      stdout: '',
      stderr: '',
      exitCode: null,
      exitSignal: null,
      startedAt: '',
      started: null,
    };
    engines.set(state.id, state);
    saveEngineLock(state);
  }
}

async function adoptLockedEngines(modelsRoot, options = {}) {
  const root = path.resolve(modelsRoot || DEFAULT_MODELS_ROOT);
  const rows = readEngineLock(root);
  for (const row of rows) {
    const already = engines.get(row.id);
    if (already?.ready === true) {
      // Repeated adoption (or the user root winning over the install root)
      // keeps the existing lock entry instead of dropping it.
      if (samePath(already.model.modelsRoot, root)) saveEngineLock(already);
      continue;
    }
    const resolved = resolveModel({ modelsRoot: root, modelId: row.id });
    const category = row.id.split('/')[0];
    const folder = row.id.split('/')[1] ?? '';
    // A model.json edit may point at a new GGUF while the old process still
    // serves the previous one. Keep the old path so the process can be adopted
    // (and stopped/reclaimed); the start call will report stale.
    const model = resolved.ok ? resolved.model : {
      id: row.id,
      category,
      folder,
      modelsRoot: root,
      kind: row.kind || localEngineKind(category),
      modelDir: path.dirname(row.modelPath),
      manifestFile: '',
      binary: '',
      modelPath: row.modelPath,
      model: row.model,
      pooling: '',
      ctxSize: 0,
      extraArgs: [],
      data: {},
    };
    const pathMatches = samePath(model.modelPath, row.modelPath);
    if (!pathMatches) {
      model.modelPath = row.modelPath;
      model.model = row.model;
      model.modelDir = path.dirname(row.modelPath);
    }
    const currentFingerprint = modelFingerprint(model);
    const state = {
      id: model.id,
      kind: model.kind,
      model,
      port: row.port,
      baseUrl: `http://127.0.0.1:${row.port}`,
      command: row.command || commandLine(model, row.port),
      child: null,
      pid: row.pid ?? null,
      adopted: true,
      // Keep the fingerprint from the process's original start. A changed
      // model.json/GGUF makes the first start call report stale.
      fingerprint: row.fingerprint ?? currentFingerprint,
      stale: !pathMatches || (row.fingerprint ? !sameFingerprint(row.fingerprint, currentFingerprint) : false),
      ready: false,
      starting: false,
      exited: false,
      error: '',
      stdout: '',
      stderr: '',
      exitCode: null,
      exitSignal: null,
      startedAt: row.startedAt || '',
      started: null,
    };
    const probe = await probeLockedEngine(row);
    if (!probe.ok) {
      // A failed probe is not proof that the process is gone. A slow model
      // load, a transient /health error or a model-name mismatch used to delete
      // the lock, orphaning a live 1.5 GB server with no UI entry. Keep the
      // journal only when the PID still points at this model's llama-server;
      // a recycled PID must not become a stoppable entry in the panel.
      if (!Number.isInteger(row.pid) || !pidAlive(row.pid)
        || !(await processBelongsToState(state))) {
        removeEngineLock(root, row.id, row);
        continue;
      }
      state.error = `llama-server 进程仍在运行（pid=${row.pid}），但接管探测失败：${probe.reason}；请先停止该进程。`;
      engines.set(state.id, state);
      saveEngineLock(state);
      continue;
    }
    state.ready = true;
    engines.set(state.id, state);
    saveEngineLock(state);
  }
  if (options.scanProcesses === true) await discoverLiveEngines(root);
  return [...engines.values()].map(engineStatus);
}

/**
 * Adopt llama-server processes left by a previous plugin process (crash,
 * kill -9, DSH restart). Must run before the panel can start a new engine.
 */
export function restoreLocalEngines(input = {}) {
  const explicitRoot = clean(input.modelsRoot);
  const scanProcesses = input.scanProcesses === true;
  const roots = explicitRoot === '' ? defaultModelRoots() : [path.resolve(explicitRoot)];
  const run = async () => {
    const merged = new Map();
    for (const root of roots) {
      const rows = await adoptLockedEngines(root, { scanProcesses });
      for (const row of rows) {
        // User root wins when the same model id exists in both roots.
        if (!merged.has(row.id)) merged.set(row.id, row);
      }
    }
    return [...merged.values()];
  };
  const previous = adoptionPromise ?? Promise.resolve();
  const next = previous.then(run, run);
  adoptionPromise = next;
  return next.finally(() => {
    if (adoptionPromise === next) adoptionPromise = null;
  });
}

/** The panel state wait: an adopted engine must be counted before it renders. */
export async function waitForLocalAdoption() {
  if (adoptionPromise) await adoptionPromise;
}

/** Keep only the tail; llama-server startup logs are the useful part. */
function appendLog(state, channel, chunk) {
  const previous = state[channel] ?? '';
  const next = previous + String(chunk).replace(/\r\n/g, '\n');
  state[channel] = next.length > STARTUP_LOG_LIMIT ? next.slice(-STARTUP_LOG_LIMIT) : next;
}

/** The most useful tail: stderr when present, otherwise stdout. */
function startupLog(state, limit = 6000) {
  const text = (state.stderr || '').trim() || (state.stdout || '').trim();
  return text.length > limit ? text.slice(-limit) : text;
}

function quoteArg(value) {
  const text = String(value);
  return /[\s"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function commandLine(model, port) {
  return [model.binary, ...buildServerArgs(model, port)].map(quoteArg).join(' ');
}

/** Turn the common llama-server stderr failures into actionable hints. */
function startupHints(log) {
  const text = String(log ?? '');
  const hints = [];
  if (/unknown argument[^\n]*--reranking|unrecognized[^\n]*--reranking|--reranking[^\n]*(not found|unknown)/i.test(text)) {
    hints.push('当前 llama-server 不认识 --reranking：换用支持 rerank 的新版 build，或给 Rerank 配一个已经支持 /v1/rerank 的服务。');
  }
  if (/--pooling|pooling[^\n]*(unknown|invalid|not supported)/i.test(text)) {
    hints.push('--pooling 参数与当前 llama-server 不匹配：升级/更换 build，或在 model.json 里改 pooling，或把该项放进 extraArgs 手动覆盖。');
  }
  if (/GGUF[^\n]*(version|metadata)|unsupported[^\n]*GGUF|unknown model architecture|failed to load model|invalid model/i.test(text)) {
    hints.push('GGUF 元数据/架构与当前 llama-server 不匹配：换用能读该 GGUF 的 build，或改用与该 build 匹配的量化文件。');
  }
  if (/out of memory|OOM|failed to allocate|CUDA error|ggml_backend[^\n]*(alloc|buffer)/i.test(text)) {
    hints.push('显存/内存不足：降低 ctx-size、换更小的量化，或关闭其他占用显存的进程。');
  }
  if (/(No such file or directory|cannot open|failed to open|not found)/i.test(text)) {
    hints.push('路径或可执行文件找不到：检查 model.json 的 modelPath/binary，以及含中文或空格的路径是否能被当前 build 正常读取。');
  }
  if (/invalid argument|unrecognized argument|unknown argument/i.test(text) && hints.length === 0) {
    hints.push('llama-server 拒绝了启动参数：对照上面的 stderr 和下方命令，删除/改写不兼容的参数。');
  }
  if (text.trim() === '') {
    hints.push('子进程没有输出：确认 binary 可执行、架构匹配，并尝试在终端直接运行下方命令。');
  }
  return hints;
}

/** Build the error text shown in the panel, including the child's own stderr. */
function startFailure(state, headline) {
  const log = startupLog(state);
  const parts = [headline];
  if (state.stderr?.trim()) parts.push(`stderr:\n${log}`);
  else if (state.stdout?.trim()) parts.push(`stdout:\n${log}`);
  else parts.push('llama-server 没有输出任何 stdout/stderr。');
  const hints = startupHints(log);
  if (hints.length > 0) parts.push(`可能原因：\n- ${hints.join('\n- ')}`);
  parts.push(`命令：${state.command}`);
  return parts.join('\n\n');
}

async function waitForHealth(port, timeoutMs, state) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (state.exited === true) {
      throw new Error(state.error || startFailure(
        state,
        `llama-server 启动后退出（code=${state.exitCode ?? '-'}, signal=${state.exitSignal ?? '-'}）`,
      ));
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error?.message ?? error);
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(startFailure(
    state,
    `llama-server 启动超时（${Math.round(timeoutMs / 1000)}s）：${lastError || '没有响应'}`,
  ));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(100);
  }
  return !pidAlive(pid);
}

/**
 * Stop one process and report whether the PID is no longer our engine.
 *
 * A PID can be recycled between DSH runs. For adopted processes, verify the
 * command line (or the live health + model match) before sending a signal; an
 * unverified PID is treated as a stale lock, never as a kill target.
 *
 * @returns {Promise<{gone: boolean, killed: boolean, reason: string}>}
 */
async function stopProcess(state) {
  if (!state) return { gone: true, killed: false, reason: 'no-state' };
  const child = state.child;
  const pid = child?.pid ?? state.pid;
  if (!Number.isInteger(pid) || pid <= 0) return { gone: true, killed: false, reason: 'no-pid' };
  if (child && (child.exitCode !== null || child.signalCode !== null)) {
    return { gone: true, killed: false, reason: 'already-gone' };
  }
  if (!pidAlive(pid)) return { gone: true, killed: false, reason: 'already-gone' };
  if (!child && !(await isVerifiedEngineProcess(state))) {
    // The lock is stale, but the PID now belongs to something else. Do not
    // signal it; the caller removes the lock as part of the stale cleanup.
    return { gone: true, killed: false, reason: 'not-our-process' };
  }

  const signal = (name) => {
    try {
      if (child && child.exitCode === null && child.signalCode === null) child.kill(name);
      else process.kill(pid, name);
    } catch {
      // The process may have exited between the liveness check and the signal.
    }
  };

  signal('SIGTERM');
  if (await waitForPidExit(pid, 1500)) return { gone: true, killed: true, reason: 'stopped' };
  // SIGKILL is only sent after the identity check above. The PID could be
  // recycled in this tiny window; waiting on the same PID is unavoidable here.
  signal('SIGKILL');
  return (await waitForPidExit(pid, 3000))
    ? { gone: true, killed: true, reason: 'stopped' }
    : { gone: false, killed: true, reason: 'still-running' };
}

/** Stop, then update the journal according to whether the target is gone. */
async function stopAndUpdateLock(state) {
  const result = await stopProcess(state);
  if (result.gone) removeEngineLock(state);
  else saveEngineLock(state);
  return result;
}

/**
 * Start (or reuse) the llama.cpp server for one model.
 *
 * @param {{modelsRoot?: string, modelId: string}} input
 * @returns {Promise<{ok: true, endpoint: object, engine: object} | {ok: false, error: string}>}
 */
export async function startLocalEngine(input = {}) {
  // Adoption must finish before the existing-engine check; otherwise a quick
  // click after plugin reload can spawn a second server beside the survivor.
  if (adoptionPromise) await adoptionPromise;
  const resolved = resolveModel(input);
  if (!resolved.ok) {
    const known = engines.get(clean(input.modelId));
    if (known?.ready === true) return staleEngineResult(known);
    return resolved;
  }
  const model = resolved.model;
  const existing = engines.get(model.id);
  if (existing?.ready === true) {
    const current = modelFingerprint(model);
    if (existing.fingerprint && !sameFingerprint(existing.fingerprint, current)) {
      return staleEngineResult(existing);
    }
    if (!existing.fingerprint) existing.fingerprint = current;
    existing.stale = false;
    return {
      ok: true,
      engine: engineStatus(existing),
      // Use the model that the running process was started with. On a clean
      // match this equals `model.model`; on stale config we never get here.
      endpoint: { baseUrl: existing.baseUrl, model: existing.model.model },
    };
  }
  if (existing?.starting === true) {
    await existing.started;
    if (existing.cancelled === true) {
      return { ok: false, cancelled: true, error: '启动已取消', engine: engineStatus(existing) };
    }
    if (existing.ready === true) {
      const current = modelFingerprint(model);
      if (existing.fingerprint && !sameFingerprint(existing.fingerprint, current)) {
        return staleEngineResult(existing);
      }
      if (!existing.fingerprint) existing.fingerprint = current;
      existing.stale = false;
      return {
        ok: true,
        engine: engineStatus(existing),
        endpoint: { baseUrl: existing.baseUrl, model: existing.model.model },
      };
    }
    return { ok: false, error: existing.error || 'llama-server 未就绪', engine: engineStatus(existing) };
  }
  // An adopted process that is alive but failed its probe must be stopped
  // explicitly. Before refusing, probe once more: the port may have become
  // healthy since the panel loaded (a slow model load is the common case).
  if (existing && Number.isInteger(existing.pid) && pidAlive(existing.pid)) {
    const probe = await probeLockedEngine(lockRow(existing));
    if (probe.ok) {
      const current = modelFingerprint(model);
      if (existing.fingerprint && !sameFingerprint(existing.fingerprint, current)) {
        return staleEngineResult(existing);
      }
      existing.ready = true;
      existing.error = '';
      existing.stale = false;
      saveEngineLock(existing);
      return {
        ok: true,
        engine: engineStatus(existing),
        endpoint: { baseUrl: existing.baseUrl, model: existing.model.model },
      };
    }
    return {
      ok: false,
      error: existing.error || `llama-server 进程仍在运行（pid=${existing.pid}），但健康检查未通过；请先停止。`,
      engine: engineStatus(existing),
    };
  }

  // Reserve synchronously before the first await. The existing engine entry is
  // only created after freePort() resolves, which is exactly the window two
  // concurrent starts could both enter.
  const inflight = startLocks.get(model.id);
  if (inflight) return inflight;
  const launch = launchLocalEngine(model);
  startLocks.set(model.id, launch);
  try {
    return await launch;
  } finally {
    if (startLocks.get(model.id) === launch) startLocks.delete(model.id);
  }
}

/** Spawn one model. The caller already holds the per-model start lock. */
async function launchLocalEngine(model) {
  const configuredPort = model.port;
  let lastEngine = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = configuredPort || await freePort().catch(() => 0);
    if (!port) return { ok: false, error: '无法分配本地端口' };
    const state = {
      id: model.id,
      kind: model.kind,
      model,
      port,
      baseUrl: `http://127.0.0.1:${port}`,
      command: commandLine(model, port),
      child: null,
      pid: null,
      adopted: false,
      stale: false,
      fingerprint: modelFingerprint(model),
      ready: false,
      starting: true,
      cancelled: false,
      exited: false,
      error: '',
      stdout: '',
      stderr: '',
      exitCode: null,
      exitSignal: null,
      startedAt: new Date().toISOString(),
      started: null,
    };
    state.started = (async () => {
      try {
        state.child = spawn(model.binary, buildServerArgs(model, port), {
          cwd: model.modelDir,
          // Both pipes are consumed below so neither can fill up and deadlock
          // the child. llama-server normally puts startup diagnostics on stderr;
          // stdout is kept as a fallback for builds that log there instead.
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        state.pid = state.child.pid ?? null;
        // Write before waiting for /health: if this process dies during a slow
        // model load, the next plugin load still knows the port and PID.
        saveEngineLock(state);
        state.child.stdout?.setEncoding('utf8');
        state.child.stderr?.setEncoding('utf8');
        state.child.stdout?.on('data', (chunk) => appendLog(state, 'stdout', chunk));
        state.child.stderr?.on('data', (chunk) => appendLog(state, 'stderr', chunk));
        state.child.on('error', (error) => {
          state.error = startFailure(state, `无法启动 llama-server（${model.binary}）：${String(error?.message ?? error)}`);
          state.exited = true;
          if (!Number.isInteger(state.pid) || !pidAlive(state.pid)) removeEngineLock(state);
          else saveEngineLock(state);
        });
        state.child.on('exit', (code, signal) => {
          state.exitCode = code;
          state.exitSignal = signal;
          state.exited = true;
          if (state.ready !== true) {
            // An explicit stop/cancel we requested is not a startup failure:
            // turning that SIGTERM into "llama-server 退出" sends the user
            // hunting for a broken GGUF that never was broken.
            if (state.cancelled !== true) {
              state.error = state.error || startFailure(
                state,
                `llama-server 退出（code=${code ?? '-'}, signal=${signal ?? '-'}）`,
              );
            }
            removeEngineLock(state);
          }
          state.ready = false;
        });
        await waitForHealth(port, model.startupTimeoutMs, state);
        state.ready = true;
        state.error = '';
        saveEngineLock(state);
      } catch (error) {
        state.error = state.cancelled === true ? '启动已取消' : String(error?.message ?? error);
        state.exited = true;
        const stopResult = await stopAndUpdateLock(state);
        if (!stopResult.gone) {
          // Keep the failed/unready process visible so the user can stop it;
          // deleting the lock here was how live servers became invisible.
          state.error = `${state.error}；进程仍在运行（pid=${state.pid ?? '-'}）`;
        }
      } finally {
        state.starting = false;
      }
    })();
    engines.set(model.id, state);
    await state.started;
    if (state.cancelled === true) {
      await stopAndUpdateLock(state);
      return { ok: false, cancelled: true, error: '启动已取消', engine: engineStatus(state) };
    }
    if (state.ready) {
      return {
        ok: true,
        engine: engineStatus(state),
        endpoint: { baseUrl: state.baseUrl, model: model.model },
      };
    }
    lastEngine = state;
    const addressBusy = /EADDRINUSE|address already in use/i.test(String(state.error ?? ''));
    if (configuredPort || addressBusy !== true || attempt >= 2) break;
    // freePort() releases the probe socket before the child binds. Another
    // process can steal that port in between; retry with a new ephemeral port
    // instead of surfacing a permanent startup failure.
    engines.delete(model.id);
    const stopResult = await stopAndUpdateLock(state);
    if (!stopResult.gone) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  // Keep the failed state in the map: the panel needs its stderr tail after
  // the start request has returned, and a retry replaces this entry.
  return { ok: false, error: lastEngine?.error || 'llama-server 启动失败', engine: lastEngine ? engineStatus(lastEngine) : null };
}

function engineStatus(state) {
  return {
    id: state.id,
    kind: state.kind,
    ready: state.ready === true,
    starting: state.starting === true,
    adopted: state.adopted === true,
    stale: state.stale === true,
    baseUrl: state.baseUrl,
    model: state.model.model,
    modelPath: state.model.modelPath,
    binary: state.model.binary,
    command: state.command,
    pid: state.child?.pid ?? state.pid ?? null,
    startedAt: state.startedAt ?? '',
    exitCode: state.exitCode,
    exitSignal: state.exitSignal,
    error: state.error,
    // The panel shows this tail verbatim when a start fails; it is also
    // available from the status route after the toast has gone.
    stderr: state.error ? (state.stderr || state.stdout || '').trim() : '',
  };
}

/** Status of every engine this plugin has started, for the panel. */
export function localEngineStatus() {
  return [...engines.values()].map(engineStatus);
}

/**
 * Why the lifecycle decided not to auto-start a runnable model, one entry per
 * model. Kept next to the engine status so `/state` and the panel can explain a
 * missing engine instead of leaving the user with a silent "nothing happened".
 *
 * @param {string} modelId
 * @param {{kind?: string, base?: string, dedicated?: boolean, reason?: string}} detail
 */
export function noteAutoStartSkip(modelId, detail = {}) {
  const id = clean(modelId);
  if (id === '') return;
  autoStartSkipNotes.set(id, {
    id,
    kind: String(detail.kind ?? ''),
    base: String(detail.base ?? ''),
    dedicated: detail.dedicated === true,
    reason: String(detail.reason ?? ''),
    at: new Date().toISOString(),
  });
}

/** Clear a recorded auto-start skip for one model. */
export function clearAutoStartSkip(modelId) {
  autoStartSkipNotes.delete(clean(modelId));
}

/** Auto-start skips currently recorded, for the panel. */
export function autoStartSkips() {
  return [...autoStartSkipNotes.values()];
}

/**
 * Kinds of local model that are runnable but have no ready engine of the same
 * kind. The panel turns a non-empty result into one reminder; it is not a
 * request to start anything, so nothing is spawned just because a model file
 * exists on disk.
 *
 * Model and engine kinds disagree on case: loose GGUFs report `Embedding` /
 * `Rerank`, category folders report `embedding` / `rerank`. Compare them
 * lower-cased or a running reranker will not cover a `Rerank` model.
 *
 * @param {{categories?: Array<{name: string, models?: object[]}>}} models
 * @param {object[]} [engines]
 * @returns {string[]} lower-cased `embedding` / `rerank` values, sorted.
 */
export function missingLocalEngineKinds(models, engines = []) {
  const runnable = new Set();
  for (const category of models?.categories ?? []) {
    for (const model of category?.models ?? []) {
      if (model?.runnable !== true) continue;
      // Only models that this plugin itself would launch count as "llama.cpp".
      if (model.engine !== '' && model.engine !== 'llama.cpp') continue;
      const kind = String(model.kind ?? '').toLowerCase();
      if (kind === 'embedding' || kind === 'rerank') runnable.add(kind);
    }
  }
  const ready = new Set((engines ?? [])
    .filter((engine) => engine?.ready === true)
    .map((engine) => String(engine.kind ?? '').toLowerCase()));
  return [...runnable].filter((kind) => !ready.has(kind)).sort();
}

/**
 * Stop one engine by model id; safe when it was never started.
 *
 * `cancelStart` is for explicit user stops: cancel the in-flight load and
 * report it as cancelled instead of a crash. The default (turn-level idle
 * stop) waits for a starting model to settle first, so a short turn can never
 * SIGTERM a process that is still reading weights.
 *
 * @param {string} modelId
 * @param {{cancelStart?: boolean}} [options]
 */
export async function stopLocalEngine(modelId, options = {}) {
  const id = clean(modelId);
  const state = engines.get(id);
  if (!state) return { ok: true, stopped: false };
  if (state.starting === true && state.started) {
    if (options.cancelStart === true) {
      state.cancelled = true;
    } else {
      await state.started.catch(() => {});
    }
  }
  const result = await stopAndUpdateLock(state);
  if (!result.gone) {
    return { ok: false, error: `llama-server 仍在运行（pid=${state.pid ?? '-'}）`, engine: engineStatus(state) };
  }
  engines.delete(id);
  return {
    ok: true,
    stopped: result.killed,
    stale: result.reason === 'not-our-process',
  };
}

/** Stop every managed server (plugin disposal / process exit). */
export async function stopAllLocalEngines() {
  let stopped = 0;
  for (const [id, state] of [...engines]) {
    const result = await stopAndUpdateLock(state);
    if (result.gone) {
      engines.delete(id);
      if (result.killed) stopped += 1;
    }
    // A survivor stays in the map and keeps its lock, so a later stop (or the
    // process-exit handler) can still find it instead of leaking it.
  }
  return stopped;
}

process.once('exit', () => {
  for (const state of engines.values()) {
    try {
      // Only kill a child we spawned and still hold a handle for. An adopted
      // PID may have been recycled by the OS; a synchronous exit handler cannot
      // verify its command line, so it must not signal a bare PID.
      if (state.child) state.child.kill('SIGKILL');
    } catch {
      // Best effort on process shutdown.
    }
  }
});
