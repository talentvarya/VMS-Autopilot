/**
 * SEO / GEO audit vocabulary. Mirrors the Postgres enums in
 * supabase/migrations/20260928000400_seo_audits.sql (tests/db/seo-schema.test.ts checks it).
 */

export const CATEGORIES = ['technical', 'onpage', 'mobile', 'performance', 'local', 'geo'] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  technical: 'Technical SEO',
  onpage: 'On-page SEO',
  mobile: 'Mobile',
  performance: 'Speed',
  local: 'Local SEO',
  geo: 'AI-search (GEO)',
};

/** `pass` = a check that succeeded; `info` = worth knowing, not a problem. */
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info', 'pass'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const FIX_STATUSES = ['open', 'applied', 'wont_fix'] as const;
export type FixStatus = (typeof FIX_STATUSES)[number];

export const RUN_STATUSES = ['queued', 'running', 'completed', 'failed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const AUDIT_SOURCES = ['fixture', 'live'] as const;
export type AuditSource = (typeof AUDIT_SOURCES)[number];

/** Everything the engine looks at. The engine never fetches anything itself. */
export interface SiteSnapshot {
  /** Final address of the page that was captured. */
  url: string;
  status: number;
  /** Response headers, names lower-cased. */
  headers?: Record<string, string>;
  html: string;
  /** string = contents; null = fetched and does not exist; undefined = not fetched. */
  robotsTxt?: string | null;
  sitemapXml?: string | null;
  llmsTxt?: string | null;
  /** Lab or field measurements, when available. */
  metrics?: { lcpMs?: number; cls?: number; inpMs?: number; ttfbMs?: number };
  fetchedAt: string;
}

export interface AuditOptions {
  /** 'local' businesses (clinics, shops, restaurants) get the local-SEO checks at full weight. */
  businessType?: 'local' | 'online';
}

export interface Finding {
  category: Category;
  severity: Severity;
  /** Stable machine name, e.g. "title.missing". */
  code: string;
  title: string;
  /** What was actually found (short, plain text). */
  evidence: string;
  /** What to do about it. Empty for passes. */
  recommendation: string;
}

export interface AuditResult {
  engineVersion: string;
  /** null when nothing could be measured. */
  overallScore: number | null;
  /** Set when the overall score was capped, explaining why in plain words. */
  overallNote: string | null;
  /** null for a category with nothing measured (e.g. speed without measurements). */
  categoryScores: Record<Category, number | null>;
  findings: Finding[];
  counts: Record<Severity, number>;
}

export const ENGINE_VERSION = '1.0.0';
