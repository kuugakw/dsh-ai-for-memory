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
    const bare = wanted.replace(/\/+$/, '');
    const variants = new Set([wanted, bare, `/${wanted}`, `/${bare}`]);
    const present = text
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .some((line) => variants.has(line));
    if (present) return { changed: false, reason: 'already-ignored', file, entry: wanted };
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
  const entry = ignoreEntryFor(directoryName);
  if (entry === '') return { changed: false, reason: 'invalid-directory' };
  const expected = path.resolve(workspace, directoryName);
  const actual = path.resolve(root);
  if (actual !== expected) return { changed: false, reason: 'custom-root' };
  if (fs.existsSync(actual)) return { changed: false, reason: 'already-created' };
  return ensureGitignoreEntry(workspace, entry);
}
