/**
 * Automatic mode: turn a finished conversation window into one digest entry.
 *
 * The listener receives committed Session events, so nothing here needs the
 * model to call a tool. Only completed turns are considered; a digest is built
 * from the last `rounds` turns that actually carry text.
 */

import { clip } from './util.js';

/** Extract text blocks from a user or assistant message. */
export function textOfMessage(message) {
  if (!message || typeof message !== 'object') return '';
  const content = message.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * Build a compact digest of the last N completed turns.
 *
 * @param {Array<{type: string, data: object}>} events - committed session events.
 * @param {number} rounds - how many completed turns to include.
 * @returns {string|null} the digest text, or null when nothing useful exists.
 */
export function collectTurnDigest(events, rounds) {
  const complete = [];
  let current = null;

  for (const event of events ?? []) {
    if (!event || typeof event.type !== 'string') continue;
    const data = event.data ?? {};
    if (event.type === 'turn/start') {
      current = { turn: Number.isInteger(data.turn) ? data.turn : complete.length + 1, user: '', assistant: '' };
    } else if (event.type === 'user/message' && current) {
      const text = textOfMessage(data);
      if (text) current.user = current.user ? `${current.user}\n${text}` : text;
    } else if (event.type === 'assistant/message' && current) {
      // Keep the last assistant text of the turn; tool calls are noise here.
      const text = textOfMessage(data.message ?? data);
      if (text) current.assistant = text;
    } else if (event.type === 'turn/end' && current) {
      if (Number.isInteger(data.turn)) current.turn = data.turn;
      if (current.user || current.assistant) complete.push(current);
      current = null;
    }
  }

  const selected = complete.slice(-Math.max(1, rounds));
  if (selected.length === 0) return null;

  const first = selected[0].turn;
  const last = selected[selected.length - 1].turn;
  const lines = [`自动记忆 · 第 ${first}-${last} 轮`];
  for (const turn of selected) {
    if (turn.user) lines.push(`[用户] ${clip(turn.user, 240)}`);
    if (turn.assistant) lines.push(`[助手] ${clip(turn.assistant, 400)}`);
  }
  return lines.join('\n');
}
