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
 * Nothing is started at import time. A model is only started by an explicit
 * panel/API request, and `stopAllLocalEngines()` is called when the plugin is
 * disposed.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { defaultModelRoots, installModelsDir } from './model-paths.js';

const DEFAULT_MODELS_ROOT = installModelsDir();
const DEFAULT_STARTUP_TIMEOUT_MS = 120000;
/** Keep enough of llama-server's own diagnostics to explain a failed start. */
const STARTUP_LOG_LIMIT = 32000;
/** Legacy single-file journal; new installs use a directory with one file per model. */
const ENGINE_LOCK_FILE = '.engine.lock';
const ENGINE_LOCK_VERSION = 1;
/** @type {Map<string, EngineProcess>} */
const engines = new Map();
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
  const kind = localEngineKind(category);
  if (kind === '') {
    return {
      ok: false,
      error: `分类 ${category} 不是本地引擎支持的分类；目前只支持 Embedding 和 Rerank，Routing 等预留分类不能启动 llama-server`,
    };
  }
  const explicitRoot = clean(input.modelsRoot);
  const roots = explicitRoot === '' ? defaultModelRoots() : [path.resolve(explicitRoot)];
  let root = '';
  let modelDir = '';
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
  const manifestFile = path.join(modelDir, 'model.json');
  const parsed = fs.existsSync(manifestFile) ? parseManifest(manifestFile) : { data: {} };
  if (parsed.error) return { ok: false, error: parsed.error };
  const data = parsed.data ?? {};

  const configuredModel = clean(data.modelPath ?? data.modelFile);
  let modelPath = configuredModel === ''
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

  const configuredBinary = clean(data.binary ?? data.enginePath);
  let binary = configuredBinary;
  if (binary === '') binary = clean(process.env.DSH_LLAMA_SERVER) || clean(process.env.LLAMA_SERVER) || 'llama-server';
  else if (!path.isAbsolute(binary) && /[\\/]/.test(binary)) binary = path.resolve(modelDir, binary);

  const modelName = clean(data.model) || folder;
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
      ctxSize: integer(data.ctxSize, 8192),
      port: integer(data.port, 0),
      startupTimeoutMs: integer(data.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS),
      extraArgs: Array.isArray(data.extraArgs)
        ? data.extraArgs.filter((value) => typeof value === 'string' && value.trim() !== '').map((value) => value.trim())
        : [],
      data,
    },
  };
}

/** Arguments used by llama-server; exported so tests can inspect them without spawning. */
export function buildServerArgs(model, port) {
  const args = [
    '-m', model.modelPath,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--ctx-size', String(model.ctxSize || 8192),
  ];
  if (model.kind === 'rerank') {
    args.push('--reranking');
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

async function adoptLockedEngines(modelsRoot) {
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
    const probe = await probeLockedEngine(row);
    if (!probe.ok) {
      // Delete only this dead row; never rewrite the whole journal, because
      // another DSH process may be saving a different model concurrently.
      removeEngineLock(root, row.id, row);
      continue;
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
      ready: true,
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
    engines.set(state.id, state);
    saveEngineLock(state);
  }
  return [...engines.values()].map(engineStatus);
}

/**
 * Adopt llama-server processes left by a previous plugin process (crash,
 * kill -9, DSH restart). Must run before the panel can start a new engine.
 */
export function restoreLocalEngines(input = {}) {
  const explicitRoot = clean(input.modelsRoot);
  const roots = explicitRoot === '' ? defaultModelRoots() : [path.resolve(explicitRoot)];
  const run = async () => {
    const merged = new Map();
    for (const root of roots) {
      const rows = await adoptLockedEngines(root);
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

function stopProcess(state) {
  if (!state) return Promise.resolve();
  // Do not use `state.exited` here: a failed/timed-out start marks that flag
  // before calling stopProcess, and the child may still be alive (for example
  // during a slow model load). Stop based on the live child handle or PID.
  if (state.child) {
    if (state.child.exitCode !== null || state.child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      state.child.once('exit', finish);
      try {
        state.child.kill();
      } catch {
        finish();
      }
      setTimeout(finish, 2500);
    });
  }
  const pid = state.pid;
  if (!Number.isInteger(pid) || !pidAlive(pid)) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer !== null) clearInterval(timer);
      resolve();
    };
    timer = setInterval(() => {
      if (!pidAlive(pid)) finish();
    }, 150);
    timer.unref?.();
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      finish();
      return;
    }
    // Windows maps SIGKILL to terminate too; do not leave a 1.5G server alive
    // just because it ignored the polite signal.
    setTimeout(() => {
      if (!pidAlive(pid)) return;
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }, 1200).unref?.();
    setTimeout(finish, 2500);
  });
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

  const port = model.port || await freePort().catch(() => 0);
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
        removeEngineLock(state);
      });
      state.child.on('exit', (code, signal) => {
        state.exitCode = code;
        state.exitSignal = signal;
        state.exited = true;
        if (state.ready !== true) {
          state.error = state.error || startFailure(
            state,
            `llama-server 退出（code=${code ?? '-'}, signal=${signal ?? '-'}）`,
          );
          removeEngineLock(state);
        }
        state.ready = false;
      });
      await waitForHealth(port, model.startupTimeoutMs, state);
      state.ready = true;
      state.error = '';
      saveEngineLock(state);
    } catch (error) {
      state.error = String(error?.message ?? error);
      state.exited = true;
      removeEngineLock(state);
      await stopProcess(state);
    } finally {
      state.starting = false;
    }
  })();
  engines.set(model.id, state);
  await state.started;
  if (!state.ready) {
    // Keep the failed state in the map: the panel needs its stderr tail after
    // the start request has returned, and a retry replaces this entry.
    return { ok: false, error: state.error || 'llama-server 启动失败', engine: engineStatus(state) };
  }
  return {
    ok: true,
    engine: engineStatus(state),
    endpoint: { baseUrl: state.baseUrl, model: model.model },
  };
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

/** Stop one engine by model id; safe when it was never started. */
export async function stopLocalEngine(modelId) {
  const id = clean(modelId);
  const state = engines.get(id);
  if (!state) return { ok: true, stopped: false };
  await stopProcess(state);
  const alive = state.child
    ? state.child.exitCode === null && state.child.signalCode === null
    : (Number.isInteger(state.pid) && pidAlive(state.pid));
  if (alive) {
    return { ok: false, error: `llama-server 仍在运行（pid=${state.pid ?? '-'}）`, engine: engineStatus(state) };
  }
  removeEngineLock(state);
  engines.delete(id);
  return { ok: true, stopped: true };
}

/** Stop every managed server (plugin disposal / process exit). */
export async function stopAllLocalEngines() {
  const states = [...engines.values()];
  engines.clear();
  await Promise.all(states.map(async (state) => {
    await stopProcess(state);
    removeEngineLock(state);
  }));
  return states.length;
}

process.once('exit', () => {
  for (const state of engines.values()) {
    try {
      if (state.child) state.child.kill();
      else if (Number.isInteger(state.pid) && state.pid > 0) process.kill(state.pid, 'SIGTERM');
    } catch {
      // Best effort on process shutdown.
    }
  }
});
