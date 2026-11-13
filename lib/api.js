/**
 * HTTP API backing the Web panel.
 *
 * Routes (same-origin, loopback only):
 *   GET  /ai-for-memory/api/state     memory snapshot for one registered root
 *   POST /ai-for-memory/api/reveal    open a registered root in the OS file manager
 *   POST /ai-for-memory/api/config    persist a fixed memory directory via configEditor
 *
 * The API never reads arbitrary paths: a root must come from the registry or
 * from the plugin's own configured `root`.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { MemoryStore } from './store.js';
import { buildUiState } from './ui-state.js';
import { listRootRows, resolveRegisteredRoot } from './registry.js';

const PREFIX = '/ai-for-memory/api';
const MAX_BODY_BYTES = 64 * 1024;

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function originTrusted(origin, host) {
  try {
    const url = new URL(origin);
    if (url.host === host) return true;
    return url.protocol === 'dsh-app:';
  } catch {
    return false;
  }
}

/** Writes require a loopback peer and, when present, a trusted Origin. */
function isSameOrigin(request) {
  if (!isLoopback(request.socket?.remoteAddress)) return false;
  const origin = request.headers?.origin;
  if (typeof origin !== 'string' || origin === '') return true;
  return originTrusted(origin, request.headers?.host);
}

function applyCors(request, response) {
  if (!isLoopback(request.socket?.remoteAddress)) return;
  const origin = request.headers?.origin;
  if (typeof origin !== 'string' || origin === '') return;
  if (!originTrusted(origin, request.headers?.host)) return;
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('vary', 'origin');
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type');
  response.setHeader('access-control-max-age', '600');
}

async function readJson(request) {
  const type = String(request.headers?.['content-type'] ?? '');
  if (!type.includes('application/json')) throw new Error('Content-Type 必须是 application/json');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

function openInFileManager(target) {
  const [command, args] = process.platform === 'win32'
    ? ['explorer.exe', [target]]
    : process.platform === 'darwin'
      ? ['open', [target]]
      : ['xdg-open', [target]];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

/**
 * Register the panel API.
 *
 * @param {object} ctx - plugin context.
 * @param {{config: object, entry: object|undefined, editor: object|undefined, registryDir: string}} deps
 */
export function installApi(ctx, deps) {
  if (typeof ctx?.inject !== 'function') return;
  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx.webServer ?? (typeof webCtx.get === 'function' ? webCtx.get('webServer') : undefined);
    if (!server || typeof server.register !== 'function') return undefined;

    const register = (routePath, handler) => webCtx.effect(
      () => server.register({
        kind: 'exact',
        path: routePath,
        handler: async (request, response) => {
          applyCors(request, response);
          if (request.method === 'OPTIONS') {
            response.writeHead(204);
            response.end();
            return;
          }
          try {
            await handler(request, response);
          } catch (error) {
            if (!response.headersSent) {
              sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
            }
          }
        },
      }),
      `ai-for-memory: route ${routePath}`,
    );

    const fixedRoots = () => (deps.config.root ? [path.resolve(deps.config.root)] : []);

    register(`${PREFIX}/state`, async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end();
        return;
      }
      const url = new URL(request.url ?? '/', 'http://localhost');
      const roots = listRootRows(deps.registryDir, deps.config.root);
      const selected = resolveRegisteredRoot(
        url.searchParams.get('root'),
        deps.registryDir,
        fixedRoots(),
      );
      if (selected === null) {
        sendJson(response, 200, {
          ok: true,
          generatedAt: new Date().toISOString(),
          roots,
          selectedRoot: null,
          fixedRoot: deps.config.root ?? '',
          directoryName: deps.config.directoryName,
          mode: deps.config.autoEnabled ? 'auto' : 'manual',
          autoEnabled: deps.config.autoEnabled,
          autoEveryRounds: deps.config.autoEveryRounds,
          counts: { staging: 0, archive: 0, snapshots: 0, knowledge: 0, decisions: 0, contexts: 0 },
          decisionsByOutcome: {},
          staging: [],
          archive: [],
          snapshots: [],
          knowledge: [],
          decisions: [],
          contexts: [],
        });
        return;
      }

      const store = new MemoryStore(selected, {
        maxContentChars: deps.config.maxContentChars,
        maxSnapshotBytes: deps.config.maxSnapshotBytes,
        defaultTopK: deps.config.defaultTopK,
      });
      const state = buildUiState(store);
      sendJson(response, 200, {
        ok: true,
        generatedAt: state.generatedAt,
        roots,
        selectedRoot: store.root,
        fixedRoot: deps.config.root ?? '',
        directoryName: deps.config.directoryName,
        mode: deps.config.autoEnabled ? 'auto' : 'manual',
        autoEnabled: deps.config.autoEnabled,
        autoEveryRounds: deps.config.autoEveryRounds,
        ...state,
      });
    });

    register(`${PREFIX}/reveal`, async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end();
        return;
      }
      if (!isSameOrigin(request)) {
        sendJson(response, 403, { ok: false, error: '请求来源不受信任' });
        return;
      }
      const body = await readJson(request);
      const target = resolveRegisteredRoot(body?.root, deps.registryDir, fixedRoots());
      if (target === null) {
        sendJson(response, 404, { ok: false, error: '记忆目录未登记' });
        return;
      }
      // The fixed root may not have been used yet; create it so "open folder" works.
      fs.mkdirSync(target, { recursive: true });
      openInFileManager(target);
      sendJson(response, 200, { ok: true, root: target });
    });

    register(`${PREFIX}/config`, async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end();
        return;
      }
      if (!isSameOrigin(request)) {
        sendJson(response, 403, { ok: false, error: '请求来源不受信任' });
        return;
      }
      const body = await readJson(request);
      const root = typeof body?.root === 'string' ? body.root.trim() : deps.config.root;
      const directoryName = typeof body?.directoryName === 'string'
        ? body.directoryName.trim()
        : deps.config.directoryName;
      const autoEnabled = body?.autoEnabled === undefined
        ? deps.config.autoEnabled
        : body.autoEnabled;
      const autoEveryRounds = body?.autoEveryRounds === undefined
        ? deps.config.autoEveryRounds
        : body.autoEveryRounds;

      if (root !== '' && !path.isAbsolute(root)) {
        sendJson(response, 400, { ok: false, error: '记忆地址必须是绝对路径，或留空跟随项目' });
        return;
      }
      if (root.length > 1000 || root.includes('\0')) {
        sendJson(response, 400, { ok: false, error: '记忆地址不合法' });
        return;
      }
      if (directoryName === '' || directoryName.length > 100
        || directoryName === '.' || directoryName === '..' || /[\\/]/.test(directoryName)) {
        sendJson(response, 400, { ok: false, error: '目录名必须是单段名称（不含路径分隔符）' });
        return;
      }
      if (typeof autoEnabled !== 'boolean') {
        sendJson(response, 400, { ok: false, error: 'autoEnabled 必须是布尔值' });
        return;
      }
      if (!Number.isInteger(autoEveryRounds) || autoEveryRounds < 1 || autoEveryRounds > 100) {
        sendJson(response, 400, { ok: false, error: '自动触发轮数必须是 1~100 的整数' });
        return;
      }
      if (!deps.editor || typeof deps.editor.edit !== 'function' || !deps.entry) {
        sendJson(response, 503, { ok: false, error: '当前运行环境不允许从面板保存配置' });
        return;
      }

      try {
        await deps.editor.edit(deps.entry, (current) => ({
          ...(current ?? {}),
          root,
          directoryName,
          autoEnabled,
          autoEveryRounds,
        }));
      } catch (error) {
        sendJson(response, 500, { ok: false, error: `保存配置失败：${error?.message ?? error}` });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        saved: { root, directoryName, autoEnabled, autoEveryRounds },
      });
    });
  });
}
