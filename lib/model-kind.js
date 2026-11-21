/**
 * Best-effort classification of a GGUF filename.
 *
 * This is only a hint for the panel: names are not a contract. The user can
 * always override the inferred kind; an empty result means "ask the user".
 */

export function inferModelKind(filename) {
  const name = String(filename ?? '').toLowerCase();
  if (name === '') return '';
  // Rerank first: "jina-reranker" also contains a substring some embedding
  // heuristics would match.
  if (/(^|[-_. ])rerank|reranker|cross[-_ ]?encoder/.test(name)) return 'Rerank';
  if (/(^|[-_. ])embedding|embed(ding)?|bge-m3|bge[-_ ]?m3|(^|[-_. ])e5[-_.]|gte[-_.]|jina[-_.]embeddings|qwen.*embed/.test(name)) {
    return 'Embedding';
  }
  return '';
}
