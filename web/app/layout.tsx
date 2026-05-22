import "./globals.css";

import { Fraunces, IBM_Plex_Sans, IBM_Plex_Mono, Noto_Sans_TC, Noto_Serif_TC } from "next/font/google";
import { Masthead } from "@/components/Masthead";
import { Folio } from "@/components/Folio";
import { Providers } from "./providers";

import type { ReactNode } from "react";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
  axes: ["opsz", "SOFT"],
  display: "swap",
});

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

const notoSansTC = Noto_Sans_TC({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-sans-cjk",
  display: "swap",
});

const notoSerifTC = Noto_Serif_TC({
  subsets: ["latin"],
  weight: ["500", "700"],
  variable: "--font-display-cjk",
  display: "swap",
});

export default function RootLayout({ children }: { children: ReactNode }) {
  const fontVars = `${fraunces.variable} ${plexSans.variable} ${plexMono.variable} ${notoSansTC.variable} ${notoSerifTC.variable}`;
  return (
    <html lang="zh-Hant" className={fontVars}>
      <body className="min-h-screen bg-paper text-ink antialiased">
        <Providers>
          <Masthead />
          <Folio variant="top" />
          <main>{children}</main>
        </Providers>
      </body>
    </html>
  );
}
