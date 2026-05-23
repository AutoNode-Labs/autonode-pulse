/**
 * Technical SEO Auditor — Phase 2 addition.
 *
 * Three signals:
 *   1. Sitemap.xml  — Presence at /sitemap.xml (5 pts)
 *   2. Canonical    — <link rel="canonical"> presence and validity (5 pts)
 *   3. hreflang     — International targeting (5 pts, neutral for monolingual)
 *
 * Scoring budget: 15 points.
 *
 * The sitemap fetch reuses the SSRF-safe fetcher. Since the sitemap URL is
 * derived from the already-validated targetUrl (same origin), it cannot be
 * weaponised for SSRF — but the guard fires anyway as defense-in-depth.
 */

import * as cheerio from 'cheerio';
import { fetchUrl } from './fetcher.js';

export async function auditTechnicalSeo(targetUrl, htmlContent) {
  const $ = cheerio.load(htmlContent);
  const maxScore = 15;
  let rawScore = 0;
  const metrics = {};

  // ── 1. Sitemap.xml ────────────────────────────────────────────────────────
  let sitemapAccessible = false;
  let sitemapHttpStatus = null;

  try {
    const sitemapUrl = new URL('/sitemap.xml', targetUrl).toString();
    const result     = await fetchUrl(sitemapUrl);
    sitemapAccessible  = result.status >= 200 && result.status < 400;
    sitemapHttpStatus  = result.status;
  } catch {
    sitemapAccessible = false;
  }

  // Fallback: sitemap declared via <link rel="sitemap"> in <head>
  const htmlSitemapHref = $('link[rel="sitemap"]').attr('href') ?? null;

  let sitemapPoints = 0;
  let sitemapStatus = 'fail';
  if (sitemapAccessible)     { sitemapStatus = 'pass';    sitemapPoints = 5; }
  else if (htmlSitemapHref)  { sitemapStatus = 'warning'; sitemapPoints = 2; }

  rawScore += sitemapPoints;

  metrics.sitemap = {
    status:          sitemapStatus,
    accessible:      sitemapAccessible,
    httpStatus:      sitemapHttpStatus,
    declaredInHtml:  htmlSitemapHref,
    points:          sitemapPoints,
    maxPoints:       5,
    recommendation:  !sitemapAccessible
      ? 'Create /sitemap.xml and declare it in robots.txt with: Sitemap: https://yourdomain.com/sitemap.xml'
      : null,
  };

  // ── 2. Canonical tag ──────────────────────────────────────────────────────
  // Self-referencing canonical = full points (prevents duplicate content penalties).
  // Points to another URL = warning (could be intentional pagination/syndication).
  // Absent = fail (Google will pick its own canonical, often incorrectly).
  const canonicalHref = $('link[rel="canonical"]').first().attr('href')?.trim() ?? null;
  const canonicalPresent = Boolean(canonicalHref);

  let canonicalPoints = 0;
  let canonicalStatus = 'fail';
  let canonicalNote   = null;

  if (canonicalPresent) {
    try {
      const resolvedCanonical = new URL(canonicalHref, targetUrl);
      const resolvedTarget    = new URL(targetUrl);
      const isSelf = resolvedCanonical.hostname === resolvedTarget.hostname &&
                     resolvedCanonical.pathname  === resolvedTarget.pathname;

      if (isSelf) {
        canonicalStatus = 'pass';
        canonicalPoints = 5;
      } else {
        canonicalStatus = 'warning';
        canonicalPoints = 3;
        canonicalNote   = `Points to a different URL: "${canonicalHref}" — verify this is intentional (e.g. pagination, syndication)`;
      }
    } catch {
      canonicalStatus = 'warning';
      canonicalPoints = 2;
      canonicalNote   = 'Canonical href is not a valid URL';
    }
  }

  rawScore += canonicalPoints;

  metrics.canonical = {
    status:          canonicalStatus,
    present:         canonicalPresent,
    value:           canonicalHref,
    note:            canonicalNote,
    points:          canonicalPoints,
    maxPoints:       5,
    recommendation:  !canonicalPresent
      ? 'Add <link rel="canonical" href="https://yourdomain.com/page/"> to prevent duplicate-content dilution'
      : null,
  };

  // ── 3. hreflang ───────────────────────────────────────────────────────────
  // Absence is neutral for single-language sites (full points, benefit of doubt).
  // Presence without x-default = warning (Google requires x-default for fallback).
  const hreflangEls = $('link[rel="alternate"][hreflang]');
  const hreflangPresent = hreflangEls.length > 0;

  const hreflangTags = [];
  hreflangEls.each((_, el) => {
    hreflangTags.push({ lang: $(el).attr('hreflang'), href: $(el).attr('href') });
  });

  const hasXDefault = hreflangTags.some(t => t.lang === 'x-default');

  let hreflangPoints = 5;
  let hreflangStatus = 'pass';
  let hreflangNote   = null;

  if (hreflangPresent && !hasXDefault) {
    hreflangStatus = 'warning';
    hreflangPoints = 3;
    hreflangNote   = 'hreflang tags present but x-default is missing — add <link rel="alternate" hreflang="x-default" href="..."> as the language fallback';
  } else if (!hreflangPresent) {
    hreflangStatus = 'info';
    hreflangNote   = 'No hreflang — acceptable for single-language sites. Required if you serve multiple languages.';
  }

  rawScore += hreflangPoints;

  metrics.hreflang = {
    status:          hreflangStatus,
    present:         hreflangPresent,
    count:           hreflangTags.length,
    hasXDefault,
    tags:            hreflangTags.slice(0, 10), // cap to keep response size reasonable
    note:            hreflangNote,
    points:          hreflangPoints,
    maxPoints:       5,
    recommendation:  hreflangPresent && !hasXDefault
      ? 'Add <link rel="alternate" hreflang="x-default" href="..."> as the universal fallback entry'
      : null,
  };

  return {
    score:    Math.min(rawScore, maxScore),
    maxScore,
    metrics,
  };
}
