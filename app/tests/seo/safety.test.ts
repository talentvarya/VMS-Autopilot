import { describe, expect, it } from 'vitest';
import { runAudit } from '@/lib/seo/engine';
import { FIXTURE_SITES } from '@/lib/seo/fixtures';
import { UnsafeUrlError, assertSafeUrl, safeOrigin } from '@/lib/seo/safe-url';
import { FixtureSource, LIVE_AUDITS_ENABLED, LiveAuditsDisabledError, UnknownSampleSiteError, createSource } from '@/lib/seo/sources';
import { csvEscape, neutralizeCell, reportFilename, reportToCsv, toCsv } from '@/lib/seo/csv';

describe('assertSafeUrl - blocks requests to internal networks', () => {
  const blocked: [string, string][] = [
    ['http://localhost/', 'localhost'],
    ['http://LOCALHOST:3000/', 'localhost with port'],
    ['http://app.localhost/', '.localhost name'],
    ['http://127.0.0.1/', 'loopback IP'],
    ['http://127.1/', 'short loopback'],
    ['http://2130706433/', 'decimal-encoded 127.0.0.1'],
    ['http://0x7f000001/', 'hex-encoded 127.0.0.1'],
    ['http://0177.0.0.1/', 'octal-encoded 127.0.0.1'],
    ['http://0/', 'zero address'],
    ['http://10.0.0.5/', 'private 10.x'],
    ['http://192.168.1.1/', 'private 192.168.x'],
    ['http://172.16.0.1/', 'private 172.16.x'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata IP'],
    ['http://metadata.google.internal/', 'cloud metadata name'],
    ['http://[::1]/', 'IPv6 loopback'],
    ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped IPv6'],
    ['http://[fd00::1]/', 'IPv6 private'],
    ['http://8.8.8.8/', 'any IP literal, even public'],
    ['http://printer.local/', '.local name'],
    ['http://db.internal/', '.internal name'],
    ['http://intranet/', 'single-label name'],
    ['ftp://example.com/', 'wrong protocol'],
    ['file:///etc/passwd', 'file protocol'],
    ['javascript:alert(1)', 'javascript protocol'],
    ['gopher://example.com/', 'gopher'],
    ['https://user:pass@example.com/', 'credentials in address'],
    ['https://example.com:22/', 'SSH port'],
    ['https://example.com:5432/', 'database port'],
    ['https://example.com:6379/', 'redis port'],
    ['https://exa mple.com/', 'space in name'],
    ['https://example.com\\@evil.test/', 'backslash trick'],
    ['https://x.test/', 'reserved .test name'],
    ['', 'empty'],
    ['not a url', 'garbage'],
    ['https://' + 'a'.repeat(3000) + '.com', 'too long'],
  ];
  it.each(blocked)('rejects %s (%s)', (address) => {
    expect(() => assertSafeUrl(address)).toThrow(UnsafeUrlError);
  });

  it('accepts ordinary public website names and normalises them', () => {
    expect(assertSafeUrl('https://Nova-Clinic.com/about#team').href).toBe('https://nova-clinic.com/about');
    expect(assertSafeUrl('http://brighthomes.co.uk').origin).toBe('http://brighthomes.co.uk');
    expect(assertSafeUrl('https://www.example-shop.com:8443/x').port).toBe('8443');
    expect(assertSafeUrl('https://münchen.de/').hostname).toBe('xn--mnchen-3ya.de');
    expect(safeOrigin('https://Shop.Example-Store.com/a/b?c=d')).toBe('https://shop.example-store.com');
  });

  it('explains why in plain words', () => {
    expect(() => assertSafeUrl('http://169.254.169.254/')).toThrow(/IP addresses are not allowed/);
    expect(() => assertSafeUrl('http://intranet/')).toThrow(/not a public website name/);
  });
});

describe('live audits are approved, but only in staging/production - never in dev or test', () => {
  it('the compile-time switch is on, but this (test) environment still refuses to create a live source', () => {
    expect(LIVE_AUDITS_ENABLED).toBe(true);
    expect(() => createSource('live')).toThrow(LiveAuditsDisabledError);
    expect(() => createSource('live')).toThrow(/switched off/);
  });

  it('only creates a real LiveSource once BOTH the flag and the environment tier agree', () => {
    expect(() => createSource('live', { liveEnabled: false, env: { ...process.env, APP_ENV: 'production' } })).toThrow(LiveAuditsDisabledError);
    expect(() => createSource('live', { liveEnabled: true, env: { ...process.env, APP_ENV: 'development' } })).toThrow(LiveAuditsDisabledError);
    const source = createSource('live', { liveEnabled: true, env: { ...process.env, APP_ENV: 'staging' } });
    expect(source.kind).toBe('live');
  });

  it('serves only the built-in sample sites, as copies', async () => {
    const source = createSource('fixture');
    expect(source).toBeInstanceOf(FixtureSource);
    expect(source.kind).toBe('fixture');
    const a = await source.getSnapshot('https://nova-clinic.example.test/');
    a.html = 'tampered';
    const b = await source.getSnapshot('https://NOVA-CLINIC.example.test');
    expect(b.html).not.toBe('tampered');
    await expect(source.getSnapshot('https://real-client.com')).rejects.toThrow(UnknownSampleSiteError);
    await expect(source.getSnapshot('http://169.254.169.254')).rejects.toThrow(UnknownSampleSiteError);
  });

  // live-fetch.ts is the ONE reviewed file allowed to contain network code (it fetches real
  // client websites, read-only, behind the gate above). Every other file in lib/seo must still
  // have none at all - a change anywhere else that reaches for `fetch` fails this test.
  it('has no network code outside the one reviewed live-fetch module', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(__dirname, '..', '..', 'src', 'lib', 'seo');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'live-fetch.ts')) {
      const code = readFileSync(join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|node:https?|node:net|node:dns|WebSocket|child_process/);
    }
  });

  // live-fetch.ts itself must still visibly do the two things its own doc comment promises:
  // validate the URL, then resolve-and-pin the DNS address before ever connecting.
  it('the live-fetch module validates the URL and pins a DNS-resolved address before connecting', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const code = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'seo', 'live-fetch.ts'), 'utf8');
    expect(code).toContain('assertSafeUrl');
    expect(code).toMatch(/dns\.lookup/);
    expect(code).toContain('isPrivateIp');
    expect(code).toMatch(/connect:\s*{\s*lookup/);
  });
});

describe('CSV export', () => {
  it('neutralises spreadsheet formulas', () => {
    for (const evil of ['=HYPERLINK("http://evil.test","x")', '+1+1', '-2+3', '@SUM(A1)', '\t=1+1', '\r=1+1']) {
      expect(neutralizeCell(evil).startsWith("'")).toBe(true);
    }
    expect(neutralizeCell('Normal text')).toBe('Normal text');
    expect(neutralizeCell('50% off')).toBe('50% off');
  });

  it('quotes commas, quotes and line breaks correctly', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscape('plain')).toBe('plain');
    expect(toCsv([['a', 'b'], ['1', '2']])).toBe('﻿a,b\r\n1,2\r\n');
  });

  it('produces one row per finding with the right columns, and no live formulas', () => {
    const site = FIXTURE_SITES[2];
    const result = runAudit(site.snapshot, { businessType: 'local' });
    // Simulate a hostile page title landing in the evidence.
    result.findings[0] = { ...result.findings[0], evidence: '=cmd|"/c calc"!A1', title: '@evil' };
    const csv = reportToCsv(result, { siteLabel: site.label, origin: site.origin, auditedAt: '2025-04-24T09:16:00Z' });
    const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('Site,Address,Audited at,Category,Severity,Code,Finding,What we found,Recommendation,Fix status');
    expect(lines.length).toBeGreaterThan(result.findings.length); // header + rows (some rows contain quoted commas)
    expect(csv).toContain("'=cmd");
    expect(csv).toContain("'@evil");
    expect(csv).not.toMatch(/(^|,)"?=cmd/m);
  });

  it('can leave out the passing checks and carries fix status', () => {
    const site = FIXTURE_SITES[1];
    const result = runAudit(site.snapshot);
    const withPasses = reportToCsv(result, { siteLabel: 'x', origin: 'y', auditedAt: 'z' });
    const without = reportToCsv(result, { siteLabel: 'x', origin: 'y', auditedAt: 'z' }, { 'title.short': 'applied' }, { includePasses: false });
    expect(without.length).toBeLessThan(withPasses.length);
    expect(without).not.toContain(',pass,');
    expect(without).toMatch(/title\.short,.*,applied\r\n/);
  });

  it('builds safe file names', () => {
    expect(reportFilename('Nova Clinic (sample)', '2025-04-24T09:12:00Z')).toBe('seo-geo-audit-nova-clinic-sample-2025-04-24.csv');
    expect(reportFilename('../../etc/passwd', 'bad')).toBe('seo-geo-audit-etc-passwd-undated.csv');
    expect(reportFilename('***', '2025-01-01')).toBe('seo-geo-audit-site-2025-01-01.csv');
    expect(reportFilename('A'.repeat(200), '2025-01-01', 'pdf').length).toBeLessThan(100);
  });
});
