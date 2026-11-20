/**
 * Keep the default per-workspace memory directory out of the user's Git repo.
 *
 * The plugin stores full conversation archives under `.ai-for-memory/` inside
 * the project. Its own `.gitignore` cannot protect the user's repository, so
 * when that directory is first created we append it to an existing project
 * `.gitignore`. We never create a `.gitignore` (the user asked us only to edit
 * an existing one) and never touch it for a custom `root`.
 */

import fs from 'node:fs';
import path from 'node:path';

/** One relative ignore entry, always with a trailing slash for a directory. */
function ignoreEntryFor(directoryName) {
  const name = String(directoryName ?? '').replace(/\\/g, '/').replace(/^\.\/+|\/+$/g, '');
  if (name === '' || name.includes('/')) return '';
  return `${name}/`;
}

/** True when one of the accepted variants is already a line in the file. */
function hasIgnoreEntry(text, wanted) {
  const bare = wanted.replace(/\/+$/, '');
  const variants = new Set([wanted, bare, `/${wanted}`, `/${bare}`]);
  return String(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .some((line) => variants.has(line));
}

/**
 * Read-only protection status for the default memory directory.
 *
 * This is what the panel and `aim_memory status` can call without mutating a
 * project. `ensure...` still performs the append; this only reports whether
 * the archive is currently covered and why not.
 */
export function defaultMemoryDirIgnoreStatus(root, workspace, directoryName = '.ai-for-memory') {
  const entry = ignoreEntryFor(directoryName);
  if (entry === '') return { state: 'invalid-directory', warning: '' };
  const expected = path.resolve(workspace, directoryName);
  const actual = path.resolve(root);
  if (actual !== expected) return { state: 'custom-root', warning: '' };
  const file = path.join(path.resolve(workspace), '.gitignore');
  if (!fs.existsSync(file)) {
    return {
      state: 'no-gitignore',
      file,
      entry,
      warning: `项目没有 .gitignore，默认记忆目录 ${entry} 未被忽略；新建 .gitignore 并加入 ${entry}，否则 git add . 可能把对话全文提交进仓库。`,
    };
  }
  try {
    if (!fs.statSync(file).isFile()) {
      return { state: 'not-a-file', file, entry, warning: `.gitignore 不是普通文件，无法自动确认 ${entry} 已被忽略。` };
    }
    if (hasIgnoreEntry(fs.readFileSync(file, 'utf8'), entry)) {
      return { state: 'ignored', file, entry, warning: '' };
    }
    if (fs.existsSync(actual)) {
      return {
        state: 'already-created',
        file,
        entry,
        warning: `记忆目录已创建，但 ${entry} 不在 .gitignore 中；请手动加入，避免对话全文被 git add . 提交。`,
      };
    }
    return {
      state: 'not-ignored',
      file,
      entry,
      warning: `${entry} 尚未写入 .gitignore；下次创建记忆目录前会自动追加，当前仍未受保护。`,
    };
  } catch (error) {
    return { state: 'error', file, entry, warning: `无法读取 .gitignore：${error?.message ?? error}` };
  }
}

/**
 * Append one entry to an existing `.gitignore` unless it is already covered.
 *
 * Exact variants (`dir/`, `dir`, `/dir/`, `/dir`) count as present, so we do
 * not add a duplicate just because the user wrote it with a leading slash.
 *
 * @returns {{changed: boolean, reason: string, file?: string, entry?: string}}
 */
export function ensureGitignoreEntry(workspace, entry) {
  const file = path.join(path.resolve(workspace), '.gitignore');
  const wanted = String(entry ?? '').trim();
  if (wanted === '') return { changed: false, reason: 'empty-entry', file };
  try {
    if (!fs.existsSync(file)) return { changed: false, reason: 'no-gitignore', file, entry: wanted };
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { changed: false, reason: 'not-a-file', file, entry: wanted };
    const text = fs.readFileSync(file, 'utf8');
    if (hasIgnoreEntry(text, wanted)) return { changed: false, reason: 'already-ignored', file, entry: wanted };
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const separator = text === '' || text.endsWith('\n') ? '' : newline;
    fs.appendFileSync(file, `${separator}${wanted}${newline}`, 'utf8');
    return { changed: true, reason: 'appended', file, entry: wanted };
  } catch (error) {
    return { changed: false, reason: 'error', file, entry: wanted, error: error?.message ?? String(error) };
  }
}

/**
 * Auto-ignore only the default `<workspace>/<directoryName>` root, and only
 * before that root exists (i.e. the first creation). Custom absolute roots are
 * outside the project and must not rewrite the project `.gitignore`.
 */
export function ensureDefaultMemoryDirIgnored(root, workspace, directoryName = '.ai-for-memory') {
  const status = defaultMemoryDirIgnoreStatus(root, workspace, directoryName);
  if (status.state === 'custom-root' || status.state === 'invalid-directory') {
    return { changed: false, reason: status.state, warning: status.warning };
  }
  if (status.state === 'no-gitignore' || status.state === 'not-a-file' || status.state === 'already-created') {
    return { changed: false, reason: status.state, file: status.file, entry: status.entry, warning: status.warning };
  }
  if (status.state === 'ignored') {
    return { changed: false, reason: 'already-ignored', file: status.file, entry: status.entry, warning: '' };
  }
  if (status.state === 'error') {
    return { changed: false, reason: 'error', file: status.file, entry: status.entry, warning: status.warning };
  }
  const result = ensureGitignoreEntry(workspace, status.entry);
  return { ...result, warning: '' };
}
