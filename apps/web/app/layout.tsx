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

/**
 * Runs synchronously while the browser parses the HTML, so `[data-reveal]` elements are hidden
 * before the first paint rather than flashing in un-animated and then being animated again.
 *
 * Deliberately not a `useEffect`: by the time an effect runs the browser has already painted.
 * Equally deliberately an added class rather than a removed one — with scripting off the class is
 * never applied, and every reveal element stays visible.
 */
const motionBootstrap = `document.documentElement.classList.add("gsapRunning");`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    /*
     * `suppressHydrationWarning` because the bootstrap above adds a class to this element before
     * React hydrates, so the DOM legitimately differs from the server HTML.
     *
     * Not cosmetic silencing: without it React treats the difference as a hydration error and
     * re-renders from the nearest boundary on the client, which reintroduces the very flash the
     * bootstrap exists to prevent. It suppresses only this element's own attributes — mismatches
     * in any descendant still surface.
     */
    <html lang="en" suppressHydrationWarning>
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
