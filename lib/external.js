/**
 * External model API client — any OpenAI-compatible HTTP API.
 *
 * The plugin talks to a *protocol*, not an implementation: `POST
 * /v1/embeddings`, `POST /v1/rerank` (or the older `/rerank`), `POST
 * /v1/chat/completions`, `GET /v1/models`. llama.cpp's llama-server, Ollama,
 * LM Studio, vLLM, Xinference, TEI, Cohere/Jina-style rerank proxies and the
 * OpenAI API itself all speak this shape, so the same client covers all of them.
 *
 * Design rules:
 * - no SDK, no dependency: `fetch` from the runtime;
 * - base URLs are forgiving: a server root (`http://host:8080`), an API root
 *   (`.../v1`) or a full copied endpoint (`.../v1/embeddings`) are all accepted;
 * - every call takes an explicit timeout and aborts cleanly;
 * - errors are returned as `{ ok: false, error }` with a short reason instead of
 *   throwing arbitrary network text at the caller;
 * - `apiKey` is optional (local servers usually run open on loopback) but sent as
 *   a Bearer token when configured.
 */

/** Keys/lengths used by the panel and the `aim_ask` tool. */
export const EXTERNAL_DEFAULTS = Object.freeze({
  baseUrl: 'http://127.0.0.1:8080',
  model: '',
  // Embedding and rerank models often live on another process/port/provider, so
  // they get their own base URL / model name. Empty values fall back to
  // `baseUrl` / `model`, which covers the single-endpoint case.
  embedModel: '',
  embedBaseUrl: '',
  rerankBaseUrl: '',
  rerankModel: '',
  apiKey: '',
  timeoutMs: 60000,
});

export const EXTERNAL_BOUNDS = Object.freeze({ timeoutMs: [1000, 600000] });

/** Cap a server error body so a huge HTML page cannot flood a tool result. */
const ERROR_EXCERPT_CHARS = 300;

/** Endpoint suffixes users copy out of provider docs; stripped before resolving. */
const ENDPOINT_SUFFIXES = ['/chat/completions', '/embeddings', '/rerank', '/models', '/health'];

/** Normalize the external-API part of the plugin config. */
export function normalizeExternal(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const clean = (value) => (typeof value === 'string' ? value.trim() : '');
  const trimmed = (value, fallback) => {
    const text = clean(value).replace(/\/+$/, '');
    return text !== '' ? text : fallback;
  };
  return {
    baseUrl: trimmed(source.baseUrl, EXTERNAL_DEFAULTS.baseUrl),
    model: clean(source.model),
    embedBaseUrl: clean(source.embedBaseUrl).replace(/\/+$/, ''),
    embedModel: clean(source.embedModel),
    rerankBaseUrl: clean(source.rerankBaseUrl).replace(/\/+$/, ''),
    rerankModel: clean(source.rerankModel),
    apiKey: clean(source.apiKey),
    // Cloud services are often split across providers: the embedding endpoint
    // may be OpenAI while rerank is Cohere/Jina, so each can carry its own key.
    // Empty means "inherit the main apiKey" (see embedEndpoint/rerankEndpoint).
    embedApiKey: clean(source.embedApiKey),
    rerankApiKey: clean(source.rerankApiKey),
    timeoutMs: clampInt(source.timeoutMs, EXTERNAL_DEFAULTS.timeoutMs, EXTERNAL_BOUNDS.timeoutMs),
  };
}

/**
 * Split a configured base URL into the `/v1` API root and the bare server root.
 *
 * Users paste whatever their provider documents: `http://host:8080`,
 * `https://api.openai.com/v1`, or a full `.../v1/embeddings`. All of those
 * resolve to `{ api: '<root>/v1', server: '<root>' }`, so the caller can try the
 * versioned path first and the unversioned one second (TEI, some rerank servers).
 */
export function resolveBaseUrl(baseUrl) {
  let value = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (value === '') value = EXTERNAL_DEFAULTS.baseUrl;
  for (const suffix of ENDPOINT_SUFFIXES) {
    if (value.toLowerCase().endsWith(suffix)) {
      value = value.slice(0, -suffix.length).replace(/\/+$/, '');
      break;
    }
  }
  const hasV1 = /\/v1$/i.test(value);
  return {
    api: hasV1 ? value : `${value}/v1`,
    server: hasV1 ? value.slice(0, -'/v1'.length) : value,
  };
}

/** The embeddings endpoint actually used: its own base URL and model, or the defaults. */
export function embedEndpoint(config) {
  const baseUrl = config.embedBaseUrl !== undefined && config.embedBaseUrl !== ''
    ? String(config.embedBaseUrl).replace(/\/+$/, '')
    : config.baseUrl;
  const resolved = resolveBaseUrl(baseUrl);
  return {
    ...config,
    baseUrl,
    apiBase: resolved.api,
    serverBase: resolved.server,
    model: config.embedModel !== '' ? config.embedModel : config.model,
    apiKey: config.embedApiKey !== undefined && config.embedApiKey !== ''
      ? config.embedApiKey
      : config.apiKey,
  };
}

/** The rerank endpoint actually used: its own base URL and model, or the defaults. */
export function rerankEndpoint(config) {
  const baseUrl = config.rerankBaseUrl !== '' ? config.rerankBaseUrl : config.baseUrl;
  const resolved = resolveBaseUrl(baseUrl);
  return {
    ...config,
    baseUrl,
    apiBase: resolved.api,
    serverBase: resolved.server,
    model: config.rerankModel !== '' ? config.rerankModel : config.model,
    apiKey: config.rerankApiKey !== undefined && config.rerankApiKey !== ''
      ? config.rerankApiKey
      : config.apiKey,
  };
}

/** Resolve one config into its chat/API root for calls that use the main endpoint. */
function chatEndpoint(config) {
  const resolved = resolveBaseUrl(config.baseUrl);
  return { ...config, apiBase: resolved.api, serverBase: resolved.server };
}

function clampInt(value, fallback, bounds) {
  const [low, high] = bounds;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(high, Math.max(low, Math.round(number)));
}

/** True when the configured base URL points at a loopback host. */
export function isLoopbackBase(baseUrl) {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

/** Build the request for one endpoint without sending it. */
export function buildRequest(config, pathname, { method = 'POST', body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (config.apiKey !== '') headers.authorization = `Bearer ${config.apiKey}`;
  const apiBase = config.apiBase !== undefined && config.apiBase !== ''
    ? config.apiBase
    : resolveBaseUrl(config.baseUrl).api;
  return {
    url: `${apiBase}${pathname}`,
    init: {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  };
}

/** Chat-completion body: the OpenAI shape every compatible server accepts. */
export function buildChatBody(config, input = {}) {
  const messages = Array.isArray(input.messages) && input.messages.length > 0
    ? input.messages
      .filter((message) => message && typeof message.content === 'string')
      .map((message) => ({
        role: typeof message.role === 'string' && message.role !== '' ? message.role : 'user',
        content: message.content,
      }))
    : [
      ...(typeof input.system === 'string' && input.system !== '' ? [{ role: 'system', content: input.system }] : []),
      { role: 'user', content: String(input.prompt ?? '') },
    ];
  const body = {
    messages,
    stream: false,
  };
  // Single-model servers ignore `model`; hosted APIs need the real id, so only
  // send it when configured (the fallback name is for local servers' logs).
  body.model = config.model !== '' ? config.model : 'local';
  if (typeof input.temperature === 'number' && Number.isFinite(input.temperature)) {
    body.temperature = Math.min(2, Math.max(0, input.temperature));
  }
  if (Number.isInteger(input.maxTokens) && input.maxTokens > 0) body.max_tokens = input.maxTokens;
  if (input.json === true) body.response_format = { type: 'json_object' };
  return body;
}

/** Extract assistant text from a chat-completion payload. */
export function parseChatResponse(payload) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  let text = '';
  const content = choice?.message?.content;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('');
  } else if (typeof choice?.text === 'string') {
    // Legacy `/completions` shape, still returned by a few gateways.
    text = choice.text;
  }
  return {
    text,
    model: typeof payload?.model === 'string' ? payload.model : '',
    // Audit fields some providers return: request id and server-side creation
    // time. They make a generated summary traceable to one concrete call.
    id: typeof payload?.id === 'string' ? payload.id : '',
    created: Number.isFinite(payload?.created) ? Number(payload.created) : null,
    usage: payload?.usage && typeof payload.usage === 'object' ? payload.usage : null,
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : '',
  };
}

/**
 * Extract vectors from an embeddings payload (order preserved).
 *
 * Accepted shapes: OpenAI `{ data: [{ embedding }] }`, `{ embeddings: [[...]] }`
 * and the bare `[[...], [...]]` array returned by HuggingFace TEI.
 */
export function parseEmbeddingResponse(payload) {
  let rows = [];
  if (Array.isArray(payload?.data)) rows = payload.data;
  else if (Array.isArray(payload?.embeddings)) rows = payload.embeddings;
  else if (Array.isArray(payload)) rows = payload;
  const vectors = rows
    .map((row) => {
      const vector = Array.isArray(row?.embedding) ? row.embedding : Array.isArray(row) ? row : null;
      return vector === null ? null : vector.map(Number);
    })
    .filter((vector) => Array.isArray(vector) && vector.length > 0 && vector.every(Number.isFinite));
  return {
    vectors,
    model: typeof payload?.model === 'string' ? payload.model : '',
    usage: payload?.usage && typeof payload.usage === 'object' ? payload.usage : null,
  };
}

/** One JSON request against an absolute URL with a timeout; never throws. */
async function requestUrl(config, url, options = {}, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, status: 0, error: '当前运行环境没有 fetch，无法调用外部模型。' };
  }
  const headers = { 'content-type': 'application/json' };
  if (config.apiKey !== '') headers.authorization = `Bearer ${config.apiKey}`;
  const init = {
    method: options.method ?? 'POST',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const raw = await response.text();
    let payload = null;
    try {
      payload = raw === '' ? null : JSON.parse(raw);
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const detail = payload?.error?.message ?? payload?.error ?? raw.slice(0, ERROR_EXCERPT_CHARS);
      return {
        ok: false,
        status: response.status,
        error: `外部模型返回 ${response.status}：${String(detail).slice(0, ERROR_EXCERPT_CHARS)}`,
        payload,
      };
    }
    if (payload === null) {
      return { ok: false, status: response.status, error: '外部模型返回了非 JSON 响应。' };
    }
    return { ok: true, status: response.status, payload };
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { ok: false, status: 0, error: `外部模型超时（${config.timeoutMs}ms）。` };
    }
    const cause = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? String(error);
    return {
      ok: false,
      status: 0,
      error: `连不上外部模型 ${url}：${cause}`
        + (isLoopbackBase(url) ? '（该地址上的服务起了吗？llama.cpp / Ollama / LM Studio 等兼容服务需先启动）' : ''),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** One JSON request by path suffix (`/embeddings`, …); never throws. */
export async function requestJson(config, pathname, options = {}, fetchImpl = globalThis.fetch) {
  return requestUrl(config, buildRequest(config, pathname).url, options, fetchImpl);
}

/** Chat completion. Returns `{ ok, text, model, usage }` or `{ ok: false, error }`. */
export async function chat(config, input = {}, fetchImpl = globalThis.fetch) {
  const body = buildChatBody(config, input);
  if (body.messages.every((message) => message.content.trim() === '')) {
    return { ok: false, error: 'prompt 不能为空。' };
  }
  const target = chatEndpoint(config);
  const result = await requestJson(target, '/chat/completions', { body }, fetchImpl);
  if (!result.ok) return result;
  const parsed = parseChatResponse(result.payload);
  if (parsed.text === '') {
    return { ok: false, status: result.status, error: '外部模型返回了空回复。' };
  }
  return { ok: true, ...parsed };
}

/** Embedding vectors for text or an array of texts. */
export async function embed(config, input, fetchImpl = globalThis.fetch) {
  const texts = (Array.isArray(input) ? input : [input])
    .map((value) => String(value ?? ''))
    .filter((value) => value.trim() !== '');
  if (texts.length === 0) return { ok: false, error: 'embed 的输入不能为空。' };
  const target = embedEndpoint(config);
  const body = {
    input: texts.length === 1 ? texts[0] : texts,
    model: target.model !== '' ? target.model : 'local',
  };
  // `/v1/embeddings` first, then the unversioned `/embeddings` that TEI exposes.
  const attempts = [`${target.apiBase}/embeddings`];
  if (target.serverBase !== target.apiBase) attempts.push(`${target.serverBase}/embeddings`);
  let lastError = '';
  for (const url of attempts) {
    const result = await requestUrl(target, url, { body }, fetchImpl);
    if (!result.ok) {
      lastError = result.error;
      if (result.status !== 404 && result.status !== 405 && result.status !== 501) break;
      continue;
    }
    const parsed = parseEmbeddingResponse(result.payload);
    if (parsed.vectors.length !== texts.length) {
      return {
        ok: false,
        status: result.status,
        error: `外部模型返回 ${parsed.vectors.length} 个向量，期望 ${texts.length} 个`
          + '（确认该服务的 embeddings 接口返回 OpenAI 格式；llama.cpp 需要 --embeddings 启动）',
      };
    }
    return { ok: true, ...parsed };
  }
  return {
    ok: false,
    status: 0,
    error: `${lastError}（确认该服务的 /v1/embeddings 可用；llama.cpp 需要 --embeddings 启动）`,
  };
}

/**
 * Extract a rerank payload into `{ index, score }` rows sorted best-first.
 *
 * Accepted shapes: `{ results: [{ index, relevance_score }] }` (llama.cpp,
 * Cohere, Jina), `{ data: [{ index, score }] }`, or a bare array (TEI).
 */
export function parseRerankResponse(payload) {
  const rows = Array.isArray(payload?.results)
    ? payload.results
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload) ? payload : [];
  const results = [];
  for (const row of rows) {
    const index = Number(row?.index);
    const score = Number(row?.relevance_score ?? row?.score);
    if (!Number.isInteger(index) || !Number.isFinite(score)) continue;
    results.push({ index, score });
  }
  return results.sort((a, b) => b.score - a.score);
}

/**
 * Cross-encoder rerank: score `documents` against `query`.
 *
 * `/v1/rerank` and `/rerank` are both tried so versioned and unversioned
 * rerank servers work. Never throws: `{ ok:false, error }` means the caller
 * should keep its embedding-only ordering.
 */
export async function rerank(config, input = {}, fetchImpl = globalThis.fetch) {
  const query = String(input.query ?? '').trim();
  const documents = (Array.isArray(input.documents) ? input.documents : [])
    .map((value) => String(value ?? '').trim())
    .filter((value) => value !== '');
  if (query === '' || documents.length === 0) {
    return { ok: false, error: 'rerank 需要非空的 query 和 documents。' };
  }
  const target = rerankEndpoint(config);
  const body = {
    model: target.model !== '' ? target.model : 'local',
    query,
    documents,
  };
  if (Number.isInteger(input.topN) && input.topN > 0) body.top_n = input.topN;

  const attempts = [`${target.apiBase}/rerank`];
  if (target.serverBase !== target.apiBase) attempts.push(`${target.serverBase}/rerank`);
  let lastError = '';
  for (const url of attempts) {
    const result = await requestUrl(target, url, { body }, fetchImpl);
    if (!result.ok) {
      lastError = result.error;
      // A 404/405/501 means "this server doesn't expose that path"; try the other.
      if (result.status !== 404 && result.status !== 405 && result.status !== 501) break;
      continue;
    }
    const results = parseRerankResponse(result.payload);
    if (results.length === 0) {
      return { ok: false, status: result.status, error: 'rerank 返回了空结果。' };
    }
    return { ok: true, results, model: target.model };
  }
  return {
    ok: false,
    status: 0,
    error: `${lastError}（确认该服务支持 /v1/rerank 或 /rerank 且模型可重排；llama.cpp 需要 --reranking 启动）`,
  };
}

/** Model list from `/v1/models`. */
export async function listModels(config, fetchImpl = globalThis.fetch) {
  const target = chatEndpoint(config);
  const result = await requestJson(target, '/models', { method: 'GET' }, fetchImpl);
  if (!result.ok) return result;
  const rows = Array.isArray(result.payload?.data)
    ? result.payload.data
    : Array.isArray(result.payload) ? result.payload : [];
  return {
    ok: true,
    models: rows.map((row) => (typeof row?.id === 'string' ? row.id : '')).filter(Boolean),
  };
}

/**
 * Connectivity check: `/health` first (llama.cpp and friends), then `/v1/models`
 * (every OpenAI-compatible API). With `{ deep: true }` it also probes what the
 * endpoints can actually do (embeddings vs rerank), because those are separate
 * capabilities and the panel needs to say which one is missing. Never throws.
 */
export async function probe(config, fetchImpl = globalThis.fetch, options = {}) {
  const target = chatEndpoint(config);
  const healthUrl = `${target.serverBase}/health`;
  let verdict = null;
  const health = await requestUrl(target, healthUrl, { method: 'GET' }, fetchImpl);
  if (health.ok) {
    const status = health.payload?.status;
    verdict = {
      ok: true,
      via: 'health',
      detail: status === 'ok' || status === undefined ? 'API 在线' : `API 状态：${status}`,
    };
  } else {
    const models = await listModels(config, fetchImpl);
    if (models.ok) {
      verdict = {
        ok: true,
        via: 'models',
        detail: models.models.length > 0 ? `可用模型：${models.models.join('、')}` : 'API 在线（未列出模型）',
        models: models.models,
      };
    } else {
      verdict = { ok: false, error: models.error !== undefined ? models.error : health.error };
    }
  }

  const embedTarget = embedEndpoint(config);
  const rerankTarget = rerankEndpoint(config);
  const out = {
    ...verdict,
    baseUrl: config.baseUrl,
    endpoints: {
      chat: config.baseUrl,
      embeddings: embedTarget.baseUrl,
      rerank: rerankTarget.baseUrl,
    },
  };
  if (verdict.ok !== true || options.deep !== true) return out;

  const quick = { ...config, timeoutMs: Math.min(config.timeoutMs, 5000) };
  const embeddings = await embed(quick, 'ping', fetchImpl);
  const reranking = await rerank(quick, { query: 'ping', documents: ['a', 'b'], topN: 2 }, fetchImpl);
  out.capabilities = {
    embeddings: embeddings.ok ? { ok: true } : { ok: false, error: embeddings.error },
    rerank: reranking.ok ? { ok: true } : { ok: false, error: reranking.error },
  };
  return out;
}

/** One-line summary of the configured endpoints, used in tool output. */
export function describeEndpoint(config) {
  const embedTarget = embedEndpoint(config);
  const rerankTarget = rerankEndpoint(config);
  const parts = [`chat/默认 ${config.baseUrl}${config.model !== '' ? `（${config.model}）` : ''}`];
  if (embedTarget.baseUrl !== config.baseUrl || embedTarget.model !== config.model) {
    parts.push(`embed ${embedTarget.baseUrl}${embedTarget.model !== '' ? `（${embedTarget.model}）` : ''}`);
  }
  if (rerankTarget.baseUrl !== config.baseUrl || rerankTarget.model !== config.model) {
    parts.push(`rerank ${rerankTarget.baseUrl}${rerankTarget.model !== '' ? `（${rerankTarget.model}）` : ''}`);
  }
  return `${parts.join('｜')}｜超时 ${config.timeoutMs}ms`
    + (config.apiKey !== '' ? '｜已带 API Key' : '');
}
