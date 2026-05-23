import { useState, useEffect, useRef, useCallback } from 'react';

// Base URL for the backend API.
// Vite bakes VITE_API_URL into the bundle at build time. Empty fallback would
// produce relative URLs that break on Vercel (frontend ≠ backend origin).
// Explicit localhost:3000 fallback keeps local dev working without a .env file.
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// ── Constants ──────────────────────────────────────────────────────────────

const CIRCUMFERENCE = 2 * Math.PI * 52; // matches r=52 in CircularGauge SVG

const SCAN_LINES = [
  { delay: 0,    text: 'INITIALIZING AUDIT SEQUENCE...',              level: 'info' },
  { delay: 240,  text: 'RESOLVING HOST VIA SSRF-SAFE DNS...',         level: 'info' },
  { delay: 500,  text: 'SSRF GATEWAY CHECK ............. [PASS]',     level: 'pass' },
  { delay: 760,  text: 'ESTABLISHING SECURE CONNECTION...',           level: 'info' },
  { delay: 1060, text: 'FETCHING TARGET RESOURCE...',                 level: 'info' },
  { delay: 1380, text: 'PARSING HTML DOM STRUCTURE...',               level: 'info' },
  { delay: 1660, text: 'CHECKING AI CRAWLER DIRECTIVES...',           level: 'info' },
  { delay: 1940, text: 'AUDITING HTTP SECURITY HEADERS...',           level: 'info' },
  { delay: 2220, text: 'VALIDATING JSON-LD SCHEMA...',                level: 'info' },
  { delay: 2500, text: 'ANALYZING SITEMAP & CANONICAL TAGS...',       level: 'info' },
  { delay: 2780, text: 'CALCULATING PULSE SCORE...',                  level: 'info' },
  { delay: 3060, text: 'COMPILING AUDIT RESULTS ......... [DONE]',   level: 'pass' },
];

// ── Helpers ────────────────────────────────────────────────────────────────

function gradeColor(grade) {
  if (!grade) return '#22d3ee';
  if (grade.startsWith('A')) return '#00ff88';
  if (grade.startsWith('B')) return '#22d3ee';
  if (grade.startsWith('C')) return '#fbbf24';
  if (grade.startsWith('D')) return '#f97316';
  return '#ff4a4a';
}

function pctColor(pct) {
  if (pct >= 80) return '#00ff88';
  if (pct >= 55) return '#fbbf24';
  return '#ff4a4a';
}

function buildTelemetry(result) {
  const logs = [];
  const { categories } = result;
  const push = (level, text) => logs.push({ level, text });

  // Security headers
  Object.values(categories?.security?.metrics?.securityHeaders ?? {}).forEach(m => {
    if (!m?.status) return;
    if (m.status === 'fail')         push('CRITICAL', `${m.displayName}: ${m.recommendation ?? 'Missing header'}`);
    else if (m.status === 'warning') push('WARNING',  `${m.displayName}: ${m.recommendation ?? m.note}`);
    else                             push('PASS',     `${m.displayName}: present`);
  });

  // Information leaks
  Object.values(categories?.security?.metrics?.informationLeaks ?? {}).forEach(m => {
    if (!m?.status) return;
    if (m.status === 'fail')         push('CRITICAL', `INFO LEAK — ${m.displayName}: ${m.note ?? m.recommendation}`);
    else if (m.status === 'warning') push('WARNING',  `${m.displayName}: ${m.note}`);
    else                             push('PASS',     `${m.displayName}: not exposed`);
  });

  // AI crawlers
  Object.entries(categories?.llmReadiness?.metrics?.aiCrawlerPolicy?.crawlers ?? {}).forEach(([name, v]) => {
    if (!v?.status) return;
    if (v.status === 'warning') push('WARNING', `AI CRAWLER BLOCKED — ${name}: ${v.note ?? 'disallowed in robots.txt'}`);
    else                        push('PASS',    `AI CRAWLER ALLOWED — ${name}`);
  });

  // Semantic HTML tags
  Object.entries(categories?.llmReadiness?.metrics?.semanticHtml?.tags ?? {}).forEach(([tag, v]) => {
    if (v?.found === false) push('WARNING', `SEMANTIC TAG MISSING — <${tag}>: reduces LLM chunking fidelity`);
    else                    push('PASS',    `SEMANTIC TAG PRESENT — <${tag}>`);
  });

  // Enterprise SEO
  Object.values(categories?.enterpriseSeo?.metrics ?? {}).forEach(m => {
    if (!m?.status) return;
    if (m.status === 'fail')         push('CRITICAL', `SEO — ${m.recommendation ?? m.displayName}`);
    else if (m.status === 'warning') push('WARNING',  `SEO — ${m.recommendation ?? m.displayName}`);
    else                             push('PASS',     `SEO — ${m.displayName}: passed`);
  });

  // Technical SEO
  Object.values(categories?.technicalSeo?.metrics ?? {}).forEach(m => {
    if (!m?.status) return;
    if (m.status === 'fail')         push('CRITICAL', `TECHNICAL SEO — ${m.recommendation ?? m.displayName}`);
    else if (m.status === 'warning') push('WARNING',  `TECHNICAL SEO — ${m.recommendation ?? m.note ?? m.displayName}`);
    else                             push('PASS',     `TECHNICAL SEO — ${m.displayName}: OK`);
  });

  return logs;
}

function extractCategoryItems(catKey, metrics) {
  const items = [];
  if (!metrics) return items;

  if (catKey === 'security') {
    Object.values(metrics.securityHeaders ?? {}).forEach(m => {
      if (m?.status) items.push({ name: m.displayName, status: m.status });
    });
    Object.values(metrics.informationLeaks ?? {}).forEach(m => {
      if (m?.status) items.push({ name: m.displayName, status: m.status });
    });
  } else if (catKey === 'llmReadiness') {
    Object.entries(metrics.aiCrawlerPolicy?.crawlers ?? {}).forEach(([name, v]) => {
      if (v?.status) items.push({ name, status: v.status });
    });
    Object.entries(metrics.semanticHtml?.tags ?? {}).forEach(([tag, v]) => {
      items.push({ name: `<${tag}>`, status: v.found ? 'pass' : 'warning' });
    });
  } else {
    Object.values(metrics).forEach(m => {
      if (m && typeof m === 'object' && m.status) {
        items.push({ name: m.displayName ?? '—', status: m.status });
      }
    });
  }
  return items;
}

// ── Primitive components ───────────────────────────────────────────────────

function GlowButton({ onClick, disabled, children, small = false }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`font-mono font-bold tracking-widest uppercase rounded border transition-all duration-200
        bg-emerald-500/10 border-emerald-500/50 text-emerald-400
        hover:bg-emerald-500/20 hover:border-emerald-400 hover:text-emerald-300
        disabled:opacity-40 disabled:cursor-not-allowed
        ${small ? 'px-3 py-1.5 text-xs' : 'px-7 py-3 text-sm'}`}
      style={{ boxShadow: disabled ? 'none' : '0 0 14px rgba(0,255,136,0.15)' }}
    >
      {children}
    </button>
  );
}

function ProgressBar({ pct }) {
  const color = pctColor(pct);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setWidth(pct), 80);
    return () => clearTimeout(t);
  }, [pct]);

  return (
    <div className="w-full h-1.5 rounded-full overflow-hidden bg-white/5">
      <div
        className="h-full rounded-full"
        style={{
          width: `${width}%`,
          backgroundColor: color,
          boxShadow: `0 0 6px ${color}55`,
          transition: 'width 0.9s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      />
    </div>
  );
}

// ── Radar animation ────────────────────────────────────────────────────────

function RadarSvg() {
  return (
    <svg viewBox="0 0 200 200" className="w-40 h-40 flex-shrink-0">
      {[90, 65, 40, 18].map(r => (
        <circle key={r} cx="100" cy="100" r={r}
          fill="none" stroke="rgba(0,255,136,0.1)" strokeWidth="1" />
      ))}
      <line x1="10"  y1="100" x2="190" y2="100" stroke="rgba(0,255,136,0.06)" strokeWidth="1" />
      <line x1="100" y1="10"  x2="100" y2="190" stroke="rgba(0,255,136,0.06)" strokeWidth="1" />
      <line x1="36"  y1="36"  x2="164" y2="164" stroke="rgba(0,255,136,0.04)" strokeWidth="1" />
      <line x1="164" y1="36"  x2="36"  y2="164" stroke="rgba(0,255,136,0.04)" strokeWidth="1" />

      {/* Spinning sweep — 45° wedge from top, clockwise */}
      <g style={{ transformOrigin: '100px 100px', animation: 'spin 2.8s linear infinite' }}>
        {/* Leading edge line */}
        <line x1="100" y1="100" x2="100" y2="10"
          stroke="rgba(0,255,136,0.6)" strokeWidth="1.5" />
        {/* Fading wedge fill */}
        <path d="M 100 100 L 100 10 A 90 90 0 0 1 163.6 36.4 Z"
          fill="rgba(0,255,136,0.1)" />
      </g>

      {/* Static blip dots */}
      <circle cx="128" cy="66"  r="2.5" fill="#00ff88" opacity="0.85" />
      <circle cx="70"  cy="125" r="1.8" fill="#22d3ee" opacity="0.65" />
      <circle cx="150" cy="118" r="1.5" fill="#00ff88" opacity="0.45" />
      <circle cx="58"  cy="72"  r="1.2" fill="#22d3ee" opacity="0.35" />

      {/* Center dot */}
      <circle cx="100" cy="100" r="3" fill="#00ff88"
        style={{ filter: 'drop-shadow(0 0 5px #00ff88)' }} />
    </svg>
  );
}

// ── Scan terminal ──────────────────────────────────────────────────────────

function ScanTerminal({ lines }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length]);

  return (
    <div ref={ref} className="flex-1 overflow-y-auto space-y-1 pr-1 font-mono text-xs"
         style={{ maxHeight: '220px' }}>
      {lines.map((line, i) => (
        <div key={i} className="flex gap-3">
          <span className="text-slate-700 flex-shrink-0 select-none">
            {String(i).padStart(2, '0')}
          </span>
          <span className={line.level === 'pass' ? 'text-emerald-400' : 'text-slate-400'}>
            {line.text}
          </span>
        </div>
      ))}
      <div className="flex gap-3">
        <span className="text-slate-700 select-none">{String(lines.length).padStart(2, '0')}</span>
        <span className="text-emerald-400 animate-pulse">█</span>
      </div>
    </div>
  );
}

// ── Circular gauge ─────────────────────────────────────────────────────────

function CircularGauge({ score, grade }) {
  const color = gradeColor(grade);
  const [display, setDisplay] = useState(0);
  const [dash, setDash]       = useState(0);

  useEffect(() => {
    const start = performance.now();
    const duration = 1300;
    const step = (ts) => {
      const p = Math.min((ts - start) / duration, 1);
      const e = 1 - Math.pow(1 - p, 3); // ease-out cubic
      setDisplay(Math.round(e * score));
      setDash((e * score / 100) * CIRCUMFERENCE);
      if (p < 1) requestAnimationFrame(step);
    };
    const id = requestAnimationFrame(step);
    return () => cancelAnimationFrame(id);
  }, [score]);

  return (
    <div className="relative w-52 h-52 flex items-center justify-center">
      <svg viewBox="0 0 120 120" className="absolute inset-0 w-full h-full"
           style={{ transform: 'rotate(-90deg)' }}>
        {/* Track ring */}
        <circle cx="60" cy="60" r="52" fill="none"
          stroke="rgba(255,255,255,0.05)" strokeWidth="9" />
        {/* Score arc */}
        <circle cx="60" cy="60" r="52" fill="none"
          stroke={color} strokeWidth="9" strokeLinecap="round"
          strokeDasharray={`${dash} ${CIRCUMFERENCE}`}
          style={{ filter: `drop-shadow(0 0 7px ${color}99)` }}
        />
      </svg>
      <div className="relative flex flex-col items-center select-none">
        <span className="font-mono text-5xl font-bold tabular-nums leading-none"
              style={{ color }}>
          {display}
        </span>
        <span className="font-mono text-xs text-slate-500 mt-1">/ 100</span>
        <span className="font-mono text-2xl font-bold mt-2" style={{ color }}>
          {grade}
        </span>
      </div>
    </div>
  );
}

// ── Category card ──────────────────────────────────────────────────────────

const CAT_META = {
  security:      { label: 'Infrastructure Security', icon: '⬡', desc: 'Security headers · information leaks' },
  llmReadiness:  { label: 'LLM & RAG Readiness',     icon: '◈', desc: 'AI crawlers · semantic HTML5' },
  enterpriseSeo: { label: 'Enterprise SEO',           icon: '◇', desc: 'Title · meta · Open Graph · JSON-LD' },
  technicalSeo:  { label: 'Technical SEO',            icon: '△', desc: 'Sitemap · canonical · hreflang' },
};

function CategoryCard({ catKey, data, metrics, delay = 0 }) {
  const [open, setOpen]       = useState(false);
  const [visible, setVisible] = useState(false);
  const meta  = CAT_META[catKey] ?? { label: catKey, icon: '○', desc: '' };
  const color = pctColor(data.percentage);
  const items = extractCategoryItems(catKey, metrics);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(t);
  }, [delay]);

  return (
    <div
      onClick={() => items.length > 0 && setOpen(o => !o)}
      className="bg-[#0a0f1e] border border-white/5 rounded-lg p-4 transition-all duration-300"
      style={{
        cursor: items.length > 0 ? 'pointer' : 'default',
        borderColor: open ? `${color}33` : undefined,
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(10px)',
        transition: 'opacity 0.35s ease, transform 0.35s ease, border-color 0.2s',
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-base leading-none" style={{ color }}>{meta.icon}</span>
            <span className="font-mono text-xs font-bold tracking-wider text-slate-300 uppercase">
              {meta.label}
            </span>
          </div>
          <p className="font-mono text-xs text-slate-600 mt-1">{meta.desc}</p>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="font-mono text-2xl font-bold leading-none" style={{ color }}>
            {data.percentage}%
          </div>
          <div className="font-mono text-xs text-slate-600 mt-1">
            {data.score} / {data.maxScore}
          </div>
        </div>
      </div>

      <div className="mt-3">
        <ProgressBar pct={data.percentage} />
      </div>

      {open && items.length > 0 && (
        <div className="mt-3 pt-3 border-t border-white/5 space-y-1.5">
          {items.map((item, i) => (
            <div key={i} className="flex items-center gap-2 font-mono text-xs">
              <span className={
                item.status === 'pass'    ? 'text-emerald-400' :
                item.status === 'warning' ? 'text-yellow-400'  : 'text-red-400'
              }>
                {item.status === 'pass' ? '✔' : item.status === 'warning' ? '⚠' : '✖'}
              </span>
              <span className="text-slate-400">{item.name}</span>
            </div>
          ))}
        </div>
      )}

      {items.length > 0 && (
        <div className="mt-2 font-mono text-xs text-slate-700 text-right">
          {open ? '▲ collapse' : `▼ ${items.length} checks`}
        </div>
      )}
    </div>
  );
}

// ── Telemetry panel ────────────────────────────────────────────────────────

function TelemetryPanel({ logs }) {
  const [open, setOpen] = useState(false);
  const counts = logs.reduce((acc, l) => {
    acc[l.level] = (acc[l.level] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="bg-[#0a0f1e] border border-white/5 rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-white/[0.02] transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center gap-5">
          <span className="font-mono text-xs font-bold tracking-widest text-slate-400 uppercase">
            Telemetry Log
          </span>
          <div className="flex gap-4 font-mono text-xs">
            {counts.CRITICAL > 0 && (
              <span style={{ color: '#ff4a4a' }}>● {counts.CRITICAL} critical</span>
            )}
            {counts.WARNING > 0 && (
              <span className="text-yellow-400">● {counts.WARNING} warning</span>
            )}
            {counts.PASS > 0 && (
              <span className="text-emerald-400">● {counts.PASS} pass</span>
            )}
          </div>
        </div>
        <span className="font-mono text-xs text-slate-600">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="border-t border-white/5 px-5 py-4 overflow-y-auto max-h-80 space-y-1.5">
          {logs.map((log, i) => (
            <div key={i} className="flex gap-3 font-mono text-xs leading-relaxed">
              <span className="text-slate-700 flex-shrink-0 w-5 text-right select-none">
                {i + 1}
              </span>
              <span className={`flex-shrink-0 w-14 ${
                log.level === 'CRITICAL' ? 'text-red-400' :
                log.level === 'WARNING'  ? 'text-yellow-400' : 'text-emerald-500'
              }`}>
                [{log.level === 'CRITICAL' ? 'CRIT' : log.level === 'WARNING' ? 'WARN' : 'PASS'}]
              </span>
              <span className="text-slate-400">{log.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────

export default function App() {
  const [url, setUrl]             = useState('');
  const [phase, setPhase]         = useState('idle');
  const [result, setResult]       = useState(null);
  const [errorMsg, setErrorMsg]   = useState('');
  const [scanLines, setScanLines] = useState([]);

  const apiResultRef    = useRef(null);
  const terminalDoneRef = useRef(false);
  const timersRef       = useRef([]);

  // Stable ref to avoid stale closure inside setTimeout callbacks
  const tryTransition = useRef(null);
  tryTransition.current = () => {
    if (apiResultRef.current && terminalDoneRef.current) {
      setResult(apiResultRef.current);
      setPhase('results');
    }
  };

  useEffect(() => () => timersRef.current.forEach(clearTimeout), []);

  const runScan = useCallback(async () => {
    let target = url.trim();
    if (!target) return;
    if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

    setPhase('scanning');
    setScanLines([]);
    setErrorMsg('');
    apiResultRef.current    = null;
    terminalDoneRef.current = false;
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];

    // Terminal animation — runs independently of API call
    SCAN_LINES.forEach((line, idx) => {
      const t = setTimeout(() => {
        setScanLines(prev => [...prev, line]);
        if (idx === SCAN_LINES.length - 1) {
          terminalDoneRef.current = true;
          tryTransition.current();
        }
      }, line.delay);
      timersRef.current.push(t);
    });

    // API call — result held in ref; transition fires when terminal also finishes
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/audit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUrl: target }),
      });
      const json = await res.json();

      if (!res.ok) {
        timersRef.current.forEach(clearTimeout);
        setErrorMsg(json?.error?.message ?? `HTTP ${res.status}: audit failed`);
        setPhase('error');
        return;
      }

      apiResultRef.current = json;
      tryTransition.current();
    } catch (err) {
      timersRef.current.forEach(clearTimeout);
      setErrorMsg(err.message ?? 'Network error — is the AutoNode Pulse API running on port 3000?');
      setPhase('error');
    }
  }, [url]);

  const reset = useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    setPhase('idle');
    setResult(null);
    setScanLines([]);
    setErrorMsg('');
  }, []);

  // ── Idle ────────────────────────────────────────────────────────────────

  if (phase === 'idle') return (
    <div className="min-h-screen bg-[#030712] grid-bg flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-xl space-y-10 text-center">

        <div className="space-y-3">
          <div className="flex items-center justify-center gap-3">
            <span className="text-3xl" style={{ filter: 'drop-shadow(0 0 14px #00ff88)' }}>⚡</span>
            <h1 className="font-mono text-4xl font-bold text-white tracking-tight">
              AutoNode <span style={{ color: '#00ff88' }}>Pulse</span>
            </h1>
          </div>
          <p className="font-mono text-xs text-slate-500 tracking-widest uppercase">
            Architectural Auditing · LLM-Readiness · CI/CD Quality Gate
          </p>
        </div>

        <div className="space-y-4">
          <input
            autoFocus
            type="text"
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && runScan()}
            placeholder="https://target-ecosystem-node.com"
            className="w-full bg-[#0a0f1e] border border-white/10 rounded px-4 py-4
                       font-mono text-sm text-slate-200 placeholder-slate-700
                       focus:outline-none focus:border-emerald-500/40 transition-colors duration-200"
            style={{ caretColor: '#00ff88' }}
          />
          <GlowButton onClick={runScan} disabled={!url.trim()}>
            ⟩ Scan Ecosystem Node
          </GlowButton>
        </div>

        <div className="flex items-center justify-center gap-5 font-mono text-xs text-slate-700">
          <span>LLM Readiness</span>
          <span className="text-slate-800">·</span>
          <span>Security Headers</span>
          <span className="text-slate-800">·</span>
          <span>Enterprise SEO</span>
          <span className="text-slate-800">·</span>
          <span>Technical SEO</span>
        </div>
      </div>
    </div>
  );

  // ── Scanning ─────────────────────────────────────────────────────────────

  if (phase === 'scanning') return (
    <div className="min-h-screen bg-[#030712] grid-bg flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-2xl space-y-6">
        <div className="text-center">
          <p className="font-mono text-xs tracking-widest uppercase mb-1"
             style={{ color: '#00ff88' }}>Scanning Ecosystem Node</p>
          <p className="font-mono text-xs text-slate-500 truncate">{url}</p>
        </div>

        <div className="bg-[#0a0f1e] border border-white/5 rounded-lg p-6 flex gap-8 items-start">
          <div className="flex flex-col items-center gap-3">
            <RadarSvg />
            <p className="font-mono text-xs tracking-widest animate-pulse"
               style={{ color: '#00ff88', opacity: 0.55 }}>SCANNING</p>
          </div>
          <div className="flex-1 min-w-0 flex flex-col gap-2">
            <p className="font-mono text-xs text-slate-700 tracking-widest uppercase">Audit Log</p>
            <ScanTerminal lines={scanLines} />
          </div>
        </div>
      </div>
    </div>
  );

  // ── Error ─────────────────────────────────────────────────────────────────

  if (phase === 'error') return (
    <div className="min-h-screen bg-[#030712] grid-bg flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-md space-y-5 text-center">
        <div className="bg-[#0a0f1e] rounded-lg p-6 space-y-3"
             style={{ border: '1px solid rgba(255,74,74,0.25)' }}>
          <p className="font-mono text-xs tracking-widest uppercase" style={{ color: '#ff4a4a' }}>
            Audit Failed
          </p>
          <p className="font-mono text-sm text-slate-400">{errorMsg}</p>
        </div>
        <GlowButton onClick={reset}>↩ New Scan</GlowButton>
      </div>
    </div>
  );

  // ── Results ───────────────────────────────────────────────────────────────

  if (!result) return null;

  const { pulseScore, categories, targetUrl, finalUrl, httpStatus, auditedAt } = result;
  const breakdown = pulseScore?.breakdown ?? {};
  const telemetry = buildTelemetry(result);
  const catOrder  = ['security', 'llmReadiness', 'enterpriseSeo', 'technicalSeo'];
  const showRedirect = finalUrl && finalUrl !== targetUrl && finalUrl !== `${targetUrl}/`;

  return (
    <div className="min-h-screen bg-[#030712] grid-bg">

      {/* Sticky nav */}
      <div className="sticky top-0 z-10 bg-[#030712]/90 backdrop-blur border-b border-white/5">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <span style={{ color: '#00ff88', filter: 'drop-shadow(0 0 8px #00ff88)' }}>⚡</span>
            <span className="font-mono text-xs font-bold text-white tracking-wider hidden sm:block">
              AutoNode Pulse
            </span>
            <span className="text-slate-700 hidden sm:block">|</span>
            <span className="font-mono text-xs text-slate-400 truncate max-w-xs">{targetUrl}</span>
            {showRedirect && (
              <span className="font-mono text-xs text-slate-700 hidden lg:block">→ {finalUrl}</span>
            )}
          </div>
          <div className="flex items-center gap-4 flex-shrink-0">
            <span className={`font-mono text-xs hidden sm:block ${
              httpStatus === 200 ? 'text-emerald-500' : 'text-yellow-500'
            }`}>
              HTTP {httpStatus}
            </span>
            <span className="font-mono text-xs text-slate-600 hidden md:block">
              {new Date(auditedAt).toLocaleTimeString()}
            </span>
            <GlowButton onClick={reset} small>↩ New Scan</GlowButton>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="max-w-6xl mx-auto px-6 py-10 space-y-8">

        {/* Score + category grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* Circular gauge */}
          <div className="bg-[#0a0f1e] border border-white/5 rounded-lg p-6
                          flex flex-col items-center justify-center gap-5">
            <p className="font-mono text-xs text-slate-600 tracking-widest uppercase">
              Overall Pulse Score
            </p>
            <CircularGauge score={pulseScore.overall} grade={pulseScore.grade} />
            {pulseScore.summary?.topRecommendations?.[0] && (
              <p className="font-mono text-xs text-slate-500 text-center max-w-[200px] leading-relaxed">
                {pulseScore.summary.topRecommendations[0]}
              </p>
            )}
            {pulseScore.summary?.criticalIssues?.length > 0 && (
              <p className="font-mono text-xs text-center leading-relaxed mt-1" style={{ color: '#ff4a4a' }}>
                {pulseScore.summary.criticalIssues[0]}
              </p>
            )}
          </div>

          {/* 2×2 category cards */}
          <div className="lg:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {catOrder.map((key, idx) => {
              const bd = breakdown[key];
              if (!bd) return null;
              return (
                <CategoryCard
                  key={key}
                  catKey={key}
                  data={bd}
                  metrics={categories?.[key]?.metrics}
                  delay={idx * 90}
                />
              );
            })}
          </div>
        </div>

        {/* Telemetry */}
        <TelemetryPanel logs={telemetry} />

        <p className="font-mono text-xs text-slate-800 text-center">
          pulse.autonode.tech — Audited {new Date(auditedAt).toLocaleString()}
        </p>
      </div>
    </div>
  );
}
