/**
 * Pulse Score Calculator.
 *
 * Aggregates the three category scores into a single 0–100 "Pulse Score" and
 * derives a letter grade, a percentage breakdown per category, and a
 * human-readable summary with actionable priorities.
 *
 * Design constraint: the scorer must remain a pure function — no I/O, no side
 * effects. All three category results are already computed by the time this runs.
 */

// Grade thresholds, evaluated top-to-bottom (first match wins).
const GRADE_SCALE = [
  { min: 95, grade: 'A+' },
  { min: 90, grade: 'A'  },
  { min: 85, grade: 'A-' },
  { min: 80, grade: 'B+' },
  { min: 75, grade: 'B'  },
  { min: 70, grade: 'B-' },
  { min: 65, grade: 'C+' },
  { min: 60, grade: 'C'  },
  { min: 55, grade: 'C-' },
  { min: 50, grade: 'D'  },
  { min: 0,  grade: 'F'  },
];

function toGrade(score) {
  return GRADE_SCALE.find(t => score >= t.min)?.grade ?? 'F';
}

function pct(score, max) {
  return Math.round((score / max) * 100);
}

/**
 * @param {{ score, maxScore }} llmResult
 * @param {{ score, maxScore }} securityResult
 * @param {{ score, maxScore }} seoResult
 * @returns {{ overall, grade, breakdown, summary }}
 */
export function calculatePulseScore(llmResult, securityResult, seoResult) {
  const totalRaw = llmResult.score + securityResult.score + seoResult.score;
  const totalMax = llmResult.maxScore + securityResult.maxScore + seoResult.maxScore;
  const overall  = Math.round((totalRaw / totalMax) * 100);
  const grade    = toGrade(overall);

  const breakdown = {
    llmReadiness: {
      score:      llmResult.score,
      maxScore:   llmResult.maxScore,
      percentage: pct(llmResult.score, llmResult.maxScore),
    },
    security: {
      score:      securityResult.score,
      maxScore:   securityResult.maxScore,
      percentage: pct(securityResult.score, securityResult.maxScore),
    },
    enterpriseSeo: {
      score:      seoResult.score,
      maxScore:   seoResult.maxScore,
      percentage: pct(seoResult.score, seoResult.maxScore),
    },
  };

  const summary = buildSummary(overall, grade, llmResult, securityResult, seoResult);

  return { overall, grade, breakdown, summary };
}

function buildSummary(overall, grade, llm, security, seo) {
  const criticalIssues    = [];
  const topRecommendations = [];

  // Flag categories that are performing at less than half their potential.
  if (llm.score < llm.maxScore * 0.5) {
    criticalIssues.push('LLM/RAG readiness is critically low — AI crawlers may be blocked or content is unstructured');
  }
  if (security.score < security.maxScore * 0.5) {
    criticalIssues.push('Security posture is critically weak — core HTTP security headers are missing');
  }
  if (seo.score < seo.maxScore * 0.5) {
    criticalIssues.push('Core SEO signals are largely absent — search engine and social media visibility is severely impacted');
  }

  // Prioritised recommendation based on the weakest category.
  const categories = [
    { name: 'LLM Readiness', pct: pct(llm.score, llm.maxScore) },
    { name: 'Security',      pct: pct(security.score, security.maxScore) },
    { name: 'Enterprise SEO', pct: pct(seo.score, seo.maxScore) },
  ].sort((a, b) => a.pct - b.pct);

  const weakest = categories[0];
  if (weakest.pct < 80) {
    topRecommendations.push(
      `Prioritise "${weakest.name}" — currently at ${weakest.pct}% of its maximum score`
    );
  }

  // Contextual framing based on overall band.
  if (overall >= 85) {
    topRecommendations.push(
      'Excellent architectural health. Close the remaining gaps for full LLM-era readiness.'
    );
  } else if (overall >= 65) {
    topRecommendations.push(
      'Good foundation. Address security headers and LLM crawler access to reach the next tier.'
    );
  } else if (overall >= 45) {
    topRecommendations.push(
      'Significant gaps present. Focus on security headers first (highest risk), then LLM access, then SEO metadata.'
    );
  } else {
    topRecommendations.push(
      'Urgent remediation needed. This site has critical security and visibility gaps that require immediate attention.'
    );
  }

  return {
    grade,
    criticalIssues,
    topRecommendations,
    categoryRanking: categories, // Ordered weakest → strongest for triage
  };
}
