/**
 * The SEO / GEO audit engine.
 *
 * A pure function: it takes a snapshot of a website (HTML, robots.txt, ...) and returns
 * findings and scores. It performs no network access and changes nothing - it can only ever
 * READ what it is given. That is also why a Client may run it: an audit produces a report,
 * never a change to the website.
 *
 * Two honesty rules: the engine reads the HTML the server sends (pages built entirely by
 * JavaScript can look emptier than they are, and the report says so), and it never states
 * as fact something nobody has proven (e.g. that llms.txt helps).
 *
 * Safety rules: the page is UNTRUSTED input. Size and nesting are capped by a linear scanner
 * before parsing, and no regular expression runs on unbounded page-controlled text.
 */

import { parse, type HTMLElement } from 'node-html-parser';
import {
  CATEGORIES,
  ENGINE_VERSION,
  SEVERITIES,
  type AuditOptions,
  type AuditResult,
  type Category,
  type Finding,
  type Severity,
  type SiteSnapshot,
} from './types';

// ---------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------

/** Control characters and half of an emoji (a lone surrogate) are refused by Postgres jsonb. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const clip = (text: string, max = 200) => {
  const clean = text.replace(CONTROL, ' ').replace(LONE_SURROGATE, '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  let cut = clean.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1); // do not split an emoji in half
  return cut + '…';
};

class Collector {
  readonly findings: Finding[] = [];
  add(category: Category, severity: Severity, code: string, title: string, evidence: string, recommendation = '') {
    this.findings.push({ category, severity, code, title, evidence: clip(evidence, 300), recommendation });
  }
  pass(category: Category, code: string, title: string, evidence = '') {
    this.add(category, 'pass', code, title, evidence);
  }
}

interface Page {
  root: HTMLElement;
  url: URL | null;
  jsonLd: { ok: boolean; nodes: Record<string, unknown>[]; errors: number };
  visibleText: string;
}

function safeUrl(u: string): URL | null {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

function resolveUrl(href: string, base: URL | null): URL | null {
  try {
    return new URL(href.slice(0, 2048), base ?? undefined);
  } catch {
    return null;
  }
}

function meta(root: HTMLElement, attr: 'name' | 'property', value: string): string | null {
  const el = root.querySelectorAll('meta').find((m) => m.getAttribute(attr)?.toLowerCase() === value);
  return el ? (el.getAttribute('content') ?? '') : null;
}

function readJsonLd(root: HTMLElement) {
  const nodes: Record<string, unknown>[] = [];
  let errors = 0;
  for (const s of root.querySelectorAll('script')) {
    if ((s.getAttribute('type') ?? '').toLowerCase() !== 'application/ld+json') continue;
    try {
      const data = JSON.parse(s.rawText);
      const stack: unknown[] = Array.isArray(data) ? [...data] : [data];
      while (stack.length && nodes.length < 500) {
        const n = stack.pop();
        if (n && typeof n === 'object') {
          const obj = n as Record<string, unknown>;
          nodes.push(obj);
          const graph = obj['@graph'];
          if (Array.isArray(graph)) stack.push(...graph);
        }
      }
    } catch {
      errors++;
    }
  }
  return { ok: errors === 0, nodes, errors };
}

const typesOf = (node: Record<string, unknown>): string[] => {
  const t = node['@type'];
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === 'string');
};

const wordCount = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);

/** All string values of a JSON-LD property, without ever serialising untrusted nesting. */
function stringValues(value: unknown, limit = 50): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (out.length >= limit || depth > 4) return;
    if (typeof v === 'string') out.push(v.slice(0, 500));
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (v && typeof v === 'object') Object.values(v as object).forEach((x) => walk(x, depth + 1));
  };
  walk(value, 0);
  return out;
}

/** Is this address a Google Maps / Google Business Profile link? (Checks the host, not a regex.) */
function isGoogleBusinessLink(href: string, base: URL | null): boolean {
  const u = resolveUrl(href.slice(0, 500), base);
  if (!u) return false;
  const h = u.hostname.toLowerCase();
  if (h === 'g.page' || h.endsWith('.g.page') || h === 'maps.app.goo.gl' || h === 'business.google.com') return true;
  if (h.startsWith('maps.google.')) return true;
  const parts = h.split('.');
  const googleAt = parts.lastIndexOf('google');
  return googleAt >= 0 && googleAt >= parts.length - 3 && u.pathname.toLowerCase().startsWith('/maps');
}

// ---------------------------------------------------------------------------------------
// input limits (a broken or hostile page must never be able to freeze an audit)
// ---------------------------------------------------------------------------------------

export const MAX_HTML_CHARS = 2_000_000;
export const MAX_NESTING_DEPTH = 300;
export const MAX_TAGS = 15_000;
const MAX_ATTRIBUTE_RUN = 4_096;
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT_TAGS = new Set(['script', 'style']);

const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isNameChar = (c: number) => isLetter(c) || (c >= 48 && c <= 57) || c === 45 || c === 58 || c === 95;

export interface LimitedHtml {
  html: string;
  truncatedSize: boolean;
  truncatedDepth: boolean;
  truncatedTags: boolean;
  maxDepth: number;
}

/**
 * The HTML parser slows down enormously on very deeply nested or very tag-heavy markup, and
 * attackers can hide tags inside quoted attributes. This ONE linear pass walks the text
 * character by character, understands quotes and comments, and cuts the page off before it
 * gets dangerous. Work is bounded: each tag scans at most a few thousand characters.
 */
export function limitHtml(input: string): LimitedHtml {
  const html = input.length > MAX_HTML_CHARS ? input.slice(0, MAX_HTML_CHARS) : input;
  const result: LimitedHtml = { html, truncatedSize: html.length !== input.length, truncatedDepth: false, truncatedTags: false, maxDepth: 0 };
  const n = html.length;
  let depth = 0;
  let tags = 0;
  let i = 0;

  const cutAt = (pos: number, flag: 'truncatedDepth' | 'truncatedTags') => {
    result.html = html.slice(0, pos);
    result[flag] = true;
    return result;
  };

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    const closing = html.charCodeAt(lt + 1) === 47; // "/"
    const nameStart = lt + (closing ? 2 : 1);
    if (!isLetter(html.charCodeAt(nameStart))) {
      i = lt + 1;
      continue;
    }
    if (++tags > MAX_TAGS) return cutAt(lt, 'truncatedTags');

    let nameEnd = nameStart;
    while (nameEnd < n && nameEnd - nameStart < 32 && isNameChar(html.charCodeAt(nameEnd))) nameEnd++;
    const name = html.slice(nameStart, nameEnd).toLowerCase();

    // Find the ">" that ends the tag, skipping over quoted attribute values.
    let quote = 0;
    let k = nameEnd;
    const stop = Math.min(n, nameEnd + MAX_ATTRIBUTE_RUN);
    for (; k < stop; k++) {
      const ch = html.charCodeAt(k);
      if (quote) {
        if (ch === quote) quote = 0;
      } else if (ch === 34 || ch === 39) quote = ch;
      else if (ch === 62) break;
    }
    if (k >= stop || html.charCodeAt(k) !== 62) {
      i = nameEnd; // not a real tag: treat as text
      continue;
    }
    i = k + 1;

    if (closing) {
      depth = Math.max(0, depth - 1);
    } else if (RAW_TEXT_TAGS.has(name)) {
      // Skip the script/style body so text inside it is never mistaken for tags.
      const lower = html.slice(i, Math.min(n, i + MAX_HTML_CHARS)).toLowerCase();
      const end = lower.indexOf('</' + name);
      i = end < 0 ? n : i + end;
    } else if (html.charCodeAt(k - 1) !== 47 && !VOID_TAGS.has(name)) {
      depth++;
      if (depth > result.maxDepth) result.maxDepth = depth;
      if (depth > MAX_NESTING_DEPTH) return cutAt(lt, 'truncatedDepth');
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------------------

interface RobotsGroup {
  agents: string[];
  disallow: string[];
  allow: string[];
}

export function parseRobots(text: string): { groups: RobotsGroup[]; sitemaps: string[] } {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of text.slice(0, 500_000).split(/\r?\n/, 5000)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], disallow: [], allow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === 'sitemap') sitemaps.push(value);
    else if (current && key === 'disallow') current.disallow.push(value);
    else if (current && key === 'allow') current.allow.push(value);
  }
  return { groups, sitemaps };
}

/**
 * Is the whole site blocked for this crawler? A crawler obeys the group that names it; only if
 * there is none does it fall back to the "*" group.
 */
export function blocksWholeSite(robots: ReturnType<typeof parseRobots>, agent: string): boolean {
  const a = agent.toLowerCase();
  const specific = robots.groups.filter((g) => g.agents.includes(a));
  const groups = specific.length ? specific : robots.groups.filter((g) => g.agents.includes('*'));
  if (!groups.length) return false;
  const disallowAll = groups.some((g) => g.disallow.some((d) => d === '/' || d === '/*'));
  const allowSome = groups.some((g) => g.allow.some((p) => p === '/'));
  return disallowAll && !allowSome;
}

// ---------------------------------------------------------------------------------------
// the checks
// ---------------------------------------------------------------------------------------

function technical(c: Collector, snap: SiteSnapshot, page: Page) {
  const cat: Category = 'technical';

  if (page.url?.protocol === 'https:') c.pass(cat, 'https.ok', 'Page is served over HTTPS');
  else c.add(cat, 'high', 'https.missing', 'Page is not served over HTTPS', `Address is ${snap.url}`, 'Install a certificate and redirect all http:// addresses to https://. Browsers warn visitors about insecure pages and Google prefers HTTPS.');

  if (snap.status >= 200 && snap.status < 300) c.pass(cat, 'status.ok', 'Page responds successfully', `HTTP ${snap.status}`);
  else if (snap.status >= 300 && snap.status < 400) c.add(cat, 'info', 'status.redirect', 'Page redirects', `HTTP ${snap.status}`, 'Audit the final destination address, and link directly to it.');
  else if ([401, 403, 407, 429, 503].includes(snap.status)) {
    c.add(cat, 'medium', 'status.refused', 'The website would not let the audit read the page', `HTTP ${snap.status}`, 'A firewall, login or busy server may be turning the checker away. Real visitors and Google may be fine: open the page in a browser to check, then run the audit again.');
  } else c.add(cat, 'critical', 'status.error', 'Page returns an error', `HTTP ${snap.status}`, 'Fix the server error or restore the page. Search engines drop pages that return errors.');

  const robotsMeta = [meta(page.root, 'name', 'robots'), meta(page.root, 'name', 'googlebot')].filter(Boolean).join(', ').toLowerCase().slice(0, 500);
  const xRobots = (snap.headers?.['x-robots-tag'] ?? '').toLowerCase().slice(0, 500);
  if (/\b(noindex|none)\b/.test(robotsMeta) || /\b(noindex|none)\b/.test(xRobots)) {
    c.add(cat, 'critical', 'index.noindex', 'Page is set to stay out of search results (noindex)', `robots: "${robotsMeta || xRobots}"`, 'Remove the noindex directive unless this page should stay out of Google.');
  } else c.pass(cat, 'index.ok', 'Page can be indexed');

  const canonical = page.root.querySelectorAll('link').find((l) => l.getAttribute('rel')?.toLowerCase() === 'canonical')?.getAttribute('href');
  if (!canonical) c.add(cat, 'low', 'canonical.missing', 'No canonical address declared', 'No <link rel="canonical"> found', 'Add a canonical link pointing to the preferred address of this page, to avoid duplicate-content confusion (for example www and non-www versions).');
  else {
    const target = resolveUrl(canonical, page.url);
    if (target && page.url && (target.origin !== page.url.origin || target.pathname.replace(/\/$/, '') !== page.url.pathname.replace(/\/$/, ''))) {
      c.add(cat, 'medium', 'canonical.other', 'Canonical points to a different address', `Canonical is ${target.href}`, 'Confirm this is intended. If this page should rank on its own (a different www / http version counts as different), make its canonical link point to itself.');
    } else c.pass(cat, 'canonical.ok', 'Canonical address is set', canonical.slice(0, 200));
  }

  const lang = page.root.querySelector('html')?.getAttribute('lang');
  if (lang) c.pass(cat, 'lang.ok', 'Page language is declared', `lang="${lang.slice(0, 20)}"`);
  else c.add(cat, 'low', 'lang.missing', 'Page language is not declared', 'No lang attribute on <html>', 'Add lang="en" (or the right language) to the <html> tag. It helps search engines and screen readers.');

  const kb = snap.html.length / 1024;
  if (kb > 1500) c.add(cat, 'high', 'weight.huge', 'Page HTML is very large', `About ${kb.toFixed(0)} KB of HTML`, 'Reduce the HTML size (remove inline data, split long pages).');
  else if (kb > 500) c.add(cat, 'medium', 'weight.large', 'Page HTML is large', `About ${kb.toFixed(0)} KB of HTML`, 'Trim unnecessary markup and inline scripts.');

  // robots.txt and sitemap
  const robotsTxt = snap.robotsTxt;
  const robots = typeof robotsTxt === 'string' ? parseRobots(robotsTxt) : null;
  if (robotsTxt === undefined) c.add(cat, 'info', 'robots.notchecked', 'robots.txt was not checked', 'Not part of this snapshot');
  else if (robotsTxt === null) c.add(cat, 'low', 'robots.missing', 'No robots.txt file', '/robots.txt returned "not found"', 'A missing robots.txt is allowed (crawlers assume everything may be crawled), but it is the standard place to point crawlers to your sitemap.');
  else if (robots && blocksWholeSite(robots, 'googlebot')) {
    c.add(cat, 'critical', 'robots.blocks_all', 'robots.txt tells Google not to crawl the site', 'Found "Disallow: /" that applies to Googlebot', 'Remove the blanket Disallow. Note that Disallow stops crawling, not indexing: blocked pages can still appear as bare links, and Google cannot read a noindex on a page it may not crawl.');
  } else if (robots && blocksWholeSite(robots, '*')) {
    c.add(cat, 'medium', 'robots.blocks_other_crawlers', 'robots.txt blocks most crawlers', 'Found "Disallow: /" for "User-agent: *", but Googlebot has its own rule that allows crawling', 'Check this is intended. Bing, DuckDuckGo and most other crawlers are told to stay out.');
  } else c.pass(cat, 'robots.ok', 'robots.txt allows crawling');

  const sitemapUrls = robots?.sitemaps ?? [];
  const sitemapXml = snap.sitemapXml;
  if (typeof sitemapXml === 'string') {
    const urlCount = (sitemapXml.slice(0, 2_000_000).match(/<loc>/gi) ?? []).length;
    if (/<urlset|<sitemapindex/i.test(sitemapXml.slice(0, 100_000)) && urlCount > 0) c.pass(cat, 'sitemap.ok', 'XML sitemap found', `${urlCount} address${urlCount === 1 ? '' : 'es'} listed`);
    else c.add(cat, 'medium', 'sitemap.invalid', 'Sitemap exists but looks empty or invalid', `${urlCount} addresses found`, 'Regenerate the sitemap so it lists your important pages.');
    if (robots && sitemapUrls.length === 0) c.add(cat, 'low', 'sitemap.not_in_robots', 'Sitemap is not listed in robots.txt', 'No "Sitemap:" line', 'Add a "Sitemap: https://…/sitemap.xml" line to robots.txt.');
  } else if (sitemapXml === null) {
    if (sitemapUrls.length > 0) c.add(cat, 'info', 'sitemap.other_location', 'No sitemap at /sitemap.xml, but robots.txt names another', `robots.txt lists: ${sitemapUrls.slice(0, 2).join(', ')}`, 'Fine if that file works. This audit only checked the default address.');
    else c.add(cat, 'medium', 'sitemap.missing', 'No XML sitemap found', '/sitemap.xml returned "not found" and robots.txt names none', 'Create an XML sitemap and submit it in Google Search Console.');
  }
}

function onPage(c: Collector, page: Page) {
  const cat: Category = 'onpage';
  const { root } = page;

  const titleEl = root.querySelector('head title') ?? root.querySelectorAll('title').find((t) => t.parentNode?.rawTagName !== 'svg');
  const title = titleEl?.text.trim() ?? '';
  if (!title) c.add(cat, 'high', 'title.missing', 'Page has no title', 'No <title> found', 'Add a unique, descriptive <title> that says what the page is and who it is for (around 30-60 characters shows in full).');
  else if (title.length < 30) c.add(cat, 'low', 'title.short', 'Title is very short', `"${clip(title, 80)}" (${title.length} characters)`, 'Short titles are allowed, but around 30-60 characters lets you say what the page offers and where. Make sure it is descriptive.');
  else if (title.length > 60) c.add(cat, 'low', 'title.long', 'Title is long and may be cut off in results', `${title.length} characters: "${clip(title, 80)}"`, 'Shorten the title to about 60 characters so it shows in full.');
  else c.pass(cat, 'title.ok', 'Title length is good', `"${clip(title, 80)}"`);

  const desc = meta(root, 'name', 'description');
  if (desc === null || !desc.trim()) c.add(cat, 'medium', 'description.missing', 'No meta description', 'No <meta name="description"> found', 'Write a 70-160 character summary that persuades people to click. Google may rewrite it, but a good one is often used.');
  else if (desc.length < 70) c.add(cat, 'low', 'description.short', 'Meta description is short', `${desc.length} characters`, 'Expand it to 70-160 characters.');
  else if (desc.length > 160) c.add(cat, 'low', 'description.long', 'Meta description is long and may be cut off', `${desc.length} characters`, 'Shorten it to about 155 characters.');
  else c.pass(cat, 'description.ok', 'Meta description length is good', `${desc.length} characters`);

  const h1s = root.querySelectorAll('h1').filter((h) => h.text.trim());
  if (h1s.length === 0) c.add(cat, 'medium', 'h1.missing', 'No main heading (H1)', 'No <h1> with text found', 'Add one clear H1 that states what the page is about. It helps visitors, screen readers and search engines.');
  else if (h1s.length > 1) c.add(cat, 'low', 'h1.multiple', 'More than one main heading (H1)', `${h1s.length} H1 headings: ${h1s.slice(0, 4).map((h) => `"${clip(h.text, 40)}"`).join(', ')}`, 'Google allows more than one H1, but a single clear main heading is the simplest structure and easiest for screen readers.');
  else c.pass(cat, 'h1.ok', 'One main heading (H1)', `"${clip(h1s[0].text, 80)}"`);

  const levels = root.querySelectorAll('h1,h2,h3,h4,h5,h6').map((h) => Number(h.tagName[1]));
  let skipped = false;
  for (let i = 1; i < levels.length; i++) if (levels[i] > levels[i - 1] + 1) skipped = true;
  if (skipped) c.add(cat, 'low', 'headings.skip', 'Heading levels skip a step', `Order: ${levels.slice(0, 12).map((l) => `H${l}`).join(' → ')}`, 'Keep headings in order (H1, then H2, then H3) so the outline makes sense.');

  const imgs = root.querySelectorAll('img');
  const missingAlt = imgs.filter((i) => i.getAttribute('alt') === undefined);
  if (imgs.length === 0) c.add(cat, 'info', 'images.none', 'No images on the page', '0 images');
  else if (missingAlt.length) c.add(cat, missingAlt.length > 3 ? 'medium' : 'low', 'images.alt_missing', 'Images without alternative text', `${missingAlt.length} of ${imgs.length} images have no alt attribute`, 'Add short descriptive alt text to every meaningful image (use alt="" for purely decorative ones).');
  else c.pass(cat, 'images.alt_ok', 'All images have alternative text', `${imgs.length} images`);

  const shared = ['og:title', 'og:description', 'og:image'].filter((p) => !meta(root, 'property', p));
  if (shared.length) c.add(cat, 'low', 'social.og_missing', 'Social sharing tags are incomplete', `Missing: ${shared.join(', ')}`, 'Add Open Graph tags so links look good when shared on Facebook, LinkedIn and WhatsApp.');
  else c.pass(cat, 'social.og_ok', 'Social sharing tags present');

  const links = root.querySelectorAll('a').filter((a) => (a.getAttribute('href') ?? '').trim());
  const internal = links.filter((a) => {
    const href = a.getAttribute('href')!.trim();
    if (href.startsWith('#') || /^(mailto|tel|javascript|sms):/i.test(href.slice(0, 12))) return false;
    const u = resolveUrl(href, page.url);
    return !!(u && page.url && u.host === page.url.host);
  });
  if (internal.length === 0) c.add(cat, 'medium', 'links.no_internal', 'No internal links', '0 links to other pages of this site', 'Link to your other key pages so visitors and search engines can find them.');
  else c.pass(cat, 'links.internal_ok', 'Internal links present', `${internal.length} internal links`);
  const vague = links.filter((a) => /^(click here|read more|here|more|learn more)$/i.test(a.text.trim().slice(0, 40)));
  if (vague.length) c.add(cat, 'low', 'links.vague_text', 'Links with vague text', `${vague.length} link${vague.length === 1 ? '' : 's'} say "${clip(vague[0].text, 30)}"`, 'Use descriptive link text such as "See our dental implant prices".');

  const words = wordCount(page.visibleText);
  const scripts = root.querySelectorAll('script[src]').length;
  if (words < 60 && scripts >= 2) {
    c.add(cat, 'info', 'render.js_only', 'The page may be built with JavaScript', `Only ${words} words in the HTML the server sends, plus ${scripts} script files`, 'This audit reads the HTML the server sends. Content added by JavaScript is not seen here, so text, headings and structured data may be missing from this report. Google can often read it; confirm in Google Search Console.');
  }
  if (words < 150) c.add(cat, 'low', 'content.thin', 'Very little text on the page', `${words} words`, 'Google sets no minimum length, but pages that do not fully answer a visitor’s question tend to struggle. Add the helpful detail people look for: services, prices, FAQs, proof.');
  else if (words < 300) c.add(cat, 'info', 'content.short', 'Page content is fairly short', `${words} words`, 'Fine if the page answers its question. Consider adding services, prices, FAQs or proof if it does not.');
  else c.pass(cat, 'content.ok', 'A good amount of text content', `${words} words`);
}

function mobile(c: Collector, page: Page) {
  const viewport = meta(page.root, 'name', 'viewport');
  if (viewport === null) c.add('mobile', 'high', 'viewport.missing', 'Page is not set up for mobile screens', 'No <meta name="viewport"> found', 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> so phones show the page at the right size.');
  else if (!/width\s*=\s*device-width/i.test(viewport.slice(0, 500))) c.add('mobile', 'medium', 'viewport.fixed', 'Mobile viewport is not responsive', `content="${clip(viewport, 80)}"`, 'Use width=device-width in the viewport tag.');
  else c.pass('mobile', 'viewport.ok', 'Mobile viewport is set');
  if (/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/i.test((viewport ?? '').slice(0, 500))) {
    c.add('mobile', 'medium', 'viewport.no_zoom', 'Visitors are prevented from zooming', `content="${clip(viewport ?? '', 80)}"`, 'Remove user-scalable=no / maximum-scale=1 so people with low vision can zoom.');
  }
}

function performance(c: Collector, snap: SiteSnapshot) {
  const m = snap.metrics;
  if (!m || Object.values(m).every((v) => v === undefined)) {
    c.add('performance', 'info', 'speed.not_measured', 'Speed was not measured', 'No timing data in this snapshot', 'Connect speed measurement (Google PageSpeed) in a later phase to score loading speed.');
    return;
  }
  const rate = (value: number | undefined, good: number, poor: number, code: string, label: string, unit: (v: number) => string, fix: string) => {
    if (value === undefined || !Number.isFinite(value)) return;
    if (value <= good) c.pass('performance', `${code}.ok`, `${label} is good`, unit(value));
    else if (value <= poor) c.add('performance', 'medium', `${code}.needs_work`, `${label} needs improvement`, unit(value), fix);
    else c.add('performance', 'high', `${code}.poor`, `${label} is poor`, unit(value), fix);
  };
  const sec = (v: number) => `${(v / 1000).toFixed(1)} s`;
  rate(m.lcpMs, 2500, 4000, 'lcp', 'Largest Contentful Paint (main content appears)', sec, 'Compress and properly size the hero image, use a faster host or a CDN, and avoid blocking scripts.');
  rate(m.cls, 0.1, 0.25, 'cls', 'Layout stability (CLS)', (v) => v.toFixed(2), 'Give images and ads fixed width/height so the page does not jump while loading.');
  rate(m.inpMs, 200, 500, 'inp', 'Responsiveness (INP)', (v) => `${Math.round(v)} ms`, 'Reduce heavy JavaScript that runs when people tap or click.');
  rate(m.ttfbMs, 800, 1800, 'ttfb', 'Server response time', (v) => `${Math.round(v)} ms`, 'Use caching or a faster hosting plan.');
}

/** schema.org types that describe a business with a physical presence. */
const LOCAL_TYPE = /(LocalBusiness|Business|Clinic|Physician|Dentist|Pharmacy|Hospital|Store|Shop|Restaurant|Cafe|Bakery|Bar|Hotel|Lodging|Salon|Spa|Gym|Fitness|Center|Centre|Plumber|Electrician|Locksmith|Contractor|Repair|Attorney|LegalService|ProfessionalService|RealEstateAgent|Establishment)$/;
const isLocalNode = (n: Record<string, unknown>) => typesOf(n).some((t) => LOCAL_TYPE.test(t)) || !!(n['address'] && n['telephone']);
const isOrgNode = (n: Record<string, unknown>) => isLocalNode(n) || typesOf(n).some((t) => /(Organization|Corporation|NGO)$/.test(t));

function local(c: Collector, page: Page, options: AuditOptions) {
  const weak: Severity = options.businessType === 'online' ? 'info' : 'medium';
  const low: Severity = options.businessType === 'online' ? 'info' : 'low';
  const biz = page.jsonLd.nodes.find(isLocalNode);

  if (!biz) c.add('local', weak, 'local.schema_missing', 'No local-business structured data', 'No LocalBusiness (or similar) JSON-LD found', 'Add LocalBusiness structured data with your name, address, phone and opening hours. It helps Google Maps and other services understand your business.');
  else {
    c.pass('local', 'local.schema_ok', 'Local-business structured data present', typesOf(biz).join(', '));
    const address = biz['address'];
    const missing = ['name', 'telephone'].filter((k) => !biz[k]).concat(address ? [] : ['address']);
    if (missing.length) c.add('local', 'medium', 'local.nap_incomplete', 'Business details are incomplete in structured data', `Missing: ${missing.join(', ')}`, 'Fill in name, address and telephone exactly as they appear on Google Business Profile.');
    else c.pass('local', 'local.nap_ok', 'Name, address and phone are in structured data');
    if (!biz['openingHours'] && !biz['openingHoursSpecification']) c.add('local', 'low', 'local.hours_missing', 'Opening hours are not in structured data', 'No openingHours found', 'Add opening hours so Google can show "open now".');
  }

  const phoneLink = page.root.querySelectorAll('a').some((a) => (a.getAttribute('href') ?? '').slice(0, 10).toLowerCase().startsWith('tel:'));
  if (phoneLink) c.pass('local', 'local.tel_link', 'Phone number is tap-to-call');
  else c.add('local', low, 'local.tel_missing', 'Phone number is not tap-to-call', 'No tel: link found', 'Make the phone number a tel: link so mobile visitors can call in one tap.');

  const gbpLink = page.root.querySelectorAll('a').some((a) => isGoogleBusinessLink(a.getAttribute('href') ?? '', page.url));
  const gbpSameAs = page.jsonLd.nodes.some((n) => stringValues(n['sameAs']).some((v) => isGoogleBusinessLink(v, page.url)));
  const gbpEmbed = page.root.querySelectorAll('iframe').some((f) => isGoogleBusinessLink((f.getAttribute('src') ?? '').replace('/maps/embed', '/maps'), page.url));
  if (gbpLink || gbpSameAs || gbpEmbed) c.pass('local', 'local.gbp_link', 'Links to Google Maps / Google Business Profile');
  else c.add('local', low, 'local.gbp_missing', 'No link to your Google Business Profile', 'No Google Maps / g.page link found', 'Link to your Google Business Profile and encourage reviews. It is one of the most important local ranking factors.');

  c.add('local', 'info', 'local.unverifiable', 'Some local factors cannot be checked from the website', 'Reviews, business categories and address consistency live on Google Business Profile', 'Review your Google Business Profile separately: categories, photos, reviews and the same name, address and phone everywhere.');
}

/** Crawlers of AI systems. "answer" ones fetch pages to quote them; "training" ones collect data for models. */
const AI_CRAWLERS: [agent: string, label: string, kind: 'answer' | 'training'][] = [
  ['OAI-SearchBot', 'ChatGPT search', 'answer'],
  ['ChatGPT-User', 'ChatGPT browsing', 'answer'],
  ['PerplexityBot', 'Perplexity search', 'answer'],
  ['Claude-SearchBot', 'Claude search', 'answer'],
  ['GPTBot', 'OpenAI training', 'training'],
  ['ClaudeBot', 'Claude training', 'training'],
  ['Google-Extended', 'Gemini training opt-out', 'training'],
  ['Applebot-Extended', 'Apple AI training opt-out', 'training'],
];

function geo(c: Collector, snap: SiteSnapshot, page: Page) {
  // 1. Are AI answer engines allowed to read the site?
  if (typeof snap.robotsTxt === 'string') {
    const robots = parseRobots(snap.robotsTxt);
    const blocked = AI_CRAWLERS.filter(([a]) => blocksWholeSite(robots, a));
    const wholeSiteBlocked = blocksWholeSite(robots, '*');
    if (blocked.length && !wholeSiteBlocked) {
      const answerBlocked = blocked.some(([, , kind]) => kind === 'answer');
      c.add('geo', answerBlocked ? 'medium' : 'info', 'geo.ai_blocked', answerBlocked ? 'AI search crawlers are blocked' : 'AI training crawlers are blocked', `Blocked: ${blocked.map(([a, l]) => `${a} (${l})`).join(', ')}`,
        answerBlocked
          ? 'Blocking the crawlers behind AI search (ChatGPT search, Perplexity, Claude search) means they cannot quote or recommend you. Make sure that is a deliberate choice.'
          : 'Blocking AI training crawlers is a legitimate business choice and does not stop these assistants from finding you through their search tools. Google-Extended and Applebot-Extended are opt-out switches: blocking them does not affect Google Search or Apple search.');
    } else if (!wholeSiteBlocked) c.pass('geo', 'geo.ai_allowed', 'No AI crawler is blocked from the whole site');
  }

  // 2. llms.txt - an optional, unproven convention
  if (typeof snap.llmsTxt === 'string' && snap.llmsTxt.trim()) c.add('geo', 'info', 'geo.llms_txt', 'llms.txt present', 'A /llms.txt file exists', 'Optional. No major search engine or AI company has confirmed it uses llms.txt, so treat it as harmless but unproven.');
  else if (snap.llmsTxt === null) c.add('geo', 'info', 'geo.llms_txt_missing', 'No llms.txt file (optional)', '/llms.txt returned "not found"', 'Optional and unproven: some sites publish a short /llms.txt summarising their business. Not needed to be found by AI assistants.');

  // 3. Structured data validity and entity clarity
  if (page.jsonLd.errors > 0) c.add('geo', 'high', 'geo.jsonld_invalid', 'Structured data contains errors', `${page.jsonLd.errors} JSON-LD block${page.jsonLd.errors === 1 ? '' : 's'} could not be read`, 'Fix the JSON syntax. A block with errors is skipped by search engines, so the information in it is lost.');
  const org = page.jsonLd.nodes.find(isOrgNode);
  if (!org) c.add('geo', 'low', 'geo.entity_missing', 'The business is not defined as an entity', 'No Organization/LocalBusiness structured data', 'Add Organization structured data (name, logo, url, sameAs). It helps search engines and AI systems connect your site to your business.');
  else if (!org['sameAs']) c.add('geo', 'low', 'geo.sameas_missing', 'No links to official profiles (sameAs)', 'Organization has no sameAs', 'List your official Facebook, LinkedIn, YouTube and Google profiles under sameAs so systems can connect them to your site.');
  else c.pass('geo', 'geo.entity_ok', 'Business entity is clearly defined');

  // 4. Answer-ready content
  const questions = page.root.querySelectorAll('h2,h3,h4').filter((h) => h.text.trim().endsWith('?'));
  const hasFaq = page.jsonLd.nodes.some((n) => typesOf(n).includes('FAQPage'));
  if (hasFaq || questions.length >= 3) c.pass('geo', 'geo.faq_ok', 'Question-and-answer content present', hasFaq ? 'FAQPage structured data' : `${questions.length} question headings`);
  else c.add('geo', 'low', 'geo.faq_missing', 'No question-and-answer content', `${questions.length} question headings`, 'Add a visible FAQ that answers real customer questions in plain words. It helps visitors and gives AI systems clear answers to draw on. (Google now shows FAQ rich results only for a few authoritative sites, so FAQ structured data is optional.)');

  // 5. Trust signals - only meaningful on articles, not on a home page
  const articleLike = meta(page.root, 'property', 'og:type') === 'article' || !!page.root.querySelector('article') ||
    page.jsonLd.nodes.some((n) => typesOf(n).some((t) => /(Article|BlogPosting|NewsArticle)$/.test(t)));
  if (articleLike) {
    const dated = !!(meta(page.root, 'property', 'article:published_time') || meta(page.root, 'property', 'article:modified_time') ||
      page.root.querySelector('time') || page.jsonLd.nodes.some((n) => n['datePublished'] || n['dateModified']));
    const author = !!(meta(page.root, 'name', 'author') || page.jsonLd.nodes.some((n) => n['author']));
    if (dated && author) c.pass('geo', 'geo.trust_ok', 'Author and date signals present');
    else c.add('geo', 'low', 'geo.trust_missing', 'Weak trust signals (author / date)', `${dated ? '' : 'No publish or update date. '}${author ? '' : 'No author.'}`.trim(), 'Show who wrote or reviewed this article and when it was last updated. Readers, search engines and AI systems all prefer sources they can trust.');
  }

  if (!page.root.querySelector('main')) c.add('geo', 'info', 'geo.no_main', 'No <main> region', 'No <main> element', 'Wrap the primary content in <main> so machines can tell it from menus and footers.');
}

// ---------------------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------------------

const PENALTY: Record<Severity, number> = { critical: 40, high: 20, medium: 10, low: 4, info: 0, pass: 0 };
const WEIGHT: Record<Category, number> = { technical: 25, onpage: 25, performance: 15, geo: 15, local: 10, mobile: 10 };

/** Findings that keep the page out of search results, whatever else is right. */
const BLOCKERS: Record<string, string> = {
  'index.noindex': 'This page is set to stay out of search results',
  'robots.blocks_all': 'Google is told not to crawl this site',
  'status.error': 'This page returns an error',
};
export const BLOCKED_SCORE_CAP = 40;

export function scoreFindings(findings: Finding[]) {
  const categoryScores = {} as Record<Category, number | null>;
  for (const cat of CATEGORIES) {
    const own = findings.filter((f) => f.category === cat);
    const measured = own.some((f) => f.severity !== 'info');
    categoryScores[cat] = measured ? Math.max(0, 100 - own.reduce((s, f) => s + PENALTY[f.severity], 0)) : null;
  }
  const scored = CATEGORIES.filter((c) => categoryScores[c] !== null);
  const totalWeight = scored.reduce((s, c) => s + WEIGHT[c], 0);
  const average = totalWeight === 0 ? null : Math.round(scored.reduce((s, c) => s + categoryScores[c]! * WEIGHT[c], 0) / totalWeight);
  const blockers = findings.filter((f) => f.code in BLOCKERS).map((f) => BLOCKERS[f.code]);
  const capped = average !== null && blockers.length > 0 && average > BLOCKED_SCORE_CAP;
  return {
    categoryScores,
    overallScore: capped ? BLOCKED_SCORE_CAP : average,
    overallNote: blockers.length ? `${blockers.join('; ')}, so the overall score cannot be higher than ${BLOCKED_SCORE_CAP} until that is fixed.` : null,
  };
}

// ---------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------

const ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4, pass: 5 };

export function runAudit(snap: SiteSnapshot, options: AuditOptions = {}): AuditResult {
  const limited = limitHtml(snap.html);
  const safeHtml = limited.html;
  const root = parse(safeHtml, { blockTextElements: { script: true, noscript: true, style: true, pre: true } });
  const jsonLd = readJsonLd(root);
  // Visible text = the page with scripts, styles and hidden template pieces removed.
  const textRoot = parse(safeHtml);
  textRoot.querySelectorAll('script,style,noscript,template,svg,head').forEach((el) => el.remove());
  const page: Page = { root, url: safeUrl(snap.url), jsonLd, visibleText: textRoot.text };

  const c = new Collector();
  if (limited.truncatedDepth) c.add('technical', 'medium', 'html.too_deep', 'Page markup is extremely deeply nested', `More than ${MAX_NESTING_DEPTH} levels deep (unclosed tags?). The audit read only the part above that.`, 'Fix unclosed or runaway tags. Very deep markup slows browsers and confuses search engines.');
  if (limited.truncatedTags) c.add('technical', 'medium', 'html.too_complex', 'Page contains an extreme number of HTML tags', `More than ${MAX_TAGS.toLocaleString('en-US')} tags. The audit read only the part above that.`, 'Simplify the page. Extremely large pages load slowly and are hard for search engines to process.');
  if (limited.truncatedSize) c.add('technical', 'medium', 'html.truncated', 'Page HTML is too large to audit fully', `Only the first ${MAX_HTML_CHARS.toLocaleString('en-US')} characters were read.`, 'Reduce the size of the page.');
  technical(c, snap, page);
  onPage(c, page);
  mobile(c, page);
  performance(c, snap);
  local(c, page, options);
  geo(c, snap, page);

  const findings = [...c.findings].sort(
    (a, b) => ORDER[a.severity] - ORDER[b.severity] || CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.code.localeCompare(b.code),
  );
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length])) as Record<Severity, number>;
  const { categoryScores, overallScore, overallNote } = scoreFindings(findings);
  return { engineVersion: ENGINE_VERSION, overallScore, overallNote, categoryScores, findings, counts };
}
