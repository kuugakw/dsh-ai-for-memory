/**
 * Route embedding/rerank work to a running local llama.cpp engine when the
 * corresponding configured endpoint is absent (or still points at an old
 * loopback port). A configured cloud endpoint always wins.
 *
 * This is intentionally a read-time fallback: starting/stopping an engine
 * changes the next call without rewriting the user's profile.
 */

import { isLoopbackBase } from './external.js';
import { localEngineStatus } from './local-engine.js';

function statusFor(kind) {
  return localEngineStatus().find((engine) => engine.ready === true
    && String(engine.kind ?? '').toLowerCase() === kind) ?? null;
}

export function localModelRouting() {
  const embedding = statusFor('embedding');
  const rerank = statusFor('rerank');
  return {
    embedding: embedding ? { baseUrl: embedding.baseUrl, model: embedding.model, id: embedding.id } : null,
    rerank: rerank ? { baseUrl: rerank.baseUrl, model: rerank.model, id: rerank.id } : null,
  };
}

function pick(base, model, local) {
  const configuredBase = String(base ?? '').trim();
  if (!local) return { base, model };
  if (configuredBase === '' || isLoopbackBase(configuredBase)) {
    return { base: local.baseUrl, model: local.model };
  }
  return { base, model };
}

/** Return a config whose Embedding/Rerank endpoint fields prefer live local engines. */
export function effectivePluginConfig(config) {
  const routing = localModelRouting();
  const embed = pick(config.externalEmbedBaseUrl, config.externalEmbedModel, routing.embedding);
  const rerank = pick(config.externalRerankBaseUrl, config.externalRerankModel, routing.rerank);
  return {
    ...config,
    externalEmbedBaseUrl: embed.base,
    externalEmbedModel: embed.model || config.externalEmbedModel,
    externalRerankBaseUrl: rerank.base,
    externalRerankModel: rerank.model || config.externalRerankModel,
  };
}
