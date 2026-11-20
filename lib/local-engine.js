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
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MODELS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'models');
const DEFAULT_STARTUP_TIMEOUT_MS = 120000;
/** @type {Map<string, EngineProcess>} */
const engines = new Map();

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

/**
 * Resolve one model folder into everything needed to spawn llama-server.
 *
 * @param {{modelsRoot?: string, modelId: string}} input
 * @returns {{ok: true, model: object} | {ok: false, error: string}}
 */
export function resolveModel(input = {}) {
  const root = path.resolve(clean(input.modelsRoot) || DEFAULT_MODELS_ROOT);
  const modelId = clean(input.modelId);
  const parts = modelId.split('/');
  if (parts.length !== 2 || parts.some((part) => part === '' || part === '.' || part === '..'
    || part.includes('\\'))) {
    return { ok: false, error: '模型 id 必须是「分类/文件夹」' };
  }
  const [category, folder] = parts;
  const modelDir = path.join(root, category, folder);
  if (!fs.existsSync(modelDir) || !fs.statSync(modelDir).isDirectory()) {
    return { ok: false, error: `模型目录不存在：models/${modelId}` };
  }
  const manifestFile = path.join(modelDir, 'model.json');
  const parsed = fs.existsSync(manifestFile) ? parseManifest(manifestFile) : { data: {} };
  if (parsed.error) return { ok: false, error: parsed.error };
  const data = parsed.data ?? {};
  const kind = category.toLowerCase().includes('rerank') ? 'rerank' : 'embedding';

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

async function waitForHealth(port, timeoutMs, state) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (state.exited === true) throw new Error(state.error || 'llama-server 已退出');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error?.message ?? error);
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(`llama-server 启动超时（${Math.round(timeoutMs / 1000)}s）：${lastError || '没有响应'}`);
}

function stopProcess(state) {
  if (!state?.child || state.exited === true) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => resolve();
    state.child.once('exit', finish);
    try {
      state.child.kill();
    } catch {
      finish();
    }
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
  const resolved = resolveModel(input);
  if (!resolved.ok) return resolved;
  const model = resolved.model;
  const existing = engines.get(model.id);
  if (existing?.ready === true) {
    return {
      ok: true,
      engine: engineStatus(existing),
      endpoint: { baseUrl: existing.baseUrl, model: model.model },
    };
  }
  if (existing?.starting === true) {
    await existing.started;
    if (existing.ready === true) {
      return {
        ok: true,
        engine: engineStatus(existing),
        endpoint: { baseUrl: existing.baseUrl, model: model.model },
      };
    }
    return { ok: false, error: existing.error || 'llama-server 未就绪' };
  }

  const port = model.port || await freePort().catch(() => 0);
  if (!port) return { ok: false, error: '无法分配本地端口' };
  const state = {
    id: model.id,
    kind: model.kind,
    model,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    child: null,
    ready: false,
    starting: true,
    exited: false,
    error: '',
    started: null,
  };
  state.started = (async () => {
    try {
      state.child = spawn(model.binary, buildServerArgs(model, port), {
        cwd: model.modelDir,
        stdio: 'ignore',
        windowsHide: true,
      });
      state.child.on('error', (error) => {
        state.error = String(error?.message ?? error);
        state.exited = true;
      });
      state.child.on('exit', (code, signal) => {
        state.exited = true;
        if (state.ready !== true) state.error = state.error || `llama-server 退出（code=${code ?? '-'}, signal=${signal ?? '-'}）`;
        state.ready = false;
      });
      await waitForHealth(port, model.startupTimeoutMs, state);
      state.ready = true;
      state.error = '';
    } catch (error) {
      state.error = String(error?.message ?? error);
      state.exited = true;
      await stopProcess(state);
    } finally {
      state.starting = false;
    }
  })();
  engines.set(model.id, state);
  await state.started;
  if (!state.ready) {
    engines.delete(model.id);
    return { ok: false, error: state.error || 'llama-server 启动失败' };
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
    baseUrl: state.baseUrl,
    model: state.model.model,
    pid: state.child?.pid ?? null,
    error: state.error,
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
  engines.delete(id);
  return { ok: true, stopped: true };
}

/** Stop every managed server (plugin disposal / process exit). */
export async function stopAllLocalEngines() {
  const states = [...engines.values()];
  engines.clear();
  await Promise.all(states.map((state) => stopProcess(state)));
  return states.length;
}

process.once('exit', () => {
  for (const state of engines.values()) {
    try {
      state.child?.kill();
    } catch {
      // Best effort on process shutdown.
    }
  }
});
