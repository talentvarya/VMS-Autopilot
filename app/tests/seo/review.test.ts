import { describe, expect, it } from 'vitest';
import { limitHtml, runAudit } from '@/lib/seo/engine';
import { neutralizeCell } from '@/lib/seo/csv';
import { UnsafeUrlError, assertSafeUrl } from '@/lib/seo/safe-url';
import type { SiteSnapshot } from '@/lib/seo/types';

/**
 * Tests for findings from the independent SEO-accuracy and security reviews of Phase 2.
 */

const goodHtml = `<!doctype html><html lang="en"><head><title>A perfectly reasonable page title for testing</title>
<meta name="description" content="A description that is comfortably long enough to be useful to a searcher, but not too long to be cut.">
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="canonical" href="https://x.example.test/"></head>
<body><main><h1>Main heading</h1><p>${'word '.repeat(320)}</p></main></body></html>`;
const snap = (over: Partial<SiteSnapshot> = {}): SiteSnapshot => ({
  url: 'https://x.example.test/', status: 200, html: goodHtml, fetchedAt: '2025-01-01T00:00:00Z', ...over,
});
const lines = (...l: string[]) => l.join('\n');
const find = (r: ReturnType<typeof runAudit>, code: string) => r.findings.find((f) => f.code === code);
const codes = (r: ReturnType<typeof runAudit>) => r.findings.map((f) => f.code);

describe('SEO accuracy (from the SEO specialist review)', () => {
  it('a "*" block is not critical when Googlebot has its own allowing rule', () => {
    const r = runAudit(snap({ robotsTxt: lines('User-agent: *', 'Disallow: /', '', 'User-agent: Googlebot', 'Allow: /') }));
    expect(codes(r)).not.toContain('robots.blocks_all');
    expect(find(r, 'robots.blocks_other_crawlers')!.severity).toBe('medium');
    expect(r.overallNote).toBeNull(); // no score cap
  });

  it('is critical when Googlebot itself is blocked, by name or through "*"', () => {
    expect(find(runAudit(snap({ robotsTxt: lines('User-agent: Googlebot', 'Disallow: /') })), 'robots.blocks_all')!.severity).toBe('critical');
    expect(find(runAudit(snap({ robotsTxt: lines('User-agent: *', 'Disallow: /') })), 'robots.blocks_all')!.severity).toBe('critical');
    expect(find(runAudit(snap({ robotsTxt: lines('User-agent: *', 'Disallow: /*') })), 'robots.blocks_all')).toBeDefined();
  });

  it('a missing robots.txt is only a suggestion', () => {
    expect(find(runAudit(snap({ robotsTxt: null })), 'robots.missing')!.severity).toBe('low');
  });

  it('a page the checker was refused (403/429/503) is not reported as a dead page, and does not cap the score', () => {
    for (const status of [403, 429, 503]) {
      const r = runAudit(snap({ status }));
      expect(find(r, 'status.refused')!.severity).toBe('medium');
      expect(codes(r)).not.toContain('status.error');
      expect(r.overallNote).toBeNull();
    }
    const gone = runAudit(snap({ status: 404 }));
    expect(find(gone, 'status.error')!.severity).toBe('critical');
    expect(gone.overallNote).toContain('returns an error');
  });

  it('understands meta robots "none" and a googlebot-specific noindex', () => {
    const withMeta = (m: string) => goodHtml.replace('</head>', `${m}</head>`);
    expect(codes(runAudit(snap({ html: withMeta('<meta name="robots" content="none">') })))).toContain('index.noindex');
    expect(codes(runAudit(snap({ html: withMeta('<meta name="googlebot" content="noindex">') })))).toContain('index.noindex');
    expect(codes(runAudit(snap({ html: withMeta('<meta name="robots" content="index, follow">') })))).not.toContain('index.noindex');
  });

  it('counts relative links as internal, and ignores anchors, mail and phone links', () => {
    const page = (links: string) => runAudit(snap({ html: goodHtml.replace('<main>', `<main>${links}`) }));
    expect(codes(page('<a href="about.html">About</a>'))).toContain('links.internal_ok');
    expect(codes(page('<a href="services/">Services</a>'))).toContain('links.internal_ok');
    expect(codes(page('<a href="/contact">Contact</a>'))).toContain('links.internal_ok');
    expect(codes(page('<a href="https://x.example.test/prices">Prices</a>'))).toContain('links.internal_ok');
    expect(codes(page('<a href="#top">Top</a><a href="mailto:a@b.test">Mail</a><a href="tel:123">Call</a><a href="https://other.example.test/">Other</a>'))).toContain('links.no_internal');
  });

  it('does not call a missing default sitemap a fault when robots.txt names another', () => {
    const r = runAudit(snap({ robotsTxt: lines('User-agent: *', 'Allow: /', 'Sitemap: https://x.example.test/wp-sitemap.xml'), sitemapXml: null }));
    expect(find(r, 'sitemap.other_location')!.severity).toBe('info');
    expect(codes(r)).not.toContain('sitemap.missing');
    expect(find(runAudit(snap({ robotsTxt: 'User-agent: *\nAllow: /', sitemapXml: null })), 'sitemap.missing')).toBeDefined();
  });

  it('recognises many kinds of local business, and any business with an address and phone', () => {
    const withSchema = (json: string) => runAudit(snap({ html: goodHtml.replace('</head>', `<script type="application/ld+json">${json}</script></head>`) }), { businessType: 'local' });
    for (const type of ['HairSalon', 'Plumber', 'Bakery', 'Hotel', 'GymOrFitnessCenter', 'Attorney', 'Pharmacy', 'Dentist', 'FoodEstablishment', 'ProfessionalService']) {
      expect(codes(withSchema(`{"@type":"${type}","name":"X"}`)), type).toContain('local.schema_ok');
    }
    expect(codes(withSchema('{"@type":"Thing","name":"X","address":"1 High St","telephone":"1"}'))).toContain('local.schema_ok');
    expect(codes(withSchema('{"@type":"Service","name":"Cleaning"}'))).toContain('local.schema_missing'); // a product service is not a business
    expect(codes(withSchema('{"@type":"EducationalOrganization","name":"School","sameAs":["https://a.test"]}'))).toContain('geo.entity_ok');
  });

  it('separates AI search crawlers from AI training crawlers, and does not overstate', () => {
    const only = (agent: string) => find(runAudit(snap({ robotsTxt: lines(`User-agent: ${agent}`, 'Disallow: /', '', 'User-agent: *', 'Allow: /') })), 'geo.ai_blocked')!;
    expect(only('ClaudeBot').severity).toBe('info');
    expect(only('GPTBot').severity).toBe('info');
    expect(only('Google-Extended').recommendation).toContain('opt-out');
    for (const agent of ['OAI-SearchBot', 'PerplexityBot', 'Claude-SearchBot', 'ChatGPT-User']) expect(only(agent).severity).toBe('medium');
  });

  it('labels llms.txt as optional and unproven, and never presents it as a pass', () => {
    const present = find(runAudit(snap({ llmsTxt: '# Site' })), 'geo.llms_txt')!;
    expect(present.severity).toBe('info');
    expect(present.recommendation).toContain('unproven');
    expect(find(runAudit(snap({ llmsTxt: null })), 'geo.llms_txt_missing')!.title).toContain('optional');
  });

  it('does not claim FAQ markup is what AI quotes most', () => {
    const f = find(runAudit(snap()), 'geo.faq_missing')!;
    expect(f.recommendation).not.toContain('quote this format most');
    expect(f.recommendation).toContain('optional');
  });

  it('only asks for author and date on article-like pages', () => {
    expect(codes(runAudit(snap()))).not.toContain('geo.trust_missing');
    const article = goodHtml.replace('<main>', '<main><article>').replace('</main>', '</article></main>');
    expect(codes(runAudit(snap({ html: article })))).toContain('geo.trust_missing');
  });

  it('ignores an SVG <title> when looking for the page title', () => {
    const html = goodHtml.replace(/<title>.*<\/title>/, '').replace('<body>', '<body><svg><title>Icon</title></svg>');
    expect(codes(runAudit(snap({ html })))).toContain('title.missing');
  });

  it('warns that a JavaScript-built page may look emptier than it is', () => {
    const shell = '<!doctype html><html lang="en"><head><title>An app that draws itself with JavaScript</title></head><body><div id="root"></div><script src="/a.js"></script><script src="/b.js"></script></body></html>';
    const f = find(runAudit(snap({ html: shell })), 'render.js_only')!;
    expect(f.severity).toBe('info');
    expect(f.recommendation).toContain('JavaScript');
    expect(codes(runAudit(snap()))).not.toContain('render.js_only');
  });

  it('tells the reader what cannot be checked about Google Business Profile', () => {
    expect(codes(runAudit(snap()))).toContain('local.unverifiable');
  });

  it('rates severities in proportion', () => {
    const bare = runAudit(snap({ html: '<!doctype html><html><head></head><body><h1>Hi</h1><h1>There</h1></body></html>' }));
    expect(find(bare, 'h1.multiple')!.severity).toBe('low');
    const noH1 = runAudit(snap({ html: goodHtml.replace('<h1>Main heading</h1>', '') }));
    expect(find(noH1, 'h1.missing')!.severity).toBe('medium');
    expect(find(runAudit(snap({ html: goodHtml.replace(/<title>.*<\/title>/, '<title>Home</title>') })), 'title.short')!.severity).toBe('low');
    expect(find(runAudit(snap({ html: goodHtml.replace(/<link rel="canonical"[^>]*>/, '') })), 'canonical.missing')!.severity).toBe('low');
  });
});

describe('a hostile website cannot freeze or break an audit (from the security review)', () => {
  const started = () => performance.now();
  const took = (t: number) => performance.now() - t;

  it('the depth guard cannot be bypassed by hiding "<" inside a quoted attribute', () => {
    const t = started();
    const r = runAudit(snap({ html: '<div a="<">'.repeat(50_000) }));
    expect(took(t)).toBeLessThan(5_000);
    expect(codes(r)).toContain('html.too_deep');
    expect(limitHtml('<div a="<">'.repeat(1000)).maxDepth).toBeGreaterThan(200); // quotes are understood
  });

  it('other nesting tricks are caught too', () => {
    for (const unit of ["<div a='>'>", '<div\n>', '<DIV>', '<div data-x="a>b">', '<span><div>']) {
      const t = started();
      const r = runAudit(snap({ html: unit.repeat(30_000) }));
      expect(took(t), unit).toBeLessThan(6_000);
      expect(codes(r).some((c) => c === 'html.too_deep' || c === 'html.too_complex'), unit).toBe(true);
    }
  });

  it('an enormous number of flat tags is cut off before the slow parser sees it', () => {
    const t = started();
    const r = runAudit(snap({ html: '<a href="/x">x</a>'.repeat(30_000) }));
    expect(took(t)).toBeLessThan(6_000);
    expect(codes(r)).toContain('html.too_complex');
  });

  it('tags inside comments, scripts and styles do not count as nesting', () => {
    const noise = '<!-- ' + '<div>'.repeat(10_000) + ' --><script>' + '<div>'.repeat(10_000) + '</script><style>' + '<div>'.repeat(10_000) + '</style>';
    const r = limitHtml('<html><body>' + noise + '<p>real</p></body></html>');
    expect(r.truncatedDepth).toBe(false);
    expect(r.truncatedTags).toBe(false);
    expect(r.maxDepth).toBeLessThan(5);
  });

  it('a very long repeated "google." link or sameAs cannot cause catastrophic backtracking', () => {
    const evil = 'google.'.repeat(80_000);
    const t = started();
    runAudit(snap({ html: goodHtml.replace('<main>', `<main><a href="${evil}">x</a><iframe src="${evil}"></iframe>`) }));
    const ld = `<script type="application/ld+json">{"@type":"Dentist","name":"D","sameAs":"${evil}"}</script>`;
    runAudit(snap({ html: goodHtml.replace('</head>', `${ld}</head>`) }));
    expect(took(t)).toBeLessThan(2_000);
  });

  it('deeply nested structured data does not crash the audit', () => {
    let nested = '"x"';
    for (let i = 0; i < 3000; i++) nested = `[${nested}]`;
    const ld = `<script type="application/ld+json">{"@type":"Dentist","name":"D","sameAs":${nested}}</script>`;
    expect(() => runAudit(snap({ html: goodHtml.replace('</head>', `${ld}</head>`) }))).not.toThrow();
  });

  it('never returns text the database would refuse (control characters or half an emoji)', () => {
    const title = 'A'.repeat(73) + '😀😀😀 tail' + '\u0000\u0001';
    const r = runAudit(snap({ html: goodHtml.replace(/<title>.*<\/title>/, `<title>${title}</title>`) }));
    for (const f of r.findings) {
      expect(f.evidence).not.toMatch(/[\u0000-\u001f]/);
      expect(f.evidence).toBe(f.evidence.toWellFormed());
      expect(JSON.stringify(f)).not.toContain('\\ud83d\\"'); // no lone surrogate in the JSON
    }
    const cut = r.findings.find((f) => f.code === 'title.long')!;
    expect(cut.evidence).toBe(cut.evidence.toWellFormed());
  });
});

describe('address and CSV guards (from the security review)', () => {
  it.each([
    'http://localhost../', 'http://foo.localhost../', 'http://metadata.google.internal../', 'http://localhost.../',
    'http://a..b.com/', 'http://.example.com/', 'http://intranet../',
  ])('rejects %s', (address) => {
    expect(() => assertSafeUrl(address)).toThrow(UnsafeUrlError);
  });

  it('still accepts an ordinary name with a single trailing dot', () => {
    expect(assertSafeUrl('https://example.com./about').hostname).toBe('example.com.');
  });

  it('neutralises a formula hidden behind spaces, non-breaking spaces or a line break', () => {
    for (const evil of [' =1+1', '   +1', ' @SUM(A1)', '﻿=1', '\n=1+1', '\t-2']) {
      expect(neutralizeCell(evil).startsWith("'"), JSON.stringify(evil)).toBe(true);
    }
    expect(neutralizeCell('Hello = world')).toBe('Hello = world');
    expect(neutralizeCell('Nova Clinic')).toBe('Nova Clinic');
  });
});
