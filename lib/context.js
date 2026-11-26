/**
 * Context archiving: turn a conversation window into a durable context record
 * that can be restored into a later step, and pick the turns that a
 * similarity-aware clear is allowed to remove.
 *
 * This is the piece that makes the plugin a context-window tool rather than a
 * note taker: `collectTurns` reads completed turns (with the session event
 * sequences they occupy), `snapshotOfTurns` records exactly the turns being
 * removed so `restore` can bring them back, and `formatRestoreContext` renders
 * the archive back into a model-facing message.
 */

import { textOfMessage } from './auto.js';
import { tagMemory } from './egress.js';
import { clip } from './util.js';

/** Event types that occupy a position on the model-visible surface. */
const SURFACE_EVENT_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
]);

/** Tool output is archived raw, but this is how much of one result a restore renders. */
const TOOL_RESULT_RENDER_LIMIT = 8 * 1024;

/**
 * Trim one tool result to the render limit, keeping its head and saying so.
 *
 * The raw event row stored in `contexts/` stays complete; only the restored
 * text is capped, mirroring the `truncated` marker used elsewhere.
 */
function capToolResult(text) {
  if (Buffer.byteLength(text, 'utf8') <= TOOL_RESULT_RENDER_LIMIT) return text;
  const marker = `\n…（工具结果已截断，原 ${text.length} 字符）`;
  const room = Math.max(0, TOOL_RESULT_RENDER_LIMIT - Buffer.byteLength(marker, 'utf8'));
  const head = Buffer.from(text, 'utf8').subarray(0, room).toString('utf8')
    .replace(/\uFFFD+$/u, '');
  return `${head}${marker}`;
}

/**
 * Collect completed turns from committed session events.
 *
 * Each turn carries **every** session event sequence it occupies (`seqs`), not
 * just the text-bearing ones: a live turn interleaves prompt refreshes
 * (`system/message`) and tool-catalog updates (`developer/message`) between
 * user, assistant and tool events. Clear-time range replacement must cover all
 * of them, and leaving any out would make the turn look non-contiguous and
 * therefore unclearable.
 *
 * Events from a real session always carry `seq`; plain fixtures may omit it, in
 * which case `seqs` stays empty and surface-aware clearing skips that turn
 * instead of guessing.
 *
 * @param {Array<{type: string, data: object, seq?: number}>} events
 * @param {{maxPerMessage?: number}} [options]
 * @returns {Array<{turn: number, user: string, assistant: string, text: string,
 *   chars: number, seqs: number[]}>} oldest first
 */
export function collectTurns(events, options = {}) {
  const maxPerMessage = Number.isInteger(options.maxPerMessage) && options.maxPerMessage > 0
    ? options.maxPerMessage : 4000;

  const turns = [];
  let current = null;
  for (const event of events ?? []) {
    if (!event || typeof event.type !== 'string') continue;
    const data = event.data ?? {};
    if (event.type === 'turn/start') {
      current = {
        turn: Number.isInteger(data.turn) ? data.turn : turns.length + 1,
        user: '',
        notices: [],
        assistant: '',
        seqs: [],
      };
      continue;
    }
    if (!current) continue;

    // Every surface node inside the turn belongs to its range — including the
    // ones that carry no text of their own.
    if (SURFACE_EVENT_TYPES.has(event.type) && Number.isInteger(event.seq)) {
      current.seqs.push(event.seq);
    }

    if (event.type === 'user/message') {
      const text = textOfMessage(data);
      if (text) {
        if (data?.source?.kind === 'ai-for-memory') {
          // Plugin notices are model-visible but they are not the user's own
          // words. Keep them in the archive as notices, never in `turn.user`,
          // which is the input to knowledge mining and "user rule" candidates.
          current.notices.push(text);
        } else {
          current.user = current.user ? `${current.user}\n${text}` : text;
        }
      }
    } else if (event.type === 'assistant/message') {
      const text = textOfMessage(data.message ?? data);
      if (text) current.assistant = text;
    } else if (event.type === 'turn/end') {
      if (Number.isInteger(data.turn)) current.turn = data.turn;
      if (current.user || current.assistant || current.notices.length > 0) {
        current.user = clip(current.user, maxPerMessage);
        current.notices = current.notices.map((notice) => clip(notice, maxPerMessage));
        current.assistant = clip(current.assistant, maxPerMessage);
        current.text = [current.user, ...current.notices, current.assistant]
          .filter(Boolean).join('\n');
        current.chars = current.text.length;
        turns.push(current);
      }
      current = null;
    }
  }

  // A save/clear can run before the current turn closes (for example on the
  // first turn of a session). That in-flight turn is exactly the context the
  // caller wants to preserve, so include it — but it is never a clear
  // candidate, because its surface range is still growing.
  if (current && (current.user || current.assistant || current.notices.length > 0)) {
    current.user = clip(current.user, maxPerMessage);
    current.notices = current.notices.map((notice) => clip(notice, maxPerMessage));
    current.assistant = clip(current.assistant, maxPerMessage);
    current.text = [current.user, ...current.notices, current.assistant]
      .filter(Boolean).join('\n');
    current.chars = current.text.length;
    current.inFlight = true;
    turns.push(current);
  }

  return turns;
}

/** Render one turn as the text a context record stores. */
function formatTurn(turn) {
  const lines = [`[第 ${turn.turn} 轮]`];
  if (turn.user) lines.push(`用户：${turn.user}`);
  if (Array.isArray(turn.notices) && turn.notices.length > 0) {
    lines.push(`便条：${turn.notices.join('\n')}`);
  }
  if (turn.assistant) lines.push(`助手：${turn.assistant}`);
  return lines.join('\n');
}

/**
 * Render one context archive as a readable Markdown document. This is the
 * human escape hatch when the original session log cannot be opened: the
 * archived turns are kept even when the LLM surface is gone.
 */
export function formatContextMarkdown(record) {
  if (!record || typeof record !== 'object') return '# Context archive\n\n(empty archive)\n';
  const lines = [`# Context archive ${String(record.context_id ?? '')}`.trim()];
  const meta = [
    typeof record.label === 'string' && record.label !== '' ? `label: ${record.label}` : '',
    typeof record.created_at === 'string' && record.created_at !== '' ? `created: ${record.created_at}` : '',
    Number.isInteger(record.turn_from) ? `turns: ${record.turn_from}-${record.turn_to}` : '',
    Number.isFinite(record.chars) ? `chars: ${record.chars}` : '',
  ].filter(Boolean);
  if (meta.length > 0) lines.push('', meta.join(' · '));
  const turns = Array.isArray(record.turns) ? record.turns : [];
  for (const turn of turns) {
    lines.push('', `## Turn ${turn.turn ?? '?'}`);
    if (typeof turn.user === 'string' && turn.user !== '') lines.push('', '**User**', '', turn.user);
    for (const notice of Array.isArray(turn.notices) ? turn.notices : []) {
      if (typeof notice === 'string' && notice !== '') {
        lines.push('', '> Notice', '>', ...notice.split('\n').map((line) => `> ${line}`));
      }
    }
    if (typeof turn.assistant === 'string' && turn.assistant !== '') {
      lines.push('', '**Assistant**', '', turn.assistant);
    }
  }
  if (turns.length === 0 && typeof record.text === 'string' && record.text !== '') {
    lines.push('', record.text);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Render raw events as ordered segments.
 *
 * Unlike `collectTurns`, this keeps `tool/call` arguments and
 * `developer/message` rows. Tool results are present but capped at 8 KiB here;
 * the stored `raw_events` field itself is untouched.
 */
function renderRawSegments(events) {
  const segments = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event.type !== 'string') continue;
    const data = event.data ?? {};
    if (event.type === 'turn/start') {
      const turn = Number.isInteger(data.turn) ? data.turn : '?';
      segments.push(`[第 ${turn} 轮]`);
      continue;
    }
    if (event.type === 'developer/message') {
      const text = textOfMessage(data.message ?? data);
      if (text !== '') segments.push(`开发者：${text}`);
      continue;
    }
    if (event.type === 'user/message') {
      const text = textOfMessage(data);
      if (text !== '') segments.push(`用户：${text}`);
      continue;
    }
    if (event.type === 'assistant/message') {
      const text = textOfMessage(data.message ?? data);
      if (text !== '') segments.push(`助手：${text}`);
      continue;
    }
    if (event.type === 'tool/call') {
      const name = typeof data.name === 'string' && data.name !== '' ? data.name : 'tool';
      const args = typeof data.arguments === 'string'
        ? data.arguments
        : JSON.stringify(data.arguments ?? {});
      segments.push(`工具调用：${name} ${args}`.trimEnd());
      continue;
    }
    if (event.type === 'tool/result') {
      const text = textOfMessage(data.message ?? data)
        || (typeof data.content === 'string' ? data.content.trim() : '');
      if (text !== '') segments.push(`工具结果：${capToolResult(text)}`);
    }
  }
  return segments;
}

/**
 * Build a context record from an explicit turn list.
 *
 * Clearing uses this to archive **exactly** the turns it is about to remove.
 * `maxChars: Infinity` keeps such a record complete, which is what makes
 * "deleted content is always restorable" a guarantee rather than a hope.
 *
 * @param {Array<object>} turns - oldest first.
 * @param {{maxChars?: number}} [options]
 * @returns {{turns: Array<object>, text: string, turnFrom: number, turnTo: number,
 *   turnCount: number, chars: number}|null}
 */
export function snapshotOfTurns(turns, options = {}) {
  const list = Array.isArray(turns) ? turns.filter((turn) => turn && Number.isInteger(turn.turn)) : [];
  if (list.length === 0) return null;
  const maxChars = typeof options.maxChars === 'number' && options.maxChars > 0
    ? options.maxChars : 30000;
  const text = clip(list.map(formatTurn).join('\n\n'), maxChars);
  return {
    turns: list,
    text,
    turnFrom: list[0].turn,
    turnTo: list[list.length - 1].turn,
    turnCount: list.length,
    chars: text.length,
  };
}

/**
 * Build the archive of a conversation window: the newest turns that fit.
 *
 * Clearing context is about the recent working set, and a huge early turn must
 * not push out everything newer.
 *
 * @param {Array<{type: string, data: object}>} events
 * @param {{maxChars?: number, maxPerMessage?: number}} [options]
 * @returns {{turns: Array, text: string, turnFrom: number, turnTo: number,
 *   turnCount: number, chars: number}|null}
 */
export function buildContextSnapshot(events, options = {}) {
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0
    ? options.maxChars : 30000;
  const turns = collectTurns(events, options);
  if (turns.length === 0) return null;

  const selected = [];
  let total = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const size = turn.chars ?? 0;
    if (selected.length > 0 && total + size > maxChars) break;
    selected.unshift(turn);
    total += size;
    if (total >= maxChars) break;
  }

  const snapshot = snapshotOfTurns(selected, { maxChars });
  return snapshot;
}

/** Render one stored turn, falling back to its rendered text when needed. */
function formatRestoreTurn(turn) {
  const rendered = formatTurn(turn);
  if (rendered === `[第 ${turn.turn} 轮]` && typeof turn.text === 'string' && turn.text !== '') {
    return `[第 ${turn.turn} 轮]\n${turn.text}`;
  }
  return rendered;
}

/**
 * Select the newest rendered lines that fit the restore budget.
 *
 * Walk backwards so the tail is what survives; if the newest line alone is
 * larger than the budget, keep the tail of that line rather than its head.
 */
function tailLines(rawText, maxChars) {
  const lines = rawText.split('\n');
  const selected = [];
  let total = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const separator = selected.length > 0 ? 1 : 0;
    if (total + separator + line.length <= maxChars) {
      selected.unshift(line);
      total += separator + line.length;
      continue;
    }
    if (selected.length === 0 && line !== '') {
      selected.unshift(line.slice(-maxChars));
    }
    break;
  }
  return {
    body: selected.join('\n'),
    kept: selected.length,
    total: lines.length,
    truncated: selected.length < lines.length,
  };
}

/**
 * Render a context record for injection without refilling the whole window.
 *
 * A clear may archive up to `maxContextChars`, but restoring that entire
 * archive immediately would undo the clear. Keep the newest turns that fit the
 * restore budget; the archive itself is never mutated, so a later restore can
 * still recover the rest.
 *
 * @param {object} record
 * @param {{maxChars?: number}} [options]
 * @returns {string}
 */
export function formatRestoreContext(record, options = {}) {
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0
    ? options.maxChars : 12000;
  const allTurns = Array.isArray(record?.turns)
    ? record.turns.filter((turn) => turn && Number.isInteger(turn.turn))
    : [];
  let body;
  let note = '';
  const rawSegments = renderRawSegments(record?.raw_events);
  if (rawSegments.length > 0) {
    // Raw events keep tool calls/results and developer messages, but the
    // restore budget still starts from the newest line and keeps only the
    // tail. The archive stays complete on disk.
    const tail = tailLines(rawSegments.join('\n'), maxChars);
    body = tail.body;
    if (tail.truncated) {
      note = `按 ${maxChars} 字符预算恢复最近 ${tail.kept}/${tail.total} 段`;
    }
  } else if (allTurns.length > 0) {
    const selected = [];
    let total = 0;
    for (let index = allTurns.length - 1; index >= 0; index -= 1) {
      const turn = allTurns[index];
      const rendered = formatRestoreTurn(turn);
      const separator = selected.length > 0 ? 2 : 0;
      if (selected.length > 0 && total + separator + rendered.length > maxChars) break;
      selected.unshift(turn);
      total += separator + rendered.length;
    }
    body = selected.map(formatRestoreTurn).join('\n\n');
    if (selected.length < allTurns.length) {
      note = `按 ${maxChars} 字符预算恢复最近 ${selected.length}/${allTurns.length} 轮`;
    }
  } else {
    const fullText = typeof record?.text === 'string' ? record.text : '';
    if (fullText.length > maxChars) {
      body = fullText.slice(-maxChars);
      note = `按 ${maxChars} 字符预算恢复最近内容（只保留尾部）`;
    } else {
      body = fullText;
    }
  }
  if (body.length > maxChars) {
    // A single segment/turn can exceed the budget; keep the tail everywhere,
    // not just in the raw-events branch.
    body = body.slice(-maxChars);
    if (note === '') note = `按 ${maxChars} 字符预算恢复最近内容（只保留尾部）`;
  }
  const title = `[记忆恢复 · ${record?.context_id ?? '未知'} · 第 ${record?.turn_from ?? '?'}-${record?.turn_to ?? '?'} 轮 · ${record?.created_at ?? '未知时间'}`
    + (note !== '' ? ` · ${note}` : '') + ']';
  // Tagged, not wrapped: the caller (aim_context restore) renders the boundary
  // together with its own note. String interpolation of the tag throws.
  return tagMemory('aim_context restore', [
    title,
    '以下是从存储中恢复的历史上下文，可能已过时，请结合当前对话使用：',
    '',
    body,
    '',
    '[记忆恢复结束]',
  ].join('\n'));
}
