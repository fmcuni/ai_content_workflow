import "./globals.css";

import { Providers } from "./providers";

import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body className="bg-neutral-50 min-h-screen">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
