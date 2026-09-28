import type { SiteSnapshot } from './types';

/**
 * SAMPLE websites for Phase 2. They are invented (".test" is a reserved name that can never
 * belong to a real site) and exist so audits can be run, tested and demonstrated without
 * contacting any real website or client account.
 */

const words = (n: number, seed = 'care') => {
  const bank = ['our', 'team', 'offers', seed, 'for', 'families', 'in', 'the', 'local', 'area', 'with', 'friendly', 'service', 'clear', 'prices', 'and', 'modern', 'facilities', 'book', 'today', 'to', 'see', 'how', 'we', 'can', 'help', 'you'];
  return Array.from({ length: n }, (_, i) => bank[(i * 7 + seed.length) % bank.length]).join(' ') + '.';
};

const ORIGIN = {
  nova: 'https://nova-clinic.example.test',
  bright: 'https://brighthomes.example.test',
  urban: 'http://urban-eats.example.test',
};

const novaHtml = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Nova Clinic | Family Dentist & Skin Care in Springfield</title>
<meta name="description" content="Nova Clinic offers family dentistry, skin care and same-week appointments in Springfield. Friendly team, clear prices. Book online in two minutes.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="${ORIGIN.nova}/">
<meta property="og:title" content="Nova Clinic"><meta property="og:description" content="Family dentistry and skin care"><meta property="og:image" content="${ORIGIN.nova}/og.jpg">
<meta name="author" content="Dr. A. Rao">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
 {"@type":"MedicalClinic","name":"Nova Clinic","telephone":"+1-555-0100","address":{"@type":"PostalAddress","streetAddress":"12 High Street","addressLocality":"Springfield"},"sameAs":["https://www.facebook.com/novaclinic.example","https://g.page/nova-clinic-example"]},
 {"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Do you accept new patients?","acceptedAnswer":{"@type":"Answer","text":"Yes."}}]}
]}</script>
</head><body>
<header><nav><a href="/">Home</a> <a href="/services">Services</a> <a href="/prices">Prices</a> <a href="/contact">Contact</a></nav></header>
<main>
<h1>Family dentistry and skin care in Springfield</h1>
<p>${words(120, 'dental')}</p>
<h2>What do our treatments cost?</h2><p>${words(80, 'price')}</p>
<h2>How do I book an appointment?</h2><p>${words(70, 'book')}</p>
<h2>Do you treat children?</h2><p>${words(60, 'child')}</p>
<img src="/team.jpg" alt="The Nova Clinic team"><img src="/chair.jpg">
<p><a href="tel:+15550100">Call +1 555 0100</a> · <a href="https://g.page/nova-clinic-example">Find us on Google</a></p>
</main>
<footer><time datetime="2025-04-01">Updated April 2025</time></footer>
</body></html>`;

const brightHtml = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Bright Homes</title>
<meta name="viewport" content="width=1024">
</head><body>
<h1>Bright Homes</h1>
<h1>Find your next home</h1>
<h3>Featured listings</h3>
<p>${words(140, 'homes')}</p>
<img src="/a.jpg"><img src="/b.jpg"><img src="/c.jpg"><img src="/d.jpg"><img src="/e.jpg" alt="Front of a house">
<a href="/listings">click here</a> <a href="/about">Read more</a>
</body></html>`;

const urbanHtml = `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="robots" content="noindex, nofollow">
<script type="application/ld+json">{"@type": "Restaurant", "name": "Urban Eats",</script>
</head><body>
<div>Coming soon</div>
<p>${words(30, 'eats')}</p>
</body></html>`;

export interface FixtureSite {
  id: string;
  label: string;
  origin: string;
  businessType: 'local' | 'online';
  snapshot: SiteSnapshot;
}

const robotsOpen = (origin: string) => `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`;
const sitemap = (origin: string, n: number) =>
  `<?xml version="1.0"?><urlset>${Array.from({ length: n }, (_, i) => `<url><loc>${origin}/page-${i}</loc></url>`).join('')}</urlset>`;

export const FIXTURE_SITES: FixtureSite[] = [
  {
    id: 'nova-clinic',
    label: 'Nova Clinic (sample)',
    origin: ORIGIN.nova,
    businessType: 'local',
    snapshot: {
      url: `${ORIGIN.nova}/`,
      status: 200,
      headers: {},
      html: novaHtml,
      robotsTxt: robotsOpen(ORIGIN.nova),
      sitemapXml: sitemap(ORIGIN.nova, 12),
      llmsTxt: null,
      metrics: { lcpMs: 2100, cls: 0.05, inpMs: 150, ttfbMs: 420 },
      fetchedAt: '2025-04-24T09:12:00.000Z',
    },
  },
  {
    id: 'bright-homes',
    label: 'Bright Homes (sample)',
    origin: ORIGIN.bright,
    businessType: 'local',
    snapshot: {
      url: `${ORIGIN.bright}/`,
      status: 200,
      headers: {},
      html: brightHtml,
      robotsTxt: 'User-agent: GPTBot\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n',
      sitemapXml: null,
      llmsTxt: null,
      metrics: { lcpMs: 3400, cls: 0.18, inpMs: 260, ttfbMs: 900 },
      fetchedAt: '2025-04-24T09:14:00.000Z',
    },
  },
  {
    id: 'urban-eats',
    label: 'Urban Eats (sample)',
    origin: ORIGIN.urban,
    businessType: 'local',
    snapshot: {
      url: `${ORIGIN.urban}/`,
      status: 200,
      headers: { 'x-robots-tag': 'noindex' },
      html: urbanHtml,
      robotsTxt: 'User-agent: *\nDisallow: /\n',
      sitemapXml: null,
      llmsTxt: null,
      metrics: { lcpMs: 5200, cls: 0.4, inpMs: 620, ttfbMs: 2100 },
      fetchedAt: '2025-04-24T09:16:00.000Z',
    },
  },
];
