type IconName =
  | "check"
  | "cog"
  | "crop"
  | "download"
  | "globe"
  | "grid"
  | "help"
  | "image"
  | "layers"
  | "moon"
  | "pause"
  | "play"
  | "refresh"
  | "route"
  | "scan"
  | "square"
  | "sun"
  | "target"
  | "trash"
  | "upload"
  | "x";

export function Icon({
  name,
  tone,
}: {
  name: IconName;
  tone?: "accent" | "danger" | "success" | "tab" | "warn";
}) {
  return (
    <svg className={tone ? `icon icon--${tone}` : "icon"} viewBox="0 0 24 24" aria-hidden>
      {paths[name]}
    </svg>
  );
}

const paths: Record<IconName, JSX.Element> = {
  check: <path d="M5 12.5l4 4L19 6.5" />,
  cog: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M2 12h3M19 12h3M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12" />
    </>
  ),
  crop: <path d="M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14" />,
  download: <path d="M12 3v11m0 0l-4-4m4 4l4-4M5 19h14" />,
  // Globe — outer circle + equator + a meridian. Two curves are enough
  // to read as "globe" without looking like a tennis ball; deliberately
  // chunky to match the stroke weight of the other 24×24 icons.
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a13 13 0 0 1 0 18 13 13 0 0 1 0-18" />
    </>
  ),
  grid: (
    <>
      <path d="M4 4h16v16H4z" />
      <path d="M9.33 4v16M14.67 4v16M4 9.33h16M4 14.67h16" />
    </>
  ),
  help: (
    <>
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="M21 15l-5-5L5 21" />
    </>
  ),
  layers: (
    <>
      <path d="M12 2L2 8l10 6 10-6-10-6z" />
      <path d="M2 14l10 6 10-6" />
    </>
  ),
  moon: <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />,
  pause: (
    <>
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </>
  ),
  play: <path d="M6 4l14 8-14 8V4z" />,
  refresh: (
    <>
      <path d="M20 4v6h-6" />
      <path d="M20 10a8 8 0 1 0-2.34 5.66" />
    </>
  ),
  route: (
    <>
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M8 6h6a4 4 0 0 1 0 8h-4a4 4 0 0 0 0 8h6" />
    </>
  ),
  scan: (
    <>
      <path d="M4 8V5a1 1 0 0 1 1-1h3" />
      <path d="M20 8V5a1 1 0 0 0-1-1h-3" />
      <path d="M4 16v3a1 1 0 0 0 1 1h3" />
      <path d="M20 16v3a1 1 0 0 1-1 1h-3" />
      <path d="M4 12h16" />
    </>
  ),
  square: <rect x="6" y="6" width="12" height="12" rx="1" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.6" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1.5 14a2 2 0 0 1-2 1.8h-7a2 2 0 0 1-2-1.8L5 6" />
    </>
  ),
  upload: <path d="M12 21V10m0 0l-4 4m4-4l4 4M5 5h14" />,
  x: <path d="M5 5l14 14M19 5L5 19" />,
};
