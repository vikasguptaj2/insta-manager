import type { Metadata } from 'next';
import './globals.css';
import { InstaOpsProvider } from '../hooks/use-instaops';
import { AppShell } from '../components/layout/AppShell';

export const metadata: Metadata = {
  title: 'InstaOps v2.0 — Instagram Operations Console',
  description:
    'Two-stage Instagram extraction, review, Cloudinary asset governance, scheduling, and Meta Graph API v22.0 publishing.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <InstaOpsProvider>
          <AppShell>{children}</AppShell>
        </InstaOpsProvider>
      </body>
    </html>
  );
}
