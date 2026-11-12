/**
 * Thesis / antithesis / synthesis review for risky decisions.
 *
 * Ported from AI for Memory with the same auditability goal: the weights
 * are computed from the reason lengths and risk multiplier, returned to the
 * caller, and stored with the decision so a later reviewer can recompute them.
 */

import crypto from 'node:crypto';

/** Risk multiplier applied to the antithesis share. */
export const RISK_MULTIPLIER = Object.freeze({ low: 1.0, medium: 1.2, high: 1.5 });

/** High-risk decisions need `risk_adjusted_score <= 0.3` to pass. */
export const HIGH_RISK_THRESHOLD = 0.3;

/** Medium-risk decisions need `antithesis_weight <= 0.5` to pass. */
export const MEDIUM_RISK_THRESHOLD = 0.5;

/** Create a decision id that is also safe as a filename. */
export function newDecisionId() {
  return `decision_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Evaluate one decision.
 *
 * @param {{decision: string, risk?: 'low'|'medium'|'high', thesis?: string, antithesis?: string}} input
 * @param {{reviewHighRiskOnly?: boolean}} [options]
 * @returns {object} the review record; `outcome` is approved / rejected / needs_more_info.
 */
export function evaluateDecision(input, options = {}) {
  const decision = String(input?.decision ?? '').trim();
  if (decision === '') throw new Error('decision 必须为非空字符串');

  const risk = input?.risk ?? 'low';
  if (!(risk in RISK_MULTIPLIER)) {
    throw new Error(`risk 必须是 low / medium / high，收到：${risk}`);
  }

  const thesis = String(input?.thesis ?? '').trim();
  const antithesis = String(input?.antithesis ?? '').trim();
  const reviewHighRiskOnly = options.reviewHighRiskOnly !== false;

  const base = {
    decision_id: newDecisionId(),
    decision,
    risk_level: risk,
    thesis,
    antithesis,
    timestamp: new Date().toISOString(),
  };

  // Low risk never spends a review; medium risk is auto-approved unless the
  // deployment explicitly opted into reviewing it.
  if (risk === 'low' || (risk === 'medium' && reviewHighRiskOnly)) {
    return {
      ...base,
      reviewed: false,
      approved: true,
      outcome: 'approved',
      weights: {
        thesis_weight: 1,
        antithesis_weight: 0,
        risk_adjusted_score: 0,
        risk_multiplier: RISK_MULTIPLIER[risk],
        risk_level: risk,
        thesis_length: thesis.length,
        antithesis_length: antithesis.length,
        auto_approved: true,
      },
      reason: `${risk} 风险决策在当前配置下无需审查，自动放行`,
    };
  }

  // A review without both sides would be invented reasoning; refuse it.
  if (thesis === '' || antithesis === '') {
    return {
      ...base,
      reviewed: true,
      approved: false,
      outcome: 'needs_more_info',
      weights: {
        thesis_weight: 0,
        antithesis_weight: 0,
        risk_adjusted_score: 0,
        risk_multiplier: RISK_MULTIPLIER[risk],
        risk_level: risk,
        thesis_length: thesis.length,
        antithesis_length: antithesis.length,
      },
      reason: '缺少正面和/或反面理由，无法完成正反合审查；请补充 thesis 与 antithesis 后重试',
    };
  }

  const thesisLength = thesis.length;
  const antithesisLength = antithesis.length;
  const total = thesisLength + antithesisLength;
  const thesisWeight = thesisLength / total;
  const antithesisWeight = antithesisLength / total;
  const riskAdjustedScore = antithesisWeight * RISK_MULTIPLIER[risk];
  const threshold = risk === 'high' ? HIGH_RISK_THRESHOLD : MEDIUM_RISK_THRESHOLD;
  const approved = risk === 'high'
    ? riskAdjustedScore <= threshold
    : antithesisWeight <= threshold;

  return {
    ...base,
    reviewed: true,
    approved,
    outcome: approved ? 'approved' : 'rejected',
    weights: {
      thesis_weight: round4(thesisWeight),
      antithesis_weight: round4(antithesisWeight),
      risk_adjusted_score: round4(riskAdjustedScore),
      risk_multiplier: RISK_MULTIPLIER[risk],
      risk_level: risk,
      thesis_length: thesisLength,
      antithesis_length: antithesisLength,
      threshold,
    },
    reason: risk === 'high'
      ? `反对强度 risk_adjusted_score=${round4(riskAdjustedScore)}，阈值 ${threshold}`
      : `反对理由占比 antithesis_weight=${round4(antithesisWeight)}，阈值 ${threshold}`,
  };
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}
