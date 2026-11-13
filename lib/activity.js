/**
 * Process-local conversation activity.
 *
 * The plugin cannot ask DSH "which conversation is the user looking at", so it
 * keeps a small in-memory map of conversations that actually did something
 * (a finished turn or a memory tool call). The panel uses the newest entry as
 * the default conversation; nothing here is persisted, and it resets on reload.
 */

const ACTIVITY_CAP = 200;

/** Remember that a conversation was active. Never throws, never touches disk. */
export function markActivity(runtime, sessionId) {
  if (!runtime || typeof sessionId !== 'string' || sessionId === '') return;
  if (!(runtime.activity instanceof Map)) runtime.activity = new Map();
  const map = runtime.activity;
  map.delete(sessionId);
  map.set(sessionId, Date.now());
  if (map.size > ACTIVITY_CAP) {
    for (const id of [...map.keys()].slice(0, map.size - ACTIVITY_CAP)) map.delete(id);
  }
}

/** Session id with the newest recorded activity, or `''`. */
export function recentSessionId(runtime) {
  const map = runtime?.activity;
  if (!(map instanceof Map) || map.size === 0) return '';
  let best = '';
  let bestTime = -1;
  for (const [id, time] of map) {
    if (time > bestTime) {
      best = id;
      bestTime = time;
    }
  }
  return best;
}
