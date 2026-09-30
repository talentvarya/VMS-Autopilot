import {
  Bot,
  CalendarDays,
  FileText,
  Globe2,
  Home,
  Link2,
  Megaphone,
  Search,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react';

/**
 * Prototype data, copied unchanged from the approved interface/ baseline.
 * Phase 2 replaces these with live data from Supabase; nothing here is real.
 */

export const nav: ReadonlyArray<readonly [label: string, icon: LucideIcon]> = [
  ['Overview', Home],
  ['Clients', Users],
  ['Social Publishing', CalendarDays],
  ['Connected Accounts', Link2],
  ['SEO / GEO Audit', Search],
  ['Paid Ads', Megaphone],
  ['Domains', Globe2],
  ['Leads & CRM', Users],
  ['AI Monitor', Bot],
  ['Reports', FileText],
  ['Settings', Settings],
];

export interface ClientRow {
  id: string;
  name: string;
  type: string;
  initial: string;
  score: number;
  ads: string;
  access: string;
  health: string;
  channels: string[];
  websiteUrl: string | null;
}

/** The channel chips show a short code; screen readers get the full network name. */
export const channelNames: Record<string, string> = {
  f: 'Facebook',
  ig: 'Instagram',
  in: 'LinkedIn',
  yt: 'YouTube',
  tk: 'TikTok',
};

export const chartBars = [34, 45, 39, 53, 60, 70, 58, 75, 82, 92, 105, 91, 112, 126, 135];
