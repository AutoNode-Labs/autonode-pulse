#!/usr/bin/env node
/**
 * AutoNode Pulse CLI
 *
 * Runs the full audit engine directly — no HTTP server required.
 * Designed for CI/CD pipelines: exits 0 on pass, 1 on failure.
 *
 * Usage:
 *   autonode-pulse <url> [options]
 *   autonode-pulse https://example.com --threshold 80
 *   autonode-pulse https://example.com --json | jq '.pulseScore.overall'
 */

import { program }           from 'commander';
import chalk                 from 'chalk';
import { fetchUrl }          from '../src/engine/fetcher.js';
import { auditLlmReadiness } from '../src/engine/llm.auditor.js';
import { auditSecurityHeaders } from '../src/engine/security.auditor.js';
import { auditEnterpriseSeo }   from '../src/engine/seo.auditor.js';
import { auditTechnicalSeo }    from '../src/engine/technical.auditor.js';
import { calculatePulseScore }  from '../src/engine/scorer.js';

// ── Visual helpers ─────────────────────────────────────────────────────────

const W = 58; // report width

function hr(ch = '─') { return chalk.gray(ch.repeat(W)); }

function scoreBar(pct, width = 22) {
  const filled = Math.round((pct / 100) * width);
  return chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(width - filled));
}

function colorByPct(val, str) {
  if (val >= 80) return chalk.green(str);
  if (val >= 50) return chalk.yellow(str);
  return chalk.red(str);
}

function gradeColor(g) {
  if (g.startsWith('A')) return chalk.bold.green(g);
  if (g.startsWith('B')) return chalk.bold.cyan(g);
  if (g.startsWith('C')) return chalk.bold.yellow(g);
  return chalk.bold.red(g);
}

function statusIcon(s) {
  if (s === 'pass')    return chalk.green('✔');
  if (s === 'warning') return chalk.yellow('⚠');
  if (s === 'info')    return chalk.blue('ℹ');
  return chalk.red('✖');
}

// ── Report renderer ────────────────────────────────────────────────────────

function render(targetUrl, result, threshold) {
  const { pulseScore, categories, auditedAt, httpStatus, finalUrl } = result;
  const { overall, grade, breakdown, summary } = pulseScore;

  console.log();
  console.log(chalk.bold.cyan(`  ╔${'═'.repeat(W - 2)}╗`));
  console.log(chalk.bold.cyan('  ║') + chalk.bold.white('         AutoNode Pulse  ·  Architectural Audit          ') + chalk.bold.cyan('║'));
  console.log(chalk.bold.cyan(`  ╚${'═'.repeat(W - 2)}╝`));
  console.log();
  console.log(`  ${chalk.gray('Target  :')} ${chalk.white(targetUrl)}`);
  if (finalUrl !== targetUrl + '/' && finalUrl !== targetUrl)
    console.log(`  ${chalk.gray('Redirect:')} ${chalk.gray(finalUrl)}`);
  console.log(`  ${chalk.gray('HTTP    :')} ${httpStatus === 200 ? chalk.green(`${httpStatus} OK`) : chalk.yellow(httpStatus)}`);
  console.log(`  ${chalk.gray('Audited :')} ${chalk.white(new Date(auditedAt).toLocaleString())}`);
  console.log();

  // ── Overall score ────────────────────────────────────────────────────────
  const overallStr  = colorByPct(overall, String(overall));
  const threshStr   = chalk.gray(`(threshold: ${threshold})`);
  console.log(`  ${hr()}`);
  console.log(
    `  ${chalk.bold('PULSE SCORE')}  ` +
    `${overallStr} ${chalk.gray('/ 100')}  ` +
    `${scoreBar(overall)}  ` +
    `Grade: ${gradeColor(grade)}  ${threshStr}`
  );
  console.log(`  ${hr()}`);
  console.log();

  // ── Category breakdown ───────────────────────────────────────────────────
  console.log(`  ${chalk.bold.white('CATEGORY BREAKDOWN')}`);
  console.log();

  const cats = [
    { key: 'technicalSeo',  label: 'Technical SEO ' },
    { key: 'enterpriseSeo', label: 'Enterprise SEO' },
    { key: 'security',      label: 'Security      ' },
    { key: 'llmReadiness',  label: 'LLM Readiness ' },
  ];

  for (const { key, label } of cats) {
    const cat = breakdown[key];
    if (!cat) continue;
    const p   = cat.percentage;
    const icon = colorByPct(p, p >= 80 ? '✔' : p >= 50 ? '⚠' : '✖');
    console.log(
      `  ${icon}  ${chalk.white(label)}  ${scoreBar(p)}  ` +
      `${colorByPct(p, `${cat.score}/${cat.maxScore}`)}  ` +
      `${colorByPct(p, `${p}%`)}`
    );
  }
  console.log();

  // ── Key findings ─────────────────────────────────────────────────────────
  const findings = [];

  // Security issues
  const secAll = [
    ...Object.values(categories.security?.metrics?.securityHeaders ?? {}),
    ...Object.values(categories.security?.metrics?.informationLeaks ?? {}),
  ].filter(m => m.status !== 'pass');

  if (secAll.length) {
    findings.push({ section: 'Security', items: secAll.map(m => ({
      icon:   statusIcon(m.status),
      label:  m.displayName,
      detail: m.recommendation ?? m.note ?? null,
    })) });
  }

  // Blocked AI crawlers
  const blocked = Object.entries(categories.llmReadiness?.metrics?.aiCrawlerPolicy?.crawlers ?? {})
    .filter(([, v]) => v.status === 'warning');
  if (blocked.length) {
    findings.push({ section: 'LLM Readiness — Blocked AI Crawlers', items: blocked.map(([name, v]) => ({
      icon:   chalk.red('✖'),
      label:  name,
      detail: v.note,
    })) });
  }

  // Missing semantic tags
  const missingTags = Object.entries(categories.llmReadiness?.metrics?.semanticHtml?.tags ?? {})
    .filter(([, v]) => !v.found);
  if (missingTags.length) {
    findings.push({ section: 'LLM Readiness — Missing Semantic Tags', items: missingTags.map(([tag]) => ({
      icon:   chalk.yellow('⚠'),
      label:  `<${tag}>`,
      detail: null,
    })) });
  }

  // SEO recommendations
  const seoRecs = Object.values(categories.enterpriseSeo?.metrics ?? {})
    .filter(m => m.status !== 'pass' && m.recommendation);
  if (seoRecs.length) {
    findings.push({ section: 'Enterprise SEO', items: seoRecs.map(m => ({
      icon:   statusIcon(m.status),
      label:  m.recommendation,
      detail: null,
    })) });
  }

  // Technical SEO
  const techIssues = Object.values(categories.technicalSeo?.metrics ?? {})
    .filter(m => m.status === 'fail' || m.status === 'warning');
  if (techIssues.length) {
    findings.push({ section: 'Technical SEO', items: techIssues.map(m => ({
      icon:   statusIcon(m.status),
      label:  m.recommendation ?? m.note ?? '',
      detail: null,
    })) });
  }

  if (findings.length) {
    console.log(`  ${chalk.bold.white('KEY FINDINGS')}`);
    console.log();
    for (const { section, items } of findings) {
      console.log(`  ${chalk.bold.yellow(section)}`);
      for (const { icon, label, detail } of items) {
        console.log(`    ${icon}  ${chalk.white(label)}`);
        if (detail) console.log(`       ${chalk.gray('→')} ${chalk.gray(detail)}`);
      }
      console.log();
    }
  }

  // ── Verdict ──────────────────────────────────────────────────────────────
  const passed = overall >= threshold;
  console.log(`  ${hr()}`);
  if (passed) {
    console.log(
      `  ${chalk.bold.green('✔ PASSED')}` +
      chalk.gray(`  Score ${overall} ≥ threshold ${threshold}  ·  Ready to ship.`)
    );
  } else {
    console.log(
      `  ${chalk.bold.red('✖ FAILED')}` +
      chalk.gray(`  Score ${overall} < threshold ${threshold}`)
    );
    console.log(`  ${chalk.red('Audit score is below the minimum acceptable threshold. Blocking pipeline.')}`);
  }
  console.log(`  ${hr()}`);
  console.log();
}

// ── CLI definition ─────────────────────────────────────────────────────────

program
  .name('autonode-pulse')
  .description('Architectural Auditing & LLM-Readiness CLI — CI/CD ready')
  .version('2.0.0')
  .argument('<url>', 'Target URL to audit (http:// or https://)')
  .option('-t, --threshold <number>', 'Minimum acceptable Pulse Score (0–100)', '70')
  .option('--json', 'Output raw JSON (pipe-friendly for scripting)')
  .action(async (url, options) => {
    const threshold = parseInt(options.threshold, 10);

    if (isNaN(threshold) || threshold < 0 || threshold > 100) {
      console.error(chalk.red('Error: --threshold must be a number between 0 and 100'));
      process.exit(1);
    }

    let parsed;
    try {
      parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    } catch {
      console.error(chalk.red(`Error: "${url}" is not a valid http/https URL`));
      process.exit(1);
    }

    if (!options.json) {
      process.stderr.write(chalk.gray(`\n  Auditing ${chalk.white(url)} ...\n`));
    }

    let fetchResult;
    try {
      fetchResult = await fetchUrl(url);
    } catch (err) {
      const msgs = {
        SSRF_BLOCKED:  'SSRF blocked: target resolves to a private/reserved IP',
        FETCH_TIMEOUT: 'Request timed out',
        DNS_ERROR:     'DNS resolution failed — check the URL',
        CONN_REFUSED:  'Connection refused by target server',
      };
      console.error(chalk.red(`\n  Error: ${msgs[err.code] ?? err.message}`));
      process.exit(1);
    }

    const [llmResult, secResult, seoResult, techResult] = await Promise.all([
      auditLlmReadiness(url, fetchResult.data),
      Promise.resolve(auditSecurityHeaders(fetchResult.headers)),
      Promise.resolve(auditEnterpriseSeo(fetchResult.data, fetchResult.headers)),
      auditTechnicalSeo(url, fetchResult.data),
    ]);

    const pulseScore = calculatePulseScore(llmResult, secResult, seoResult, techResult);

    const result = {
      targetUrl:  url,
      finalUrl:   fetchResult.finalUrl,
      httpStatus: fetchResult.status,
      auditedAt:  new Date().toISOString(),
      pulseScore,
      categories: {
        llmReadiness:  llmResult,
        security:      secResult,
        enterpriseSeo: seoResult,
        technicalSeo:  techResult,
      },
    };

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      render(url, result, threshold);
    }

    process.exit(pulseScore.overall >= threshold ? 0 : 1);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(chalk.red('Fatal:'), err.message);
  process.exit(1);
});
