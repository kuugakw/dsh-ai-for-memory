/**
 * Reachability gate for automatic local-engine starts.
 *
 * A local llama.cpp engine is the fallback for "no endpoint configured" and
 * "the configured endpoint is down". When the user already runs a service — the
 * usual manually managed llama-server, another tool, or a cloud provider — and
 * it serves the same kind, starting a second process on another port duplicates
 * it. The lifecycle therefore skips a model whose kind already has a usable
 * configured endpoint.
 *
 * "Usable" is not "something is listening": a chat-only endpoint (401/404 on
 * `/v1/embeddings`) must not suppress the local engine. For a base URL that is
 * only the main-endpoint fallback (no `externalEmbedBaseUrl` /
 * `externalRerankBaseUrl`), the gate proves the kind capability first: llama.cpp
 * answers `/props` with `has_embeddings` / `has_reranking`, and everything else
 * is asked with one tiny request to the real endpoint. A URL named explicitly
 * for the kind is trusted once it answers, because the user said what it is.
 *
 * Probes are short (1.2 s per path) and cached briefly: a dead endpoint should
 * stop blocking local starts within seconds, not half a minute.
 */

import { resolveBaseUrl } from './external.js';

/** The user's configured base URL for one kind, or '' when none is set. */
export function configuredEndpointBase(config, kind) {
  const source = config ?? {};
  const own = kind === 'embedding'
    ? String(source.externalEmbedBaseUrl ?? '').trim()
    : String(source.externalRerankBaseUrl ?? '').trim();
  if (own !== '') return own;
  // The external client falls back to the main endpoint for both embed and
  // rerank; the value can still answer, but the gate has to prove the kind.
  return String(source.externalBaseUrl ?? '').trim();
}

/** True when the kind has its own URL, not just the main-endpoint fallback. */
export function configuredEndpointIsDedicated(config, kind) {
  const source = config ?? {};
  const own = kind === 'embedding'
    ? source.externalEmbedBaseUrl
    : source.externalRerankBaseUrl;
  return String(own ?? '').trim() !== '';
}

export const ENDPOINT_PROBE_TIMEOUT_MS = 1200;
export const ENDPOINT_PROBE_TTL_MS = 5000;

function credentialFor(config, kind) {
  const source = config ?? {};
  const own = kind === 'embedding'
    ? source.externalEmbedApiKey
    : source.externalRerankApiKey;
  const key = String(own ?? '').trim();
  return key !== '' ? key : String(source.externalApiKey ?? '').trim();
}

function modelFor(config, kind) {
  const source = config ?? {};
  const own = kind === 'embedding'
    ? source.externalEmbedModel
    : source.externalRerankModel;
  const model = String(own ?? '').trim();
  return model !== '' ? model : String(source.externalModel ?? '').trim();
}

/**
 * @param {{fetchImpl?: Function, timeoutMs?: number, ttlMs?: number}} [options]
 *   `fetchImpl` is injectable for tests; defaults to the runtime fetch.
 */
export function createEndpointGate(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : ENDPOINT_PROBE_TIMEOUT_MS;
  const ttlMs = Number.isInteger(options.ttlMs) && options.ttlMs >= 0
    ? options.ttlMs
    : ENDPOINT_PROBE_TTL_MS;
  /** @type {Map<string, {at: number, promise: Promise<boolean>}>} */
  const cache = new Map();

  const request = async (url, init = {}) => {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    // Release the body; an unread body can keep the socket busy.
    try {
      const draining = response?.arrayBuffer?.();
      if (draining && typeof draining.catch === 'function') draining.catch(() => {});
    } catch { /* ignore */ }
    return response;
  };

  const attempt = (url) => request(url).then((response) => {
    // A 401/404/500 still proves something is listening. For a URL the user
    // named for this kind that is enough; capability is checked below.
    return response !== undefined && response !== null;
  }).catch(() => false);

  const propsOf = async (serverBase, headers) => {
    if (serverBase === '') return null;
    try {
      const response = await request(`${serverBase}/props`, { headers });
      if (!response?.ok) return null;
      if (typeof response.json === 'function') return await response.json();
      if (typeof response.text === 'function') return JSON.parse(await response.text());
      return null;
    } catch {
      return null;
    }
  };

  /** Does this endpoint really serve `kind`, not just any HTTP route? */
  const probeKind = async (base, kind, config) => {
    const resolved = resolveBaseUrl(base);
    const key = credentialFor(config, kind);
    const headers = key === '' ? {} : { authorization: `Bearer ${key}` };
    const model = modelFor(config, kind);

    // llama.cpp reports the enabled capability on /props; an explicit boolean
    // settles it without running a model.
    const props = await propsOf(resolved.server, headers);
    const flag = kind === 'embedding' ? props?.has_embeddings : props?.has_reranking;
    if (flag === true) return true;
    if (flag === false) return false;

    // Everything else: ask the real endpoint with the smallest possible body.
    // 2xx means the capability is there; 401/404/500 does not.
    const suffix = kind === 'embedding' ? 'embeddings' : 'rerank';
    const body = kind === 'embedding'
      ? { input: 'ping', model: model !== '' ? model : 'local' }
      : { model: model !== '' ? model : 'local', query: 'ping', documents: ['a', 'b'], top_n: 1 };
    const ask = async (url) => {
      try {
        const response = await request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        });
        return response?.ok === true;
      } catch {
        return false;
      }
    };
    if (await ask(`${resolved.api}/${suffix}`)) return true;
    return resolved.server !== resolved.api && await ask(`${resolved.server}/${suffix}`);
  };

  /** Any answer at all: used only for URLs explicitly named for the kind. */
  const probeAlive = async (base) => {
    const resolved = resolveBaseUrl(base);
    if (resolved.api !== '' && await attempt(`${resolved.api}/models`)) return true;
    if (resolved.server !== '' && await attempt(`${resolved.server}/health`)) return true;
    if (resolved.server !== '' && await attempt(resolved.server)) return true;
    return false;
  };

  return {
    /**
     * True only when a configured endpoint exists AND can serve this kind. An
     * empty configuration is "not reachable" so the local engine may start; a
     * chat-only endpoint is not reachable for embeddings either.
     */
    async configuredEndpointReachable(kind, config) {
      const base = configuredEndpointBase(config, kind);
      if (base === '') return false;
      const dedicated = configuredEndpointIsDedicated(config, kind);
      // The same base means different things per kind and per source: an
      // explicitly named URL is trusted once alive, a fallback must prove the
      // capability, so they must not share one cache entry.
      const cacheKey = `${kind}:${dedicated ? 'own' : 'fallback'}:${base}`;
      const cached = cache.get(cacheKey);
      if (cached !== undefined && Date.now() - cached.at < ttlMs) return cached.promise;
      const promise = dedicated ? probeAlive(base) : probeKind(base, kind, config);
      cache.set(cacheKey, { at: Date.now(), promise });
      return promise;
    },
  };
}
