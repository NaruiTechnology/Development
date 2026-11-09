/** Icons of the Processing tab's pattern strip (same artwork as the native app's resources/icons/pattern*.svg). */
const ICONS: Record<string, JSX.Element> = {
  patternSolidBox: <rect x="4" y="4" width="16" height="16" fill="currentColor" />,
  patternOpenBox: <rect x="4" y="4" width="16" height="16" />,
  patternStairCut: <path d="M3 20V16H8V12H13V8H18V4H21V20Z" fill="currentColor" />,
  patternCleaningLine: <path d="M4 6H20M4 10H20M4 14H20M4 18H20" />,
  patternCircle: <circle cx="12" cy="12" r="9" />,
  patternRing: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4.5" />
    </>
  ),
  patternLine: <path d="M4 20L20 4" />,
  patternPolygon: <path d="M4 19L8 5L17 6L21 19Z" fill="currentColor" />,
  patternFreeHand: <path d="M4 15C3 8 8 4 12 7C15 9 14 12 17 11C21 10 21 17 17 19C12 21 6 20 4 15Z" />,
};

export function PatternIcon({ name, size = 24 }: { name: string; size?: number }) {
  return (
    <svg
      className="pattern-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name] ?? ICONS.patternSolidBox}
    </svg>
  );
}
