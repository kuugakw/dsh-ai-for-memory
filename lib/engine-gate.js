/**
 * Reachability gate for automatic local-engine starts.
 *
 * A local llama.cpp engine is the fallback for "no endpoint configured" and
 * "the configured endpoint is down". When the user already runs a service — the
 * usual manually managed llama-server, another tool, or a cloud provider — and
 * it answers, starting a second process on another port duplicates it. The
 * lifecycle therefore skips a model whose kind already has a reachable
 * configured endpoint.
 *
 * "Reachable" means the HTTP service answers at all: a 401/404 still proves
 * something is listening, so only a connection failure or timeout counts as
 * down. Probes are short (1.2 s per path) and cached briefly because the caller
 * runs on every model request.
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
  // rerank, so it counts as configured for this kind too.
  return String(source.externalBaseUrl ?? '').trim();
}

export const ENDPOINT_PROBE_TIMEOUT_MS = 1200;
export const ENDPOINT_PROBE_TTL_MS = 30000;

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

  const attempt = (url) => Promise.resolve()
    .then(() => fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) }))
    .then((response) => {
      // Release the body; an unread body can keep the socket busy.
      try {
        const draining = response?.arrayBuffer?.();
        if (draining && typeof draining.catch === 'function') draining.catch(() => {});
      } catch { /* ignore */ }
      return true;
    })
    .catch(() => false);

  const probe = async (base) => {
    const resolved = resolveBaseUrl(base);
    // OpenAI-compatible services answer /v1/models; llama.cpp additionally
    // answers /health. A bare server root catches everything else (TEI etc.).
    if (resolved.api !== '' && await attempt(`${resolved.api}/models`)) return true;
    if (resolved.server !== '' && await attempt(`${resolved.server}/health`)) return true;
    if (resolved.server !== '' && await attempt(resolved.server)) return true;
    return false;
  };

  return {
    /**
     * True only when a configured endpoint exists AND answers. An empty
     * configuration is "not reachable" so the local engine may start; a
     * configured endpoint that answers suppresses the start.
     */
    async configuredEndpointReachable(kind, config) {
      const base = configuredEndpointBase(config, kind);
      if (base === '') return false;
      const cached = cache.get(base);
      if (cached !== undefined && Date.now() - cached.at < ttlMs) return cached.promise;
      const promise = probe(base);
      cache.set(base, { at: Date.now(), promise });
      return promise;
    },
  };
}
