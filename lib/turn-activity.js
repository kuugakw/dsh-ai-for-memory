/**
 * Per-turn activity → decision layer.
 *
 * The decision layer answers “why was this chosen”; these records add “what was
 * actually executed”: which tools ran, which of them failed, and which local
 * files were read or modified. They are written automatically at `turn/end`,
 * marked `outcome: 'observed'`, and are deliberately **not** mined into
 * knowledge — an activity log is not a reviewed decision.
 *
 * Everything is derived from the committed session events; no tool call is
 * needed and no model is consulted.
 */

import { clip, hash8 } from './util.js';

/** Tools that write, move or delete local files. */
const WRITE_TOOL = /(write|edit|patch|create|delete|remove|rename|move|chmod|truncate|touch)/i;

/** Tools that only read local files. */
const READ_TOOL = /(read|view|glob|grep|list|search|find|cat|stat)/i;

/** File mutations that cannot be recovered by re-editing. */
const DESTRUCTIVE_TOOL = /(delete|remove|rename|move|chmod|truncate)/i;

/** Destructive shell commands, classified by executable position, not substrings. */
const DESTRUCTIVE_COMMANDS = new Set([
  'rm', 'rmdir', 'unlink', 'shred', 'mv', 'move', 'del', 'erase', 'rd',
  'remove-item', 'move-item', 'rename-item', 'format', 'format-volume',
  'diskpart', 'shutdown', 'reboot', 'kill', 'pkill', 'killall', 'taskkill',
  'stop-process', 'truncate',
]);
const COMMAND_WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'nohup', 'time', 'builtin', 'exec']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'cmd', 'powershell', 'pwsh']);
const OPTION_VALUES = new Set(['-u', '-g', '-p', '-U', '--user', '--group', '-C', '-c', '--git-dir', '--work-tree']);

function splitShellSegments(command) {
  const segments = [];
  let current = '';
  let quote = '';
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote !== '') {
      current += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '\\' && index + 1 < command.length) {
      current += char + command[index + 1];
      index += 1;
      continue;
    }
    if (char === ';' || char === '\n') {
      if (current.trim() !== '') segments.push(current);
      current = '';
      continue;
    }
    if ((char === '&' || char === '|') && command[index + 1] === char) {
      if (current.trim() !== '') segments.push(current);
      current = '';
      index += 1;
      continue;
    }
    if (char === '&' || char === '|') {
      if (current.trim() !== '') segments.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') segments.push(current);
  return segments;
}

function shellWords(segment) {
  const words = [];
  let current = '';
  let quote = '';
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (quote !== '') {
      if (char === quote) quote = '';
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current !== '') {
        words.push(current);
        current = '';
      }
      continue;
    }
    if (char === '\\' && index + 1 < segment.length) {
      current += segment[index + 1];
      index += 1;
      continue;
    }
    current += char;
  }
  if (current !== '') words.push(current);
  return words;
}

function executableOf(word) {
  return String(word ?? '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
}

function stripCommandPrefix(words) {
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      index += 1;
      continue;
    }
    const executable = executableOf(word);
    if (!COMMAND_WRAPPERS.has(executable)) break;
    index += 1;
    while (index < words.length) {
      const next = words[index];
      if (next.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(next)) {
        if (OPTION_VALUES.has(next) && index + 1 < words.length) index += 1;
        index += 1;
        continue;
      }
      break;
    }
  }
  return words.slice(index);
}

function gitIsDestructive(words) {
  let index = 1;
  while (index < words.length) {
    const word = words[index];
    if (OPTION_VALUES.has(word) && index + 1 < words.length) {
      index += 2;
      continue;
    }
    if (word.startsWith('-')) {
      index += 1;
      continue;
    }
    const subcommand = word.toLowerCase();
    if (subcommand === 'rm' || subcommand === 'mv' || subcommand === 'clean') return true;
    if (subcommand === 'reset' && words.slice(index + 1).some((arg) => arg === '--hard' || arg === '--merge')) {
      return true;
    }
    if ((subcommand === 'branch' || subcommand === 'tag')
      && words.slice(index + 1).some((arg) => ['-d', '-D', '--delete'].includes(arg))) {
      return true;
    }
    if (subcommand === 'stash' && words[index + 1] === 'drop') return true;
    return false;
  }
  return false;
}

function segmentIsDestructive(segment, depth = 0) {
  if (depth > 3) return false;
  const words = stripCommandPrefix(shellWords(segment));
  if (words.length === 0) return false;
  const executable = executableOf(words[0]);
  if (DESTRUCTIVE_COMMANDS.has(executable)) return true;
  if (executable === 'git') return gitIsDestructive(words);

  if (SHELLS.has(executable)) {
    const flagIndex = words.findIndex((word) => ['-c', '/c', '-command', '--command'].includes(word.toLowerCase()));
    if (flagIndex !== -1 && flagIndex + 1 < words.length) {
      return isDestructiveShellCommand(words.slice(flagIndex + 1).join(' '), depth + 1);
    }
  }
  if (executable === 'xargs') {
    const rest = words.slice(1).filter((word) => !word.startsWith('-'));
    return rest.length > 0 && segmentIsDestructive(rest.join(' '), depth + 1);
  }
  if (executable === 'find') {
    if (words.includes('-delete')) return true;
    const execIndex = words.findIndex((word) => word === '-exec' || word === '-execdir');
    if (execIndex !== -1) {
      const rest = words.slice(execIndex + 1).filter((word) => word !== '{}' && word !== ';' && word !== '+');
      return rest.length > 0 && segmentIsDestructive(rest.join(' '), depth + 1);
    }
  }
  return false;
}

/**
 * Classify only command positions in a shell line. Arguments such as
 * `git log --format=...` or `grep "rm"` are not commands and stay low risk.
 */
export function isDestructiveShellCommand(command, depth = 0) {
  const text = String(command ?? '');
  if (text.trim() === '') return false;
  return splitShellSegments(text).some((segment) => segmentIsDestructive(segment, depth));
}

/** Argument keys that carry a file path. */
const PATH_KEYS = Object.freeze([
  'file_path', 'filePath', 'path', 'file', 'target', 'destination', 'dest',
  'old_path', 'new_path', 'paths', 'files',
]);

/** Cap each file list in the one-line summary; the full detail stays in `files`. */
const SUMMARY_FILES = 3;

function parseArguments(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function pushPath(list, seen, value) {
  const text = typeof value === 'string' ? value.trim().replace(/^["'`]|["'`]$/g, '') : '';
  if (text === '' || text.length > 300) return;
  // A path should not contain a newline; keep it to something a user can scan.
  if (text.includes('\n')) return;
  if (seen.has(text)) return;
  seen.add(text);
  list.push(text);
}

/** Extract file paths from one tool call's arguments. */
function pathsOf(args) {
  const paths = [];
  if (!args || typeof args !== 'object') return paths;
  const seen = new Set();
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === 'string') pushPath(paths, seen, value);
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') pushPath(paths, seen, item);
        else if (item && typeof item === 'object') {
          pushPath(paths, seen, item.path ?? item.file_path ?? item.file ?? item.target);
        }
      }
    }
  }
  // The patch tools carry the targets inside the patch text, not in a key.
  const patch = typeof args.patch === 'string' ? args.patch
    : (typeof args.input === 'string' ? args.input : '');
  if (patch !== '') {
    for (const line of patch.split(/\r?\n/)) {
      const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line.trim());
      if (match) pushPath(paths, seen, match[1]);
    }
  }
  return paths;
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function resultFailed(data) {
  if (data?.isError === true || data?.error === true) return true;
  if (typeof data?.error === 'string' && data.error !== '') return true;
  const text = textOfContent(data?.message?.content ?? data?.content).trim();
  return /^(error|错误|failed|失败)[:：\s]/i.test(text);
}

/**
 * Summarize one turn's tool activity.
 *
 * @param {Array<{type: string, data?: any}>} events - committed session events.
 * @param {string} sessionId
 * @param {number|null} [requestedTurn] - the `turn/end` turn; inferred when absent.
 * @returns {any|null} a decision record, or null when the turn called no tool.
 */
export function summarizeTurnActivity(events, sessionId = '', requestedTurn = null) {
  const list = Array.isArray(events) ? events : [];
  let turn = Number.isInteger(requestedTurn) ? requestedTurn : null;
  if (turn === null) {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const event = list[index];
      if (event?.type === 'turn/end' && Number.isInteger(event.data?.turn)) {
        turn = event.data.turn;
        break;
      }
    }
  }
  if (turn === null) return null;

  const calls = [];
  for (const event of list) {
    if (!event || Number.isInteger(event.data?.turn) === false || event.data.turn !== turn) continue;
    if (event.type !== 'assistant/message') continue;
    const content = event.data?.message?.content ?? event.data?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== 'tool-call') continue;
      const name = typeof block.name === 'string' && block.name !== '' ? block.name : 'tool';
      calls.push({ id: typeof block.id === 'string' ? block.id : '', name, args: parseArguments(block.arguments ?? block.input) });
    }
  }
  if (calls.length === 0) return null;

  const failures = new Map();
  const callById = new Map(calls.filter((call) => call.id !== '').map((call) => [call.id, call]));
  for (const event of list) {
    if (!event || event.type !== 'tool/result') continue;
    if (Number.isInteger(event.data?.turn) === false || event.data.turn !== turn) continue;
    if (!resultFailed(event.data)) continue;
    const id = event.data?.message?.toolCallId ?? event.data?.tool_call_id ?? event.data?.call_id;
    const name = callById.get(id)?.name ?? 'tool';
    failures.set(name, (failures.get(name) ?? 0) + 1);
  }

  const counts = new Map();
  const modified = [];
  const read = [];
  const modifiedSeen = new Set();
  const readSeen = new Set();
  let destructive = false;
  for (const call of calls) {
    counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
    if (DESTRUCTIVE_TOOL.test(call.name)) destructive = true;
    const paths = pathsOf(call.args);
    if (WRITE_TOOL.test(call.name)) {
      for (const path of paths) pushPath(modified, modifiedSeen, path);
    } else if (READ_TOOL.test(call.name)) {
      for (const path of paths) pushPath(read, readSeen, path);
    }
    if (typeof call.args?.command === 'string' && isDestructiveShellCommand(call.args.command)) {
      destructive = true;
    }
  }

  const failedTotal = [...failures.values()].reduce((sum, value) => sum + value, 0);
  const risk = destructive ? 'high' : (modified.length > 0 ? 'medium' : 'low');
  const toolLine = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([name, count]) => `${name}×${count}`)
    .join('、');
  const fileLine = modified.length > 0
    ? `；修改 ${modified.length} 个文件：${modified.slice(0, SUMMARY_FILES).join('、')}`
      + (modified.length > SUMMARY_FILES ? ` 等 ${modified.length} 个` : '')
    : '';
  const failedLine = failedTotal > 0 ? `；失败 ${failedTotal} 次` : '';
  const decision = `第 ${turn} 轮：调用 ${calls.length} 次工具（${toolLine}）${fileLine}${failedLine}`;

  const reasonParts = [
    '自动记录（未做正反合审查）。',
    `工具：${toolLine}；失败：${failedTotal} 次。`,
    modified.length > 0 ? `修改文件：${clip(modified.join('、'), 300)}。` : '未修改本地文件。',
    read.length > 0 ? `读取文件：${clip(read.join('、'), 300)}。` : '',
    `风险按工具类型推断：${risk === 'high' ? 'high（删除、移动或终止类操作）' : risk === 'medium' ? 'medium（写文件）' : 'low（只读）'}。`,
  ].filter((part) => part !== '');

  return {
    decision_id: `decision_auto_t${turn}_${hash8(`${sessionId}:${turn}`)}`,
    kind: 'turn-activity',
    decision,
    risk_level: risk,
    thesis: '',
    antithesis: '',
    irreversible: null,
    recoverable_via: '',
    timestamp: new Date().toISOString(),
    outcome: 'observed',
    reviewed: false,
    approved: true,
    reason: reasonParts.join(''),
    weights: { gate: 'auto-observed', advisory_only: true },
    turn,
    tools: [...counts.entries()].map(([name, count]) => ({
      name,
      count,
      failed: failures.get(name) ?? 0,
    })),
    files: { modified, read },
  };
}
