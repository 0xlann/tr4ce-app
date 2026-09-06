/**
 * Drawn linework motifs. Geometry only — each path is a single stroke that
 * draws itself when its [data-draw] ancestor gains `.isDrawn` (or on load
 * inside the hero). Keep usage sparse: one motif per composition.
 */

type ScribbleProps = { className?: string; size?: number };

export function ScribbleRing({ className, size = 120 }: ScribbleProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      data-draw
      fill="none"
      height={size}
      viewBox="0 0 120 120"
      width={size}
    >
      <path
        className="drawLine"
        d="M62 14c-25-3-46 13-47 34-1 22 20 40 45 41s47-16 46-37C105 30 85 16 63 15c-17-1-33 7-40 19"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.6"
        style={{ ["--dash" as string]: 420 }}
      />
      <path
        className="drawLine"
        d="M52 34c-11 6-16 19-11 29s19 14 30 9 15-20 8-29-21-11-30-3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.4"
        style={{ ["--dash" as string]: 260 }}
      />
    </svg>
  );
}

export function ScribbleUnderline({ className, size = 220 }: ScribbleProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      data-draw
      fill="none"
      height={Math.round(size * 0.18)}
      viewBox="0 0 220 40"
      width={size}
      style={{ display: "block" }}
    >
      <path
        className="drawLine"
        d="M4 26C40 16 96 12 150 16c24 2 44 6 66 12M28 33c48-8 118-9 176-4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2.6"
        style={{ ["--dash" as string]: 420 }}
      />
    </svg>
  );
}

export function BurstMark({ className, size = 40 }: ScribbleProps) {
  return (
    <svg aria-hidden="true" className={className} fill="none" height={size} viewBox="0 0 40 40" width={size}>
      <path
        className="drawLine"
        d="M20 3v12M20 25v12M3 20h12M25 20h12M8 8l8 8M24 24l8 8M32 8l-8 8M16 24l-8 8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2.2"
        style={{ ["--dash" as string]: 160 }}
      />
    </svg>
  );
}
