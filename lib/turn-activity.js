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

/** Destructive shell commands, treated as high risk only. */
const DESTRUCTIVE_COMMAND = /(\brm\b|\bdel\b|\brd\b|\brmdir\b|remove-item|\bformat\b|\brmdir\b|shutdown|\bkill\b)/i;

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
 * @param {Array<{type: string, data?: object}>} events - committed session events.
 * @param {string} sessionId
 * @param {number|null} [requestedTurn] - the `turn/end` turn; inferred when absent.
 * @returns {object|null} a decision record, or null when the turn called no tool.
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
    if (typeof call.args?.command === 'string' && DESTRUCTIVE_COMMAND.test(call.args.command)) {
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
    `风险按工具类型推断：${risk === 'high' ? 'high（删除/移动类操作）' : risk === 'medium' ? 'medium（写文件）' : 'low（只读）'}。`,
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
