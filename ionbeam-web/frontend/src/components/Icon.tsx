type IconName =
  | "check"
  | "crop"
  | "download"
  | "grid"
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
  crop: <path d="M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14" />,
  download: <path d="M12 3v11m0 0l-4-4m4 4l4-4M5 19h14" />,
  grid: (
    <>
      <path d="M4 4h16v16H4z" />
      <path d="M9.33 4v16M14.67 4v16M4 9.33h16M4 14.67h16" />
    </>
  ),
  image: (
    <>
      <path d="M4 5h16v14H4z" />
      <path d="M7 15l3-3 3 3 2-2 3 3" />
      <path d="M8 8.5h.01" />
    </>
  ),
  layers: (
    <>
      <path d="M12 3l9 5-9 5-9-5z" />
      <path d="M3 12l9 5 9-5M3 16l9 5 9-5" />
    </>
  ),
  moon: <path d="M20 15.5A8 8 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5z" />,
  pause: (
    <>
      <path d="M8 5v14" />
      <path d="M16 5v14" />
    </>
  ),
  play: <path d="M8 5v14l11-7z" />,
  refresh: (
    <>
      <path d="M20 7v5h-5" />
      <path d="M4 17v-5h5" />
      <path d="M18 9a7 7 0 0 0-11.8-2M6 15a7 7 0 0 0 11.8 2" />
    </>
  ),
  route: (
    <>
      <path d="M5 6a2 2 0 1 0 0 .01" />
      <path d="M19 18a2 2 0 1 0 0 .01" />
      <path d="M7 6h4a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h8" />
    </>
  ),
  scan: (
    <>
      <path d="M4 7V4h3M17 4h3v3M20 17v3h-3M7 20H4v-3" />
      <path d="M7 12h10" />
    </>
  ),
  square: <path d="M7 7h10v10H7z" />,
  sun: (
    <>
      <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </>
  ),
  target: (
    <>
      <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z" />
      <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" />
      <path d="M12 12h.01" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V5h6v2M7 7l1 13h8l1-13M10 11v5M14 11v5" />
    </>
  ),
  upload: <path d="M12 21V10m0 0l-4 4m4-4l4 4M5 5h14" />,
  x: (
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </>
  ),
};
