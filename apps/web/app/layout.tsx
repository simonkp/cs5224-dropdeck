import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: 'DropDeck', description: 'Fair, oversell-proof drops for small merchants' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
