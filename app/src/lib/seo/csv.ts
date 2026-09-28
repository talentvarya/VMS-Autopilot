import { CATEGORY_LABELS, type AuditResult, type FixStatus } from './types';

/**
 * CSV export of an audit report.
 *
 * Security: a cell that starts with = + - @ (or a tab / carriage return) is treated as a
 * FORMULA by Excel and Google Sheets. Page text is controlled by whoever owns the website, so a
 * hostile page could make an exported report run a formula on the agency's computer
 * ("CSV injection"). Every cell is therefore neutralised with a leading apostrophe.
 */

export function neutralizeCell(value: string): string {
  // A formula character may hide behind spaces or a non-breaking space, and a line break at the
  // start can also confuse spreadsheets, so those are neutralised too.
  return /^[\t\r\n]|^[\s ﻿]*[=+\-@]/.test(value) ? `'${value}` : value;
}

export function csvEscape(value: string): string {
  const v = neutralizeCell(String(value));
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsv(rows: readonly (readonly string[])[]): string {
  // The BOM makes Excel read accented and non-Latin characters correctly.
  return '﻿' + rows.map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

export interface ReportMeta {
  siteLabel: string;
  origin: string;
  auditedAt: string;
}

export function reportToCsv(
  result: AuditResult,
  meta: ReportMeta,
  fixStatus: Record<string, FixStatus> = {},
  options: { includePasses?: boolean } = {},
): string {
  const header = ['Site', 'Address', 'Audited at', 'Category', 'Severity', 'Code', 'Finding', 'What we found', 'Recommendation', 'Fix status'];
  const rows = result.findings
    .filter((f) => options.includePasses !== false || f.severity !== 'pass')
    .map((f) => [
      meta.siteLabel, meta.origin, meta.auditedAt, CATEGORY_LABELS[f.category], f.severity, f.code,
      f.title, f.evidence, f.recommendation, fixStatus[f.code] ?? (f.severity === 'pass' ? '' : 'open'),
    ]);
  return toCsv([header, ...rows]);
}

/** A safe file name: lower-case letters, digits and dashes only. */
export function reportFilename(siteLabel: string, dateIso: string, extension = 'csv'): string {
  const slug = siteLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'site';
  const day = /^\d{4}-\d{2}-\d{2}/.test(dateIso) ? dateIso.slice(0, 10) : 'undated';
  return `seo-geo-audit-${slug}-${day}.${extension}`;
}
