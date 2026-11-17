/**
 * Context-pressure helpers.
 *
 * DSH's `tokenMeter` service reports the latest logged provider prompt size
 * (`pressureTokens`) together with the routed model's capacity (`contextWindow`).
 * Both fields stay absent until a real request has been recorded, so every helper
 * here treats "not measured yet" as `null` rather than as 0%: an unmeasured
 * conversation must never look like an empty one.
 */

/** Percentage of the window in use (one decimal), or `null` when unmeasured. */
export function usagePercentOf(pressure) {
  const used = Number(pressure?.pressureTokens);
  const capacity = Number(pressure?.contextWindow);
  if (!Number.isFinite(used) || !Number.isFinite(capacity) || capacity <= 0 || used < 0) return null;
  return Math.round((used / capacity) * 1000) / 10;
}

/**
 * True when the measured usage has reached `percent` of the context window.
 * An unmeasured session or a non-positive threshold never triggers.
 */
export function exceedsUsageThreshold(pressure, percent) {
  const ratio = usagePercentOf(pressure);
  if (ratio === null) return false;
  const threshold = Number(percent);
  if (!Number.isFinite(threshold) || threshold <= 0) return false;
  return ratio >= threshold;
}

/** One human-readable line for tool output and the compaction log. */
export function formatPressure(pressure) {
  const percent = usagePercentOf(pressure);
  if (percent === null) return '未知（还没有请求记录）';
  return `${percent}%（${Math.round(Number(pressure.pressureTokens))}/${Math.round(Number(pressure.contextWindow))} tokens）`;
}
