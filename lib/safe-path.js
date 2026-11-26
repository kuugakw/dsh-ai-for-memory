// @ts-check
/**
 * One resolver for "the requested path must stay inside this directory".
 *
 * Export targets, repair inputs and anything else that takes a
 * model-controlled path used to carry their own copy of the checks (absolute
 * path, drive letter, `..`, resolved prefix, symlink re-check). One
 * implementation means a new feature reuses the same four rejections instead
 * of re-deriving them — and the tests only have to prove this one.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve `requested` under `root` without allowing it to leave.
 *
 * @param {string} root - absolute directory the result must stay inside
 * @param {string} requested - model- or user-supplied relative path
 * @returns {{ok: true, rel: string, full: string} | {ok: false, error: string}}
 */
export function resolveRelativeWithin(root, requested) {
  const base = path.resolve(root);
  if (typeof requested !== 'string') {
    return { ok: false, error: '路径必须是字符串' };
  }
  const raw = requested.trim();
  if (raw === '') return { ok: true, rel: '.', full: base };
  if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) {
    return { ok: false, error: `不接受绝对路径或盘符：${raw}` };
  }
  const rel = path.normalize(raw);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return { ok: false, error: `不能跳到目录之外：${raw}` };
  }
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(`${base}${path.sep}`)) {
    return { ok: false, error: `必须位于该目录内：${raw}` };
  }
  return { ok: true, rel, full };
}

/**
 * True when `target` resolves (after symlinks) inside `base`.
 *
 * The caller creates intermediate directories first: a symlink that already
 * exists inside the allowed tree must not turn a "safe" relative path into a
 * write somewhere else.
 */
export function realPathInside(base, target) {
  try {
    const realBase = fs.realpathSync(base);
    const realTarget = fs.realpathSync(target);
    return realTarget === realBase || realTarget.startsWith(`${realBase}${path.sep}`);
  } catch {
    return false;
  }
}
