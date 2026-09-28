import { describe, expect, it } from 'vitest';
import { blocksWholeSite, limitHtml, parseRobots, runAudit, scoreFindings } from '@/lib/seo/engine';
import { FIXTURE_SITES } from '@/lib/seo/fixtures';
import { CATEGORIES, SEVERITIES, type SiteSnapshot } from '@/lib/seo/types';

const site = (id: string) => FIXTURE_SITES.find((s) => s.id === id)!;
const audit = (id: string) => runAudit(site(id).snapshot, { businessType: site(id).businessType });
const codes = (r: ReturnType<typeof runAudit>, sev?: string) => r.findings.filter((f) => !sev || f.severity === sev).map((f) => f.code);

/** A snapshot of a nearly-perfect page, to test one problem at a time. */
const goodHtml = `<!doctype html><html lang="en"><head><title>A perfectly reasonable page title for testing</title>
<meta name="description" content="A description that is comfortably long enough to be useful to a searcher, but not too long to be cut.">
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="canonical" href="https://x.example.test/"></head>
<body><main><h1>Main heading</h1><p>${'word '.repeat(320)}</p></main></body></html>`;
const snap = (over: Partial<SiteSnapshot> = {}): SiteSnapshot => ({
  url: 'https://x.example.test/', status: 200, html: goodHtml, fetchedAt: '2025-01-01T00:00:00Z', ...over,
});

describe('sample websites', () => {
  it('Nova Clinic is healthy, with a few things to improve', () => {
    const r = audit('nova-clinic');
    expect(r.overallScore).toBeGreaterThanOrEqual(80);
    expect(r.counts.critical).toBe(0);
    expect(codes(r)).toContain('images.alt_missing');
    expect(codes(r)).toContain('local.hours_missing');
    expect(codes(r, 'pass')).toEqual(expect.arrayContaining(['https.ok', 'title.ok', 'h1.ok', 'viewport.ok', 'local.schema_ok', 'geo.faq_ok', 'canonical.ok']));
  });

  it('Bright Homes has a middling score with clear on-page and AI-visibility problems', () => {
    const r = audit('bright-homes');
    expect(r.overallScore).toBeGreaterThan(40);
    expect(r.overallScore).toBeLessThan(80); // "Needs work"
    expect(r.overallNote).toBeNull();
    expect(codes(r)).toEqual(expect.arrayContaining([
      'title.short', 'description.missing', 'h1.multiple', 'headings.skip', 'images.alt_missing', 'viewport.fixed',
      'sitemap.missing', 'geo.ai_blocked', 'local.schema_missing', 'geo.entity_missing', 'lcp.needs_work', 'cls.needs_work', 'links.vague_text',
    ]));
    const blocked = r.findings.find((f) => f.code === 'geo.ai_blocked')!;
    expect(blocked.evidence).toContain('GPTBot');
    expect(blocked.evidence).toContain('ClaudeBot');
    expect(blocked.severity).toBe('info'); // GPTBot and ClaudeBot are TRAINING crawlers: blocking them is a choice
  });

  it('Urban Eats is a mess and says so plainly', () => {
    const r = audit('urban-eats');
    expect(r.overallScore).toBeLessThanOrEqual(40);
    expect(r.overallNote).toContain('cannot be higher than 40');
    expect(codes(r, 'critical')).toEqual(expect.arrayContaining(['index.noindex', 'robots.blocks_all']));
    expect(codes(r)).toEqual(expect.arrayContaining(['https.missing', 'title.missing', 'h1.missing', 'viewport.missing', 'lang.missing', 'geo.jsonld_invalid', 'lcp.poor']));
  });

  it('is deterministic: the same page always gets the same report', () => {
    expect(audit('bright-homes')).toEqual(audit('bright-homes'));
  });

  it('ranks the three sample sites in the right order', () => {
    const [nova, bright, urban] = ['nova-clinic', 'bright-homes', 'urban-eats'].map((id) => audit(id).overallScore!);
    expect(nova).toBeGreaterThan(bright);
    expect(bright).toBeGreaterThan(urban);
  });
});

describe('individual checks', () => {
  it('a clean page has no critical or high findings', () => {
    const r = runAudit(snap({ robotsTxt: 'User-agent: *\nAllow: /\nSitemap: https://x.example.test/s.xml', sitemapXml: '<urlset><url><loc>https://x.example.test/</loc></url></urlset>' }), { businessType: 'online' });
    expect(r.counts.critical + r.counts.high).toBe(0);
  });

  it('flags server errors, redirects and http pages', () => {
    expect(codes(runAudit(snap({ status: 500 }), { businessType: 'online' }), 'critical')).toContain('status.error');
    expect(codes(runAudit(snap({ status: 301 }))).includes('status.redirect')).toBe(true);
    expect(codes(runAudit(snap({ url: 'http://x.example.test/' })), 'high')).toContain('https.missing');
  });

  it('detects noindex from the page and from the response header', () => {
    expect(codes(runAudit(snap({ html: goodHtml.replace('</head>', '<meta name="robots" content="NOINDEX,follow"></head>') })), 'critical')).toContain('index.noindex');
    expect(codes(runAudit(snap({ headers: { 'x-robots-tag': 'noindex' } })), 'critical')).toContain('index.noindex');
  });

  it('checks the canonical points at the page itself', () => {
    const other = goodHtml.replace('href="https://x.example.test/"', 'href="https://x.example.test/other"');
    expect(codes(runAudit(snap({ html: other })))).toContain('canonical.other');
    expect(codes(runAudit(snap({ html: goodHtml.replace(/<link rel="canonical"[^>]*>/, '') })))).toContain('canonical.missing');
    expect(() => runAudit(snap({ html: goodHtml.replace('https://x.example.test/', 'http://[bad') }))).not.toThrow();
  });

  it('title and description length rules', () => {
    const withTitle = (t: string) => goodHtml.replace(/<title>.*<\/title>/, `<title>${t}</title>`);
    expect(codes(runAudit(snap({ html: withTitle('Short') })))).toContain('title.short');
    expect(codes(runAudit(snap({ html: withTitle('x'.repeat(80)) })))).toContain('title.long');
    expect(codes(runAudit(snap({ html: goodHtml.replace(/<title>.*<\/title>/, '') })), 'high')).toContain('title.missing');
  });

  it('counts words on the visible page only, not scripts or styles', () => {
    const noisy = goodHtml.replace('<p>', `<script>${'x '.repeat(1000)}</script><style>${'y '.repeat(1000)}</style><p>`).replace('word '.repeat(320), 'just a few words here');
    expect(codes(runAudit(snap({ html: noisy })))).toContain('content.thin');
  });

  it('does not crash on empty or broken HTML', () => {
    for (const html of ['', '<', '<html><body><h1>', '\u0000\u0001', '<div>'.repeat(5000)]) {
      const r = runAudit(snap({ html }));
      expect(r.findings.length).toBeGreaterThan(0);
    }
  });

  it('cannot be frozen by deeply nested or enormous pages', () => {
    const started = performance.now();
    const nested = runAudit(snap({ html: '<div>'.repeat(50_000) }));
    const huge = runAudit(snap({ html: '<p>x</p>'.repeat(1_000_000) })); // 8 million characters
    const unterminated = runAudit(snap({ html: '<a '.repeat(200_000) }));
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(codes(nested)).toContain('html.too_deep');
    expect(codes(huge)).toEqual(expect.arrayContaining(['html.truncated', 'weight.huge']));
    expect(unterminated.findings.length).toBeGreaterThan(0);
  }, 30_000);

  it('does not mistake ordinary pages for too deep', () => {
    expect(codes(audit('nova-clinic'))).not.toContain('html.too_deep');
    expect(limitHtml(site('nova-clinic').snapshot.html).maxDepth).toBeLessThan(15);
    expect(limitHtml('<br><img><input><p>text</p>').maxDepth).toBe(1);
  });

  it('understands robots.txt groups', () => {
    const r = parseRobots('User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n# comment\nUser-agent: *\nDisallow: /private\nSitemap: https://a/sitemap.xml');
    expect(blocksWholeSite(r, 'GPTBot')).toBe(true);
    expect(blocksWholeSite(r, 'ClaudeBot')).toBe(true);
    expect(blocksWholeSite(r, 'PerplexityBot')).toBe(false);
    expect(blocksWholeSite(r, '*')).toBe(false);
    expect(r.sitemaps).toEqual(['https://a/sitemap.xml']);
    expect(blocksWholeSite(parseRobots('User-agent: *\nDisallow: /\nAllow: /'), '*')).toBe(false);
  });

  it('uses speed measurements when present and says so when absent', () => {
    expect(codes(runAudit(snap()))).toContain('speed.not_measured');
    expect(runAudit(snap()).categoryScores.performance).toBeNull();
    const poor = runAudit(snap({ metrics: { lcpMs: 6000, cls: 0.5, inpMs: 900 } }));
    expect(codes(poor, 'high')).toEqual(expect.arrayContaining(['lcp.poor', 'cls.poor', 'inp.poor']));
    expect(poor.categoryScores.performance).toBeLessThan(50);
  });

  it('treats local-business checks as advice, not faults, for online-only businesses', () => {
    const local = runAudit(snap(), { businessType: 'local' });
    const online = runAudit(snap(), { businessType: 'online' });
    expect(local.findings.find((f) => f.code === 'local.schema_missing')!.severity).toBe('medium');
    expect(online.findings.find((f) => f.code === 'local.schema_missing')!.severity).toBe('info');
  });

  it('never puts page text into HTML - evidence is plain, short text', () => {
    const evil = goodHtml.replace('Main heading', '<b>Main</b> heading '.repeat(100)).replace(/<title>.*<\/title>/, '<title><script>alert(1)</script>Tiny</title>');
    for (const f of runAudit(snap({ html: evil })).findings) {
      expect(f.evidence.length).toBeLessThanOrEqual(300);
      expect(f.evidence).not.toMatch(/<script|<b>/);
    }
  });
});

describe('scoring', () => {
  it('has a score in 0-100 for every measured category and never NaN', () => {
    for (const s of FIXTURE_SITES) {
      const r = audit(s.id);
      for (const c of CATEGORIES) {
        const v = r.categoryScores[c];
        if (v !== null) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(100); }
      }
      expect(Number.isFinite(r.overallScore!)).toBe(true);
    }
  });

  it('counts add up to the number of findings, and findings are sorted worst-first', () => {
    const r = audit('urban-eats');
    expect(SEVERITIES.reduce((n, s) => n + r.counts[s], 0)).toBe(r.findings.length);
    const order = ['critical', 'high', 'medium', 'low', 'info', 'pass'];
    const ranks = r.findings.map((f) => order.indexOf(f.severity));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('a critical finding costs more than a high, a high more than a medium', () => {
    const one = (severity: 'critical' | 'high' | 'medium' | 'low') =>
      scoreFindings([{ category: 'technical', severity, code: 'x', title: 't', evidence: '', recommendation: '' }]).categoryScores.technical!;
    expect(one('critical')).toBeLessThan(one('high'));
    expect(one('high')).toBeLessThan(one('medium'));
    expect(one('medium')).toBeLessThan(one('low'));
    expect(one('low')).toBeLessThan(100);
  });

  it('caps the overall score at 40 while the page is invisible to search engines', () => {
    const robots = ['User-agent: *', 'Allow: /', 'Sitemap: https://x.example.test/s.xml'].join('\n');
    const sitemapXml = '<urlset><loc>a</loc></urlset>';
    const perfect = runAudit(snap({ robotsTxt: robots, sitemapXml }), { businessType: 'online' });
    const hidden = runAudit(
      snap({ html: goodHtml.replace('</head>', '<meta name="robots" content="noindex"></head>'), robotsTxt: robots, sitemapXml }),
      { businessType: 'online' },
    );
    expect(perfect.overallScore!).toBeGreaterThan(70);
    expect(perfect.overallNote).toBeNull();
    expect(hidden.overallScore).toBe(40);
    expect(hidden.overallNote).toMatch(/until that is fixed/);
    // the per-category scores are still honest
    expect(hidden.categoryScores.onpage).toBe(perfect.categoryScores.onpage);
  });

  it('returns no overall score when nothing can be measured', () => {
    expect(scoreFindings([]).overallScore).toBeNull();
  });
});
