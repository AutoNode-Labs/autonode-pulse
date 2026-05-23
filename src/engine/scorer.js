/**
 * Pulse Score Calculator — Phase 2.
 *
 * Four categories; total denominator is 115 (30+35+35+15), normalized to 0–100.
 * This keeps category weights stable when adding new categories: old scores
 * drop slightly (proportionally) rather than being invalidated.
 */

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
 * @param {{ score, maxScore }} llm
 * @param {{ score, maxScore }} security
 * @param {{ score, maxScore }} seo
 * @param {{ score, maxScore }} [technical]  - Optional; absent in Phase 1 cache hits
 */
export function calculatePulseScore(llm, security, seo, technical = null) {
  const totalRaw = llm.score + security.score + seo.score + (technical?.score ?? 0);
  const totalMax = llm.maxScore + security.maxScore + seo.maxScore + (technical?.maxScore ?? 0);
  const overall  = Math.round((totalRaw / totalMax) * 100);
  const grade    = toGrade(overall);

  const breakdown = {
    llmReadiness: {
      score:      llm.score,
      maxScore:   llm.maxScore,
      percentage: pct(llm.score, llm.maxScore),
    },
    security: {
      score:      security.score,
      maxScore:   security.maxScore,
      percentage: pct(security.score, security.maxScore),
    },
    enterpriseSeo: {
      score:      seo.score,
      maxScore:   seo.maxScore,
      percentage: pct(seo.score, seo.maxScore),
    },
  };

  if (technical) {
    breakdown.technicalSeo = {
      score:      technical.score,
      maxScore:   technical.maxScore,
      percentage: pct(technical.score, technical.maxScore),
    };
  }

  return {
    overall,
    grade,
    breakdown,
    summary: buildSummary(overall, llm, security, seo, technical),
  };
}

function buildSummary(overall, llm, security, seo, technical) {
  const criticalIssues     = [];
  const topRecommendations = [];

  if (llm.score      < llm.maxScore      * 0.5) criticalIssues.push('LLM/RAG readiness is critically low — AI crawlers may be blocked or content is unstructured');
  if (security.score < security.maxScore * 0.5) criticalIssues.push('Security posture is critically weak — core HTTP security headers are missing');
  if (seo.score      < seo.maxScore      * 0.5) criticalIssues.push('Core SEO signals are largely absent — search engine and social media visibility is severely impacted');
  if (technical && technical.score < technical.maxScore * 0.5) criticalIssues.push('Technical SEO fundamentals missing — sitemap or canonical tags absent');

  const categories = [
    { name: 'LLM Readiness',   pct: pct(llm.score,      llm.maxScore)      },
    { name: 'Security',        pct: pct(security.score,  security.maxScore)  },
    { name: 'Enterprise SEO',  pct: pct(seo.score,       seo.maxScore)       },
    ...(technical ? [{ name: 'Technical SEO', pct: pct(technical.score, technical.maxScore) }] : []),
  ].sort((a, b) => a.pct - b.pct);

  if (categories[0].pct < 80) {
    topRecommendations.push(`Prioritise "${categories[0].name}" — currently at ${categories[0].pct}% of its maximum score`);
  }

  if      (overall >= 85) topRecommendations.push('Excellent architectural health. Close the remaining gaps for full LLM-era readiness.');
  else if (overall >= 65) topRecommendations.push('Good foundation. Address security headers and LLM crawler access to reach the next tier.');
  else if (overall >= 45) topRecommendations.push('Significant gaps present. Prioritise security headers first, then LLM access, then SEO metadata.');
  else                    topRecommendations.push('Urgent remediation needed. Critical security and visibility gaps require immediate attention.');

  return { criticalIssues, topRecommendations, categoryRanking: categories };
}
