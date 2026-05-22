import "./globals.css";

import Link from "next/link";
import { Providers } from "./providers";

import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body className="bg-neutral-50 min-h-screen">
        <Providers>
          <header className="border-b">
            <div className="mx-auto max-w-6xl px-6 py-3 flex items-center gap-6 text-sm">
              <Link href="/" className="font-semibold">Bowtie Content Tool</Link>
              <nav className="flex items-center gap-4 text-neutral-600">
                <Link href="/" className="hover:text-neutral-900">Runs</Link>
                <Link href="/library" className="hover:text-neutral-900">Library</Link>
              </nav>
            </div>
          </header>
          {children}
        </Providers>
      </body>
    </html>
  );
}
