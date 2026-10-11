import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Toaster } from 'sonner';
import './globals.css';
import { PreviewProvider } from '../components/preview-provider';

export const metadata: Metadata = {
  title: 'DropDeck',
  description: 'Fair, oversell-proof drops for small merchants',
  appleWebApp: { title: 'DropDeck', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#f4f4f6',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      {/* Browser extensions may add attributes to body before React hydrates. */}
      <body suppressHydrationWarning>
        <PreviewProvider>{children}</PreviewProvider>
        <Toaster position="top-center" richColors closeButton toastOptions={{ style: { fontFamily: 'var(--font-sans)' } }} />
      </body>
    </html>
  );
}
