/**
 * LLM & RAG Readiness Auditor.
 *
 * Two signal categories:
 *   1. robots.txt AI crawler policy  — Can major LLM training pipelines index this site?
 *   2. Semantic HTML5 machine structure — Is the content chunked in a way that RAG
 *      systems can parse cleanly without relying on heuristic whitespace splitting?
 *
 * Scoring budget: 30 points total.
 *   • robots.txt accessible:          5 pts  (binary)
 *   • Per AI crawler (8 crawlers):    15 pts (1.875 pts each, ≈ 1.88)
 *   • Per semantic tag (7 tags):      10 pts (1.43 pts each)
 */

import * as cheerio from 'cheerio';
import { fetchRobotsTxt } from './fetcher.js';

// ─── AI crawler registry ─────────────────────────────────────────────────────
// Ordered by training-dataset significance. Expanding this list is non-breaking
// as long as the total points budget is recalculated from AI_CRAWLERS.length.
const AI_CRAWLERS = [
  { name: 'GPTBot',          description: 'OpenAI GPT training crawler (RFC 9309 compliant)' },
  { name: 'ChatGPT-User',    description: 'OpenAI ChatGPT real-time browsing agent' },
  { name: 'CCBot',           description: 'Common Crawl — primary dataset for many open LLMs' },
  { name: 'anthropic-ai',    description: 'Anthropic model training crawler' },
  { name: 'Claude-Web',      description: 'Anthropic Claude web-browsing feature agent' },
  { name: 'Google-Extended', description: 'Google AI training (Gemini/Bard exclusion signal)' },
  { name: 'PerplexityBot',   description: 'Perplexity AI real-time search crawler' },
  { name: 'Omgilibot',       description: 'Webz.io / Omgili LLM training dataset crawler' },
];

// ─── Semantic HTML5 tag registry ─────────────────────────────────────────────
// These tags give LLM chunkers structural anchors. A page with <article> and
// <section> allows RAG pipelines to split content by intent rather than by
// character-count heuristics.
const SEMANTIC_TAGS = [
  { tag: 'article', note: 'Primary content unit — ideal RAG chunk boundary' },
  { tag: 'main',    note: 'Main content landmark — reduces boilerplate in LLM context windows' },
  { tag: 'section', note: 'Thematic grouping — enables topic-aware chunking' },
  { tag: 'nav',     note: 'Navigation landmark — allows crawlers to skip link-dense areas' },
  { tag: 'aside',   note: 'Supplementary content — helps LLMs de-prioritize sidebars' },
  { tag: 'header',  note: 'Document/section header — anchors hierarchical parsing' },
  { tag: 'footer',  note: 'Footer landmark — lets crawlers exclude boilerplate legal text' },
];

// ─── robots.txt parser ────────────────────────────────────────────────────────
/**
 * Parses robots.txt content into a map of { agentKey → { disallowed[], allowed[] } }.
 * Implements the parsing rules from RFC 9309 (Robots Exclusion Protocol).
 *
 * Key rules applied:
 *   • Lines starting with '#' are comments.
 *   • A blank line ends a rule group.
 *   • Multiple consecutive User-agent lines form a group sharing the same rules.
 *   • Field names are case-insensitive; values are case-sensitive (agent names are lower-cased for lookup).
 */
function parseRobotsTxt(content) {
  if (!content) return {};

  const rules = {};   // { 'agentlowercase': { disallowed: string[], allowed: string[] } }
  let currentAgents = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim(); // strip inline comments

    if (!line) {
      // Blank line terminates the current rule group.
      currentAgents = [];
      continue;
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const field = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (field === 'user-agent') {
      const agentKey = value.toLowerCase();
      if (!rules[agentKey]) rules[agentKey] = { disallowed: [], allowed: [] };
      currentAgents.push(agentKey);
    } else if (field === 'disallow') {
      for (const agent of currentAgents) {
        if (!rules[agent]) rules[agent] = { disallowed: [], allowed: [] };
        if (value) rules[agent].disallowed.push(value);
      }
    } else if (field === 'allow') {
      for (const agent of currentAgents) {
        if (!rules[agent]) rules[agent] = { disallowed: [], allowed: [] };
        if (value) rules[agent].allowed.push(value);
      }
    }
  }

  return rules;
}

/**
 * Returns true if the named crawler is fully blocked (Disallow: /).
 *
 * Precedence (RFC 9309 §2.2.2 — longer match wins):
 *   A specific Allow: / for the crawler overrides a wildcard Disallow: /.
 *   A direct Disallow: / for the crawler wins over a wildcard Allow: /.
 */
function isCrawlerFullyBlocked(crawlerName, rules) {
  const key      = crawlerName.toLowerCase();
  const direct   = rules[key]  ?? { disallowed: [], allowed: [] };
  const wildcard = rules['*']  ?? { disallowed: [], allowed: [] };

  const directlyBlocked  = direct.disallowed.includes('/');
  const directlyAllowed  = direct.allowed.includes('/');
  const wildcardBlocked  = wildcard.disallowed.includes('/');

  if (directlyBlocked && !directlyAllowed) return true;
  if (wildcardBlocked && !directlyAllowed && direct.disallowed.length === 0 && direct.allowed.length === 0) return true;
  return false;
}

// ─── Main auditor ─────────────────────────────────────────────────────────────
/**
 * @param {string} targetUrl   - The origin URL being audited.
 * @param {string} htmlContent - Pre-fetched HTML of the target page.
 * @returns {{ score, maxScore, metrics }}
 */
export async function auditLlmReadiness(targetUrl, htmlContent) {
  const maxScore = 30;
  let rawScore = 0;
  const metrics = {};

  // ── 1. robots.txt reachability ───────────────────────────────────────────
  const ROBOTS_POINTS = 5;
  const robots = await fetchRobotsTxt(targetUrl);
  const rulesMap = robots.accessible && robots.content
    ? parseRobotsTxt(robots.content)
    : {};

  const robotsPass = robots.accessible;
  rawScore += robotsPass ? ROBOTS_POINTS : 0;

  metrics.robotsTxt = {
    status:      robotsPass ? 'pass' : 'fail',
    accessible:  robotsPass,
    httpStatus:  robots.status,
    description: robotsPass
      ? 'robots.txt is accessible and parseable'
      : `robots.txt is inaccessible (${robots.error ?? `HTTP ${robots.status}`})`,
    points:    robotsPass ? ROBOTS_POINTS : 0,
    maxPoints: ROBOTS_POINTS,
  };

  // ── 2. AI crawler policy ─────────────────────────────────────────────────
  // Points are divided evenly; partial credit is intentional so sites that allow
  // some crawlers (but not all) get proportional scores.
  const CRAWLER_TOTAL_POINTS = 15;
  const pointsPerCrawler = CRAWLER_TOTAL_POINTS / AI_CRAWLERS.length;

  const crawlerResults = {};
  for (const { name, description } of AI_CRAWLERS) {
    // If robots.txt was inaccessible we cannot determine policy.
    if (!robots.accessible) {
      crawlerResults[name] = {
        status:      'unknown',
        allowed:     null,
        description,
        note:        'robots.txt inaccessible — crawler policy cannot be determined',
        points:      0,
        maxPoints:   parseFloat(pointsPerCrawler.toFixed(2)),
      };
      continue;
    }

    const blocked = isCrawlerFullyBlocked(name, rulesMap);
    const points  = blocked ? 0 : parseFloat(pointsPerCrawler.toFixed(2));
    rawScore += points;

    crawlerResults[name] = {
      status:      blocked ? 'warning' : 'pass',
      allowed:     !blocked,
      description,
      note: blocked
        ? `"Disallow: /" is set for ${name} — this crawler cannot train on or index this site`
        : `${name} is permitted to crawl`,
      points,
      maxPoints: parseFloat(pointsPerCrawler.toFixed(2)),
    };
  }

  const blockedCount = Object.values(crawlerResults).filter(c => c.status === 'warning').length;

  metrics.aiCrawlerPolicy = {
    status:       blockedCount === 0 ? 'pass' : blockedCount < AI_CRAWLERS.length ? 'warning' : 'fail',
    blockedCount,
    totalChecked: AI_CRAWLERS.length,
    crawlers:     crawlerResults,
  };

  // ── 3. Semantic HTML5 machine readability ────────────────────────────────
  const SEMANTIC_TOTAL_POINTS = 10;
  const pointsPerTag = SEMANTIC_TOTAL_POINTS / SEMANTIC_TAGS.length;
  const $ = cheerio.load(htmlContent);

  const tagResults = {};
  for (const { tag, note } of SEMANTIC_TAGS) {
    const count = $(tag).length;
    const found = count > 0;
    const points = found ? parseFloat(pointsPerTag.toFixed(2)) : 0;
    rawScore += points;

    tagResults[tag] = {
      status:    found ? 'pass' : 'warning',
      found,
      count,
      note:      found
        ? `${count} <${tag}> element(s) found — ${note}`
        : `<${tag}> absent — ${note}`,
      points,
      maxPoints: parseFloat(pointsPerTag.toFixed(2)),
    };
  }

  const foundCount = Object.values(tagResults).filter(t => t.found).length;

  metrics.semanticHtml = {
    status:          foundCount === SEMANTIC_TAGS.length ? 'pass' : foundCount >= 3 ? 'warning' : 'fail',
    foundTagsCount:  foundCount,
    totalTagsChecked: SEMANTIC_TAGS.length,
    tags:            tagResults,
  };

  return {
    score:    parseFloat(Math.min(rawScore, maxScore).toFixed(1)),
    maxScore,
    metrics,
  };
}
