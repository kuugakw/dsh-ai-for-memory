/**
 * HTTP API backing the Web panel.
 *
 * Routes (same-origin, loopback only):
 *   GET  /ai-for-memory/api/state     memory snapshot for one registered root
 *   POST /ai-for-memory/api/reveal    open a registered root in the OS file manager
 *   POST /ai-for-memory/api/config    persist a fixed memory directory via configEditor
 *
 * The API never reads arbitrary paths: a root must come from the registry or
 * from the plugin's own configured `root`. A conversation must be one the
 * plugin itself recorded under `<root>/sessions` (or the id the Host is
 * currently using), so the state route is not a generic Session reader either.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { MemoryScopes, isSessionKey, sessionKey, shortSessionId } from './scopes.js';
import { recentSessionId } from './activity.js';
import { buildUiState } from './ui-state.js';
import { listRootRows, resolveRegisteredRoot } from './registry.js';

const PREFIX = '/ai-for-memory/api';
const MAX_BODY_BYTES = 64 * 1024;

const ZERO_COUNTS = Object.freeze({
  staging: 0, archive: 0, snapshots: 0, knowledge: 0, decisions: 0, contexts: 0,
});

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

/** Row shape shared by the conversation list and `selectedSession`. */
function sessionRow(row, counts, isCurrent) {
  const name = row.name ?? row.label ?? row.title ?? '';
  return {
    key: row.key,
    sessionId: row.sessionId ?? '',
    parentSessionId: row.parentSessionId ?? '',
    workspace: row.workspace ?? '',
    label: row.label ?? '',
    title: row.title ?? '',
    name,
    public: row.public !== false,
    displayLabel: name !== ''
      ? `${isCurrent ? '当前对话' : '对话'} ${name}`
      : (row.sessionId
        ? `${isCurrent ? '当前对话' : '对话'} ${shortSessionId(row.sessionId)}`
        : `对话 ${row.key.slice(-6)}`),
    createdAt: row.createdAt ?? '',
    updatedAt: row.updatedAt ?? '',
    current: isCurrent,
    counts,
  };
}

/**
 * Register the panel API.
 *
 * @param {object} ctx - plugin context.
 * @param {{config: object, entry: object|undefined, editor: object|undefined,
 *   registryDir: string, runtime?: object}} deps
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
      const base = {
        ok: true,
        generatedAt: new Date().toISOString(),
        roots,
        fixedRoot: deps.config.root ?? '',
        directoryName: deps.config.directoryName,
        mode: deps.config.autoEnabled ? 'auto' : 'manual',
        autoEnabled: deps.config.autoEnabled,
        autoEveryRounds: deps.config.autoEveryRounds,
        defaultPublic: deps.config.defaultPublic !== false,
      };
      if (selected === null) {
        sendJson(response, 200, {
          ...base,
          selectedRoot: null,
          scope: 'session',
          sessionUnknown: true,
          currentSessionId: recentSessionId(deps.runtime),
          selectedSession: null,
          sessions: [],
          sessionsTotal: 0,
          shared: { counts: { ...ZERO_COUNTS }, hasData: false },
          counts: { ...ZERO_COUNTS },
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

      const scopes = new MemoryScopes(selected, {
        maxContentChars: deps.config.maxContentChars,
        maxSnapshotBytes: deps.config.maxSnapshotBytes,
        defaultTopK: deps.config.defaultTopK,
      });
      const currentSessionId = recentSessionId(deps.runtime);
      const requestedSession = String(url.searchParams.get('session') ?? '').trim();
      const wantedSession = requestedSession || currentSessionId;
      const resolved = wantedSession === '' ? null : scopes.resolve(wantedSession);
      // An unanswered conversation-key (for example after switching memory roots)
      // must not be hashed into a brand-new empty conversation.
      const unknownKey = resolved === null && isSessionKey(wantedSession);
      const selectedKey = resolved?.key ?? (wantedSession === '' || unknownKey ? null : sessionKey(wantedSession));
      const selectedSessionId = resolved?.sessionId ?? (unknownKey ? '' : wantedSession);

      // A conversation that has never written memory still gets a metadata row,
      // so the picker can show "current conversation" with empty counts.
      if (selectedKey !== null && selectedKey !== undefined && !resolved) {
        scopes.ensureSession(selectedSessionId, {});
      }

      const allRows = scopes.listSessions();
      const MAX_ROWS = 40;
      const trimmed = allRows.length > MAX_ROWS && !allRows.slice(0, MAX_ROWS).some((row) => row.key === selectedKey);
      const visibleRows = trimmed
        ? [...allRows.slice(0, MAX_ROWS), ...allRows.filter((row) => row.key === selectedKey)]
        : allRows.slice(0, MAX_ROWS);
      const rows = visibleRows.map((row) => {
        const counts = scopes.counts(row.key);
        return sessionRow(row, counts, row.key === selectedKey);
      });
      if (selectedKey && !rows.some((row) => row.key === selectedKey)) {
        rows.unshift(sessionRow({
          key: selectedKey,
          sessionId: selectedSessionId,
          public: deps.config.defaultPublic !== false,
          createdAt: '',
          updatedAt: '',
        }, { ...ZERO_COUNTS }, true));
      }
      rows.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));

      const requestedScope = String(url.searchParams.get('scope') ?? '');
      const scope = ['session', 'all', 'shared'].includes(requestedScope) ? requestedScope : 'session';

      const sharedCounts = scopes.sharedCounts();
      const sharedHasData = Object.values(sharedCounts).some((count) => count > 0);
      const sharedSource = {
        store: scopes.sharedStore(),
        scope: 'shared',
        key: '',
        sessionId: '',
        label: '共享',
      };

      let sources;
      if (scope === 'shared') {
        sources = [sharedSource];
      } else if (scope === 'all') {
        // Closed conversations are invisible to everyone except themselves.
        sources = rows
          .filter((row) => row.current || row.public !== false)
          .map((row) => ({
            store: scopes.sessionStore(row.key),
            scope: 'session',
            key: row.key,
            sessionId: row.sessionId,
            label: row.current ? '本对话' : `对话 ${row.name || shortSessionId(row.sessionId)}`,
          }));
        if (sharedHasData) sources.push(sharedSource);
      } else {
        const own = rows.find((row) => row.key === selectedKey);
        sources = own
          ? [{
            store: scopes.sessionStore(own.key),
            scope: 'session',
            key: own.key,
            sessionId: own.sessionId,
            label: '本对话',
          }]
          : [sharedSource];
      }

      const state = buildUiState(sources);
      sendJson(response, 200, {
        ...base,
        ...state,
        selectedRoot: scopes.root,
        // Explicit scope wins over the merged view's inferred one.
        scope,
        sessionUnknown: selectedKey === null || selectedKey === undefined,
        currentSessionId,
        selectedSession: rows.find((row) => row.current) ?? null,
        sessions: rows,
        sessionsTotal: allRows.length,
        shared: { counts: sharedCounts, hasData: sharedHasData },
      });
    });

    register(`${PREFIX}/session`, async (request, response) => {
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
      const rootPath = resolveRegisteredRoot(body?.root, deps.registryDir, fixedRoots());
      if (rootPath === null) {
        sendJson(response, 404, { ok: false, error: '记忆目录未登记' });
        return;
      }
      const target = String(body?.session ?? '').trim();
      if (target === '') {
        sendJson(response, 400, { ok: false, error: '缺少对话标识' });
        return;
      }
      let label;
      if (body?.label !== undefined) {
        if (typeof body.label !== 'string') {
          sendJson(response, 400, { ok: false, error: '对话名称必须是字符串' });
          return;
        }
        label = body.label.trim();
        if (label.length > 80) {
          sendJson(response, 400, { ok: false, error: '对话名称最多 80 个字符' });
          return;
        }
      }
      let isPublic;
      if (body?.public !== undefined) {
        if (typeof body.public !== 'boolean') {
          sendJson(response, 400, { ok: false, error: '开放状态必须是布尔值' });
          return;
        }
        isPublic = body.public;
      }
      if (label === undefined && isPublic === undefined) {
        sendJson(response, 400, { ok: false, error: '没有要修改的设置' });
        return;
      }

      const scopes = new MemoryScopes(rootPath, {
        maxContentChars: deps.config.maxContentChars,
        maxSnapshotBytes: deps.config.maxSnapshotBytes,
        defaultTopK: deps.config.defaultTopK,
      });
      const resolved = scopes.resolve(target);
      if (!resolved) {
        sendJson(response, 404, { ok: false, error: '对话未登记' });
        return;
      }

      const patch = {};
      if (label !== undefined) patch.label = label;
      if (isPublic !== undefined) patch.public = isPublic;
      scopes.touch(resolved.key, patch);

      // Keep the DSH sidebar title in sync when this conversation is live; a
      // closed/archived conversation keeps the name in session.json only.
      if (label !== undefined && label !== '') {
        try {
          const agents = deps.getService?.('agents');
          const session = agents?.get?.(resolved.sessionId)?.session;
          const titles = deps.getService?.('sessionTitle');
          if (session && titles && typeof titles.rename === 'function') {
            titles.rename(session, label);
          }
        } catch {
          // The memory-side name is already persisted; sidebar sync is optional.
        }
      }

      const row = scopes.listSessions().find((candidate) => candidate.key === resolved.key);
      sendJson(response, 200, {
        ok: true,
        saved: { key: resolved.key, label: label ?? row?.label ?? '', public: isPublic ?? row?.public !== false },
        session: row ? sessionRow(row, scopes.counts(row.key), false) : null,
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
      const defaultPublic = body?.defaultPublic === undefined
        ? deps.config.defaultPublic !== false
        : body.defaultPublic;

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
      if (typeof defaultPublic !== 'boolean') {
        sendJson(response, 400, { ok: false, error: 'defaultPublic 必须是布尔值' });
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
          defaultPublic,
        }));
      } catch (error) {
        sendJson(response, 500, { ok: false, error: `保存配置失败：${error?.message ?? error}` });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        saved: { root, directoryName, autoEnabled, autoEveryRounds, defaultPublic },
      });
    });
  });
}
