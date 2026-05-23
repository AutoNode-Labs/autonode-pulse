/**
 * Enterprise SEO & Metadata Auditor.
 *
 * Five signal categories, each independently scored:
 *   1. Title tag          — Presence and Google-optimal length (30–60 chars)
 *   2. Meta description   — Presence and SERP-optimal length (120–160 chars)
 *   3. Open Graph tags    — Core OG set for social / AI knowledge graph cards
 *   4. Image accessibility — alt attribute coverage (WCAG 2.1 AA + image SEO)
 *   5. Structured Data    — JSON-LD presence for rich results & knowledge graphs
 *
 * Scoring budget: 35 points total (7 pts per category).
 * Partial credit is awarded when a signal is present but suboptimal, so
 * incremental improvements are reflected without waiting for perfection.
 */

import * as cheerio from 'cheerio';

// ─── Thresholds ───────────────────────────────────────────────────────────────
const TITLE_MIN = 30;
const TITLE_MAX = 60;
const META_DESC_MIN = 120;
const META_DESC_MAX = 160;
const ALT_COVERAGE_GOOD_THRESHOLD = 1.0;    // 100% — all images must have alt
const ALT_COVERAGE_WARN_THRESHOLD = 0.8;    // 80%

const CORE_OG_TAGS = ['og:title', 'og:description', 'og:image', 'og:url'];

const MAX_PER_CATEGORY  = 7;  // Each of the five categories is worth 7 pts
const PARTIAL_CREDIT    = 4;  // Points awarded when present but suboptimal

// ─── Auditor ──────────────────────────────────────────────────────────────────
/**
 * @param {string} htmlContent    - Raw HTML string of the audited page.
 * @param {object} responseHeaders - HTTP response headers (for potential future signals).
 * @returns {{ score, maxScore, metrics, overallStatus }}
 */
export function auditEnterpriseSeo(htmlContent, responseHeaders) {  // eslint-disable-line no-unused-vars
  const $ = cheerio.load(htmlContent);
  const maxScore = 35;
  let rawScore = 0;
  const metrics = {};

  // ── 1. Title tag ─────────────────────────────────────────────────────────
  const titleText    = $('title').first().text().trim();
  const titlePresent = titleText.length > 0;
  const titleLen     = titleText.length;
  const titleOptimal = titleLen >= TITLE_MIN && titleLen <= TITLE_MAX;

  let titleStatus = 'fail';
  let titlePoints = 0;
  if (titlePresent && titleOptimal) { titleStatus = 'pass';    titlePoints = MAX_PER_CATEGORY; }
  else if (titlePresent)            { titleStatus = 'warning'; titlePoints = PARTIAL_CREDIT;   }

  rawScore += titlePoints;

  metrics.title = {
    status:       titleStatus,
    present:      titlePresent,
    value:        titleText || null,
    length:       titleLen,
    optimalRange: `${TITLE_MIN}–${TITLE_MAX} characters`,
    optimal:      titleOptimal,
    points:       titlePoints,
    maxPoints:    MAX_PER_CATEGORY,
    recommendation: !titlePresent
      ? 'Add a <title> tag with a descriptive, keyword-rich title (30–60 chars)'
      : !titleOptimal
        ? `Current title is ${titleLen} chars — adjust to ${TITLE_MIN}–${TITLE_MAX} chars for optimal SERP display`
        : null,
  };

  // ── 2. Meta description ──────────────────────────────────────────────────
  const metaDescContent = $('meta[name="description"]').first().attr('content')?.trim() ?? '';
  const metaDescPresent = metaDescContent.length > 0;
  const metaDescLen     = metaDescContent.length;
  const metaDescOptimal = metaDescLen >= META_DESC_MIN && metaDescLen <= META_DESC_MAX;

  let metaDescStatus = 'fail';
  let metaDescPoints = 0;
  if (metaDescPresent && metaDescOptimal) { metaDescStatus = 'pass';    metaDescPoints = MAX_PER_CATEGORY; }
  else if (metaDescPresent)               { metaDescStatus = 'warning'; metaDescPoints = PARTIAL_CREDIT;   }

  rawScore += metaDescPoints;

  metrics.metaDescription = {
    status:       metaDescStatus,
    present:      metaDescPresent,
    value:        metaDescContent || null,
    length:       metaDescLen,
    optimalRange: `${META_DESC_MIN}–${META_DESC_MAX} characters`,
    optimal:      metaDescOptimal,
    points:       metaDescPoints,
    maxPoints:    MAX_PER_CATEGORY,
    recommendation: !metaDescPresent
      ? 'Add <meta name="description" content="..."> — used by search engines and social platforms for snippet generation'
      : !metaDescOptimal
        ? `Current meta description is ${metaDescLen} chars — adjust to ${META_DESC_MIN}–${META_DESC_MAX} chars`
        : null,
  };

  // ── 3. Open Graph tags ───────────────────────────────────────────────────
  const ogTags = {};
  $('meta[property^="og:"]').each((_, el) => {
    const property = $(el).attr('property');
    const content  = $(el).attr('content');
    if (property && content !== undefined) ogTags[property] = content;
  });

  const coreOgFound   = CORE_OG_TAGS.filter(t => ogTags[t] !== undefined);
  const ogComplete    = coreOgFound.length === CORE_OG_TAGS.length;
  const ogPartial     = coreOgFound.length > 0;

  let ogStatus = 'fail';
  let ogPoints = 0;
  if (ogComplete)     { ogStatus = 'pass';    ogPoints = MAX_PER_CATEGORY; }
  else if (ogPartial) { ogStatus = 'warning'; ogPoints = PARTIAL_CREDIT;   }

  rawScore += ogPoints;

  metrics.openGraph = {
    status:           ogStatus,
    present:          ogPartial,
    coreTagsCoverage: `${coreOgFound.length}/${CORE_OG_TAGS.length}`,
    completeCoreTags: ogComplete,
    foundTags:        ogTags,
    missingCoreTags:  CORE_OG_TAGS.filter(t => ogTags[t] === undefined),
    points:           ogPoints,
    maxPoints:        MAX_PER_CATEGORY,
    recommendation:   !ogComplete
      ? `Add missing core OG tags: ${CORE_OG_TAGS.filter(t => !ogTags[t]).join(', ')}`
      : null,
  };

  // ── 4. Image accessibility (alt attribute coverage) ──────────────────────
  // Strategy: count all <img> elements, find those missing an alt attribute
  // entirely (not just empty — an empty alt="" is valid for decorative images).
  const allImgs = $('img');
  const totalImages = allImgs.length;
  const missingAltSrcs = [];

  allImgs.each((_, el) => {
    if ($(el).attr('alt') === undefined) {
      const src = ($(el).attr('src') ?? $(el).attr('data-src') ?? '[no src]').slice(0, 100);
      missingAltSrcs.push(src);
    }
  });

  const missingAltCount  = missingAltSrcs.length;
  const coverageRatio    = totalImages > 0 ? (totalImages - missingAltCount) / totalImages : 1;
  const coveragePct      = parseFloat((coverageRatio * 100).toFixed(1));

  let altStatus = 'pass';
  let altPoints = MAX_PER_CATEGORY;
  if (totalImages > 0) {
    if (coverageRatio < ALT_COVERAGE_WARN_THRESHOLD) {
      altStatus = 'fail';
      altPoints = 0;
    } else if (coverageRatio < ALT_COVERAGE_GOOD_THRESHOLD) {
      altStatus = 'warning';
      altPoints = PARTIAL_CREDIT;
    }
  }

  rawScore += altPoints;

  metrics.imageAccessibility = {
    status:           altStatus,
    totalImages,
    missingAltCount,
    altCoverage:      `${coveragePct}%`,
    // Return up to 5 offending src values so the audit is actionable without
    // bloating the response for pages with thousands of images.
    offendingSrcs:    missingAltSrcs.slice(0, 5),
    points:           altPoints,
    maxPoints:        MAX_PER_CATEGORY,
    recommendation:   missingAltCount > 0
      ? `Add descriptive alt attributes to ${missingAltCount} image(s) — required for WCAG 2.1 AA compliance and image search indexing`
      : null,
  };

  // ── 5. JSON-LD Structured Data ───────────────────────────────────────────
  // JSON-LD is the format Google and LLM knowledge-graph pipelines prefer for
  // structured data. Its presence enables rich results, entity disambiguation,
  // and accurate knowledge-graph population.
  const jsonLdScripts = $('script[type="application/ld+json"]');
  const jsonLdCount   = jsonLdScripts.length;
  const jsonLdPresent = jsonLdCount > 0;

  // Extract the @type for each block so the report is informative.
  const schemaTypes = [];
  jsonLdScripts.each((_, el) => {
    try {
      const parsed = JSON.parse($(el).html());
      // A block can be a single object or a @graph array.
      if (Array.isArray(parsed['@graph'])) {
        schemaTypes.push(...parsed['@graph'].map(n => n['@type'] ?? 'Unknown'));
      } else {
        schemaTypes.push(parsed['@type'] ?? 'Unknown');
      }
    } catch {
      schemaTypes.push('ParseError — invalid JSON');
    }
  });

  const jsonLdPoints = jsonLdPresent ? MAX_PER_CATEGORY : 0;
  rawScore += jsonLdPoints;

  metrics.structuredData = {
    status:       jsonLdPresent ? 'pass' : 'fail',
    present:      jsonLdPresent,
    scriptCount:  jsonLdCount,
    schemaTypes,
    points:       jsonLdPoints,
    maxPoints:    MAX_PER_CATEGORY,
    recommendation: !jsonLdPresent
      ? 'Add <script type="application/ld+json"> structured data blocks (Schema.org) — required for rich results and LLM knowledge-graph accuracy'
      : null,
  };

  // ── Roll-up status ────────────────────────────────────────────────────────
  const allMetrics = Object.values(metrics);
  const overallStatus = allMetrics.every(m => m.status === 'pass')
    ? 'pass'
    : rawScore >= maxScore * 0.6
      ? 'warning'
      : 'fail';

  return {
    score:  Math.min(rawScore, maxScore),
    maxScore,
    metrics,
    overallStatus,
  };
}
