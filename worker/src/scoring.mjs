export const SCORE_VERSION = 'vp-score-3-jobs';

export const WEIGHTS = Object.freeze({
  hook: 0.20,
  scroll_stop: 0.10,
  clarity: 0.10,
  rhythm: 0.10,
  retention: 0.15,
  structure: 0.10,
  text_captions: 0.05,
  visual: 0.05,
  audio: 0.05,
  cta: 0.05,
  originality: 0.05
});

const clamp = value => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

export function scoreAnalysis(analysis) {
  const scores = analysis?.scores || {};
  const evidence = analysis?.score_evidence || {};
  let weighted = 0;
  const guardrails = [];

  for (const [key, weight] of Object.entries(WEIGHTS)) {
    const value = clamp(scores[key]);
    weighted += value * weight;
    const proof = String(evidence[key] || '').trim();
    if (!proof || /^INDETECTABLE$/i.test(proof)) {
      weighted -= weight * 5;
      guardrails.push(`${key}: preuve observable insuffisante`);
    }
    if (value >= 85 && proof.length < 35) {
      weighted -= 1.5;
      guardrails.push(`${key}: score élevé plafonné faute de preuve détaillée`);
    }
  }

  const finalScore = clamp(weighted);
  return {
    final_score: finalScore,
    score_version: SCORE_VERSION,
    guardrails,
    explanation: 'Score calculé à partir de critères Viral+ normalisés. Les pondérations sont propriétaires et ne représentent pas les poids privés des plateformes.'
  };
}
