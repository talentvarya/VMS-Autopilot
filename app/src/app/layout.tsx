import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'VMS Autopilot — AI-Powered Marketing Automation Platform',
  description: 'Multi-client marketing operations for agencies: SEO/GEO audits, social, ads, domains, leads and AI assistance.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
