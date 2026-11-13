/**
 * Context archiving: turn a conversation window into a durable context record
 * that can be restored into a later step.
 *
 * This is the piece that makes the plugin a context-window tool rather than a
 * note taker: `buildContextSnapshot` captures completed turns before the
 * session is compacted, and `formatRestore` renders the archive back into a
 * model-facing message.
 */

import { textOfMessage } from './auto.js';
import { clip } from './util.js';

/**
 * Collect completed turns from committed session events.
 *
 * @param {Array<{type: string, data: object}>} events
 * @param {{maxChars?: number, maxPerMessage?: number}} [options]
 * @returns {{turns: Array, text: string, turnFrom: number, turnTo: number,
 *   turnCount: number, chars: number}|null}
 */
export function buildContextSnapshot(events, options = {}) {
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0
    ? options.maxChars : 30000;
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
        assistant: '',
      };
    } else if (event.type === 'user/message' && current) {
      const text = textOfMessage(data);
      if (text) current.user = current.user ? `${current.user}\n${text}` : text;
    } else if (event.type === 'assistant/message' && current) {
      const text = textOfMessage(data.message ?? data);
      if (text) current.assistant = text;
    } else if (event.type === 'turn/end' && current) {
      if (Number.isInteger(data.turn)) current.turn = data.turn;
      if (current.user || current.assistant) {
        current.user = clip(current.user, maxPerMessage);
        current.assistant = clip(current.assistant, maxPerMessage);
        turns.push(current);
      }
      current = null;
    }
  }

  // A save/clear can run before the current turn closes (for example on the
  // first turn of a session). That in-flight turn is exactly the context the
  // caller wants to preserve, so include it.
  if (current && (current.user || current.assistant)) {
    current.user = clip(current.user, maxPerMessage);
    current.assistant = clip(current.assistant, maxPerMessage);
    turns.push(current);
  }

  if (turns.length === 0) return null;

  // Keep the newest turns that fit; clearing context is about the recent
  // working set, and a huge early turn must not push out everything newer.
  const selected = [];
  let total = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const size = turn.user.length + turn.assistant.length;
    if (selected.length > 0 && total + size > maxChars) break;
    selected.unshift(turn);
    total += size;
    if (total >= maxChars) break;
  }

  const text = selected.map((turn) => {
    const lines = [`[第 ${turn.turn} 轮]`];
    if (turn.user) lines.push(`用户：${turn.user}`);
    if (turn.assistant) lines.push(`助手：${turn.assistant}`);
    return lines.join('\n');
  }).join('\n\n');

  return {
    turns: selected,
    text: clip(text, maxChars),
    turnFrom: selected[0].turn,
    turnTo: selected[selected.length - 1].turn,
    turnCount: selected.length,
    chars: text.length,
  };
}

/** Render a stored context record for injection into a later step. */
export function formatRestoreContext(record) {
  return [
    `[记忆恢复 · ${record.context_id} · 第 ${record.turn_from}-${record.turn_to} 轮 · ${record.created_at}]`,
    '以下是从存储中恢复的历史上下文，可能已过时，请结合当前对话使用：',
    '',
    record.text,
    '',
    '[记忆恢复结束]',
  ].join('\n');
}
