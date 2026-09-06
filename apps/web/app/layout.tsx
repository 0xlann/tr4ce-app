import type { Metadata } from "next";
import { IBM_Plex_Mono, Instrument_Serif, Inter, Bricolage_Grotesque } from "next/font/google";

import { ScrollMotion } from "../components/ui/ScrollMotion";
import "../styles/globals.css";

const body = Inter({ subsets: ["latin"], variable: "--font-body", display: "swap" });
const display = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});
const serif = Instrument_Serif({
  subsets: ["latin"],
  variable: "--font-serif",
  display: "swap",
  weight: "400",
  style: ["normal", "italic"],
});
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "TR4CE — verifiable vault evidence",
  description:
    "Evidence-first ERC-4626 vault reports. Block-pinned observations, a typed five-rule policy, and every limitation kept attached.",
  icons: { icon: "/icon-logo-t.png" },
};

const motionBootstrap = `document.documentElement.classList.add("gsapRunning");`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: motionBootstrap }} />
      </head>
      <body className={`${body.variable} ${display.variable} ${serif.variable} ${mono.variable}`}>
        <a className="skipLink" href="#main-content">Skip to content</a>
        {children}
        <ScrollMotion />
      </body>
    </html>
  );
}
