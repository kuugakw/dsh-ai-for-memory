// @ts-check
/**
 * Thesis / antithesis / synthesis review for risky decisions.
 *
 * Lengths are still reported for audit, but they are **not** the gate. A model
 * can make any statement win by writing more words, so the old ratio-based
 * threshold rewarded padded theses and punished honest risk analysis. The gate
 * is now a structural one: the caller must state whether the action is
 * irreversible, and a reversible action must name how to recover.
 */

import crypto from 'node:crypto';

/** Risk multiplier kept only for the audit trail; it no longer decides. */
export const RISK_MULTIPLIER = Object.freeze({ low: 1.0, medium: 1.2, high: 1.5 });

/** Create a decision id that is also safe as a filename. */
export function newDecisionId() {
  return `decision_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Evaluate one decision.
 *
 * @param {{decision: string, risk?: 'low'|'medium'|'high', thesis?: string,
 *   antithesis?: string, irreversible?: boolean, recoverable_via?: string, [key: string]: any}} input
 * @param {{reviewHighRiskOnly?: boolean, [key: string]: any}} [options]
 * @returns {any} the review record; `outcome` is approved / rejected / needs_more_info.
 */
export function evaluateDecision(input, options = /** @type {any} */ ({})) {
  const decision = String(input?.decision ?? '').trim();
  if (decision === '') throw new Error('decision 必须为非空字符串');

  const risk = input?.risk ?? 'low';
  // `in` walks the prototype chain, so `toString` / `__proto__` would pass and
  // be recorded as a legal risk level. Only own string keys of the table are
  // valid labels.
  if (typeof risk !== 'string' || !Object.hasOwn(RISK_MULTIPLIER, risk)) {
    throw new Error(`risk 必须是 low / medium / high，收到：${String(risk)}`);
  }

  const thesis = String(input?.thesis ?? '').trim();
  const antithesis = String(input?.antithesis ?? '').trim();
  const irreversible = typeof input?.irreversible === 'boolean' ? input.irreversible : null;
  const recoverableVia = String(input?.recoverable_via ?? '').trim();
  const reviewHighRiskOnly = options.reviewHighRiskOnly !== false;

  const base = {
    decision_id: newDecisionId(),
    decision,
    risk_level: risk,
    thesis,
    antithesis,
    irreversible,
    recoverable_via: recoverableVia,
    timestamp: new Date().toISOString(),
  };

  // A caller that marks the action irreversible cannot have it auto-approved,
  // whatever risk label it used: the declared flags must at least agree, and
  // honoring `irreversible=true` is the one part of the risk assessment this
  // gate can check structurally. A caller that marks a destructive action
  // "low" *and* "irreversible=false" is still believed — the whole gate is
  // caller-declared; that trust boundary is documented in docs/features.md.
  if (irreversible === true) {
    return {
      ...base,
      reviewed: true,
      approved: false,
      outcome: 'rejected',
      weights: auditWeights(thesis, antithesis, risk, { gate: 'reversibility' }),
      reason: '操作被标记为不可逆（irreversible=true），高风险审查拒绝放行；'
        + '请先拆成可恢复的小步骤，或由用户明确授权。',
    };
  }

  // Low risk never spends a review; medium risk is auto-approved unless the
  // deployment explicitly opted into reviewing it.
  if (risk === 'low' || (risk === 'medium' && reviewHighRiskOnly)) {
    return {
      ...base,
      reviewed: false,
      approved: true,
      outcome: 'approved',
      weights: auditWeights(thesis, antithesis, risk, {
        auto_approved: true,
        gate: 'auto',
      }),
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
      weights: auditWeights(thesis, antithesis, risk, { gate: 'missing-sides' }),
      reason: '缺少正面和/或反面理由，无法完成正反合审查；请补充 thesis 与 antithesis 后重试',
    };
  }

  const weights = auditWeights(thesis, antithesis, risk, { gate: 'reversibility' });

  if (irreversible === null) {
    return {
      ...base,
      reviewed: true,
      approved: false,
      outcome: 'needs_more_info',
      weights,
      reason: '缺少 irreversible（true/false）。高风险闸门不再按理由长度判断，'
        + '请明确操作是否可逆；可逆时还要给出 recoverable_via。',
    };
  }

  if (recoverableVia === '') {
    return {
      ...base,
      reviewed: true,
      approved: false,
      outcome: 'needs_more_info',
      weights,
      reason: 'irreversible=false 但缺少 recoverable_via；请写明如何回滚/恢复（备份、快照、重新部署等）。',
    };
  }

  return {
    ...base,
    reviewed: true,
    approved: true,
    outcome: 'approved',
    weights,
    reason: `irreversible=false，可恢复路径：${recoverableVia}`,
  };
}

/**
 * Length-based numbers are retained for the audit log only. They are never
 * compared to a threshold; changing the wording cannot change the outcome.
 */
function auditWeights(thesis, antithesis, risk, extra) {
  const thesisLength = thesis.length;
  const antithesisLength = antithesis.length;
  const total = thesisLength + antithesisLength;
  const thesisWeight = total > 0 ? thesisLength / total : 0;
  const antithesisWeight = total > 0 ? antithesisLength / total : 0;
  return {
    thesis_weight: round4(thesisWeight),
    antithesis_weight: round4(antithesisWeight),
    risk_adjusted_score: round4(antithesisWeight * RISK_MULTIPLIER[risk]),
    risk_multiplier: RISK_MULTIPLIER[risk],
    risk_level: risk,
    thesis_length: thesisLength,
    antithesis_length: antithesisLength,
    advisory_only: true,
    ...extra,
  };
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}
