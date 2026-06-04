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
  | "link"
  | "mail"
  | "moon"
  | "pause"
  | "play"
  | "refresh"
  | "route"
  | "scan"
  | "save"
  | "square"
  | "sun"
  | "target"
  | "atom"
  | "tools"
  | "fileText"
  | "sheet"
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
    <path
      fill="currentColor"
      stroke="none"
      d="M19.43 12.98c.04-.32.07-.65.07-.98s-.02-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.37-.31-.6-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.5.42l-.38 2.65c-.61.25-1.17.58-1.69.98l-2.49-1c-.23-.09-.48 0-.6.22l-2 3.46c-.12.22-.07.49.12.64l2.11 1.65c-.05.32-.08.65-.08.98s.03.66.08.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.37.31.6.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.38-2.65c.61-.25 1.17-.58 1.69-.98l2.49 1c.23.09.48 0 .6-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5z"
    />
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
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L10.9 5.03" />
      <path d="M14 11a5 5 0 0 0-7.07 0L4.81 13.12a5 5 0 0 0 7.07 7.07l1.22-1.22" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M4 7l8 6 8-6" />
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
  save: (
    <>
      <path d="M5 3h12l2 2v16H5z" />
      <path d="M8 3v6h8V3" />
      <path d="M8 21v-7h8v7" />
      <path d="M8 10h8" />
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
  atom: (
    <>
      <circle cx="12" cy="12" r="1.7" />
      <ellipse cx="12" cy="12" rx="8" ry="3.2" />
      <ellipse cx="12" cy="12" rx="8" ry="3.2" transform="rotate(60 12 12)" />
      <ellipse cx="12" cy="12" rx="8" ry="3.2" transform="rotate(-60 12 12)" />
    </>
  ),
  fileText: (
    <>
      <path fill="#e53935" stroke="none" d="M6 3h8l4 4v14H6z" />
      <path fill="#ffffff" stroke="none" d="M14 3v5h4" />
      <path fill="#ffffff" stroke="none" d="M12 8l3.2 10h-1.9l-.8-2.6h-3l-.8 2.6H8.8L12 8zm.9 5.9-.9-3.1-.9 3.1h1.8z" />
    </>
  ),
  sheet: (
    <>
      <path fill="#1d6f42" stroke="none" d="M6 3h8l4 4v14H6z" />
      <path fill="#ffffff" stroke="none" d="M14 3v5h4" />
      <path fill="#ffffff" stroke="none" d="M9 9h6l-6 6h6l-6 6" />
      <path fill="none" d="M6 3h8l4 4v14H6z" />
    </>
  ),
  tools: (
    <>
      <path d="M14.7 6.3a4 4 0 0 0 4.9 4.9L12 18.8 8.2 15l7.6-7.6z" />
      <path d="M5 4l4 4M7 2l4 4M3 6l4 4" />
      <path d="M2 22l6.2-6.2" />
      <path d="M14 14l6 6" />
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
