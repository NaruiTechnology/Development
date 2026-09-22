import scanIcon from "../assets/Scan.png";
import calibrateIcon from "../assets/Calibrate.png";
import rulerIcon from "../assets/ruler.png";
import magCalIcon from "../assets/MagCal.png";
import roiIcon from "../assets/ROI.png";
import rasterIcon from "../assets/raster.png";
import vectorIcon from "../assets/vector.png";
import dashboardIcon from "../assets/UHVacuumPump_1.png";
import adcTestIcon from "../assets/Cog.png";

type IconName =
  | "check"
  | "calibrate"
  | "circleTool"
  | "cog"
  | "commentTool"
  | "crop"
  | "download"
  | "edit"
  | "dashboard"
  | "globe"
  | "grid"
  | "gridSvg"
  | "help"
  | "alertTriangle"
  | "adcTest"
  | "waveform"
  | "highlightTool"
  | "image"
  | "infinity"
  | "home"
  | "layers"
  | "link"
  | "mail"
  | "magCal"
  | "moon"
  | "pause"
  | "play"
  | "plus"
  | "refresh"
  | "rectangleTool"
  | "route"
  | "ruler"
  | "scan"
  | "save"
  | "square"
  | "sun"
  | "target"
  | "atom"
  | "tools"
  | "fileText"
  | "eye"
  | "sheet"
  | "trash"
  | "upload"
  | "zoomIn"
  | "zoomOut"
  | "chevronDown"
  | "x";

export function Icon({
  name,
  tone,
}: {
  name: IconName;
  tone?: "accent" | "danger" | "success" | "tab" | "warn";
}) {
  const imageSource = imageSources[name];
  const className = `${tone ? `icon icon--${tone}` : "icon"} icon--${name}`;
  if (imageSource) {
    const intrinsicClass =
      name === "target"
        ? " icon--intrinsic icon--intrinsic-roi"
        : name === "grid" ||
          name === "route" ||
          name === "scan" ||
          name === "calibrate" ||
          name === "ruler" ||
          name === "magCal" ||
          name === "adcTest"
        ? " icon--intrinsic"
        : "";
    return (
      <img
        className={`${className}${intrinsicClass}`}
        src={imageSource}
        alt=""
        aria-hidden
      />
    );
  }

  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden>
      {paths[name] ?? null}
    </svg>
  );
}

const imageSources: Partial<Record<IconName, string>> = {
  scan: scanIcon,
  calibrate: calibrateIcon,
  ruler: rulerIcon,
  magCal: magCalIcon,
  adcTest: adcTestIcon,
  dashboard: dashboardIcon,
  target: roiIcon,
  grid: rasterIcon,
  route: vectorIcon,
  fileText: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAACXBIWXMAAAsTAAALEwEAmpwYAAAB/klEQVR4nO3ZWUsbURgG4Pk1WrEXtuDSulBFXKkGV7DkppBWqiIi4kItYqWgiBuKN60o9EaT09te9Fac/A4VjjGJcYmJRssr5xsdpBYXMnNmlPPCC5MzE/gecmYSiKapqKg8/YAFa8GC22BBpNu9+vfr8gEBfcuK4UV5Rp58BCwa/gpACI9Pf9QAqQjYBOCyEHYCuAyE3QBuN0IGgNuJkAXgdiGsBOzmVtyJiDW1r7sWcPJtST4CFgIeUk0BLqMATAHSy5MFRGu8iJQ2UqO1XiS/LNB6YmjWXI+UtyLW8gknY9/N9+2/60a4uN7sce+EM4DQizLsvqpBvHMU4aI68Mx8pGZWEe/6Ss/y/bYuHHh76Drx+rh/yoBXe7GTXYjDj5+pp+MrzgHEMOI4ObJoDNk3aQLO5hmdO//xGzvPixAufGsCQjmlzm8hAYi8aaBvV7GdeGYBUnP+GwAaurIN/FkB4NeNTyDrNWINPmpqbs05gBhUDCP2cnJ4ntb/BwiXeOh6cwsR4APVUcDVFrrefwGJwWnj901zu/u2UPQWgLixQy/LjeMSD/4u/3EX4KhjBImB6Rvrp5M/cegbosa7x+gegX/DPJ8YnKUnF5wG2F1NAS6jAEwB0osCMAVILwrAFMA9fzHduwF90zrAL71aKiKgb4JtVFkGUFFR0VybCyA7+nk5Yx4EAAAAAElFTkSuQmCC",
  sheet: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAACXBIWXMAAAsTAAALEwEAmpwYAAAC2klEQVR4nGNgGAWjYBSMgmEJODtdpHjbPXy5210bOFtcNnM0OT1jGJSg3p5FcEqwttAkvzjBCb4TBfp9dvP3eL3h7fb8z9Pp8Z+73e0/V6vLf85m5/8D7VQG4TlJvJILI20k54anic0Jmyg2M+SIyPSg78JTA/8LTQ74LzjR779Av+9//l7v/wPuAbmlmYKyqxJtZJcn5MssjVskvST2qtSiqL+SCyL/S8yL+C8+J+y/2KzQ/6Izgv8PSg8orEn+L78q6b/cioT/ssvi/sssif0vtSj6PyUeMDziThY2OOJ2eEh7wPCIO+mxN+qB7lEP/B90HkAGMIfhA6MekEfyQO3pRSiGZ+2fhOIB1dlx/z/+/AqXrzkwd3B5QH5p/P/r7x/BDb/1/sl/idlhcA9MO78RLnf9zcP/Qr2+gy8PhO5qRQmhuJ1dYA8YLEr7/+PPL7i4z6rKwZuJtz44BXfouVe3wR5YcWM/XGzl9f2DMw/IQD1gviYPJbRTdvf+//PvL5gNygNqs+IGfynUf2Ed3JL3P77A2RUHZg3eUkgGyQNKi+L/P/vyBsWyy6/v/xeZFDA0KjLVxYn/n319i+KBR59e/ZeaGjo0PLDoxh64w198fQdnd59aOfiTUMD2xv///v8DW/D998//sTs64BaCMrfpgozB6wGFpfH/b75/Ardg4vn14GJ078PzcLEjjy//F+j1GZwe6L+4Hm74h59f/qstTAR7wG5l4f+//yCxAgJJWzoHXx5w2FT2/ydS+d94cglKW2j97SNwuRdf3v2XmRQyeDwgvzz+/6lXt+AOfP713X+FBbEoHjBZnPn/998/cDUzzm4cfElIaig3p2VGPeA8eCoyiVEPuI96YEh5wOCw2yGGETe4i3N4fUGUscTcsLhBP7xOzgSHwAS/Dv4+n82DdoKDaPCfgZGv102Fp8sjlLvdrY2z1WUbR7Pzc+INGAWjYBSMAoYhAgBEtnuV0kUiSgAAAABJRU5ErkJggg==",
};

const paths: Partial<Record<IconName, JSX.Element>> = {
  waveform: (
    <path d="M3 13h3l2-6 4 12 3-9 2 3h4" />
  ),
  check: <path d="M5 12.5l4 4L19 6.5" />,
  highlightTool: (
    <>
      <path d="M5 15h6.5l4.5-4.5-3.5-3.5L8 11v4z" />
      <path d="M10.2 6.8l3 3" />
      <path d="M6 16h8" />
    </>
  ),
  commentTool: (
    <>
      <path d="M4 5h16v10H9l-5 4v-4H4z" />
      <path d="M8 9h8M8 12h4" />
    </>
  ),
  rectangleTool: <rect x="5" y="5" width="14" height="12" rx="1.5" />,
  circleTool: <circle cx="12" cy="12" r="6.5" />,
  cog: (
    <path
      fill="currentColor"
      stroke="none"
      d="M19.43 12.98c.04-.32.07-.65.07-.98s-.02-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.37-.31-.6-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.5.42l-.38 2.65c-.61.25-1.17.58-1.69.98l-2.49-1c-.23-.09-.48 0-.6.22l-2 3.46c-.12.22-.07.49.12.64l2.11 1.65c-.05.32-.08.65-.08.98s.03.66.08.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.37.31.6.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.38-2.65c.61-.25 1.17-.58 1.69-.98l2.49 1c.23.09.48 0 .6-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5z"
    />
  ),
  crop: <path d="M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14" />,
  download: <path d="M12 3v11m0 0l-4-4m4 4l4-4M5 19h14" />,
  edit: (
    <>
      <path d="M4 20h4l10.5-10.5a2.12 2.12 0 0 0-3-3L5 17v3z" />
      <path d="M13.5 7.5l3 3" />
    </>
  ),
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
  gridSvg: (
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
  alertTriangle: (
    <>
      <path d="M10.3 4.2a2 2 0 0 1 3.4 0l8.1 13.8A2 2 0 0 1 20.1 21H3.9a2 2 0 0 1-1.7-3L10.3 4.2z" />
      <path d="M12 9v5" />
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
  infinity: (
    <path d="M8.25 7.5c-2.9 0-5.25 2.02-5.25 4.5s2.35 4.5 5.25 4.5c3.75 0 5.75-9 9.5-9 2.9 0 5.25 2.02 5.25 4.5s-2.35 4.5-5.25 4.5c-3.75 0-5.75-9-9.5-9z" />
  ),
  home: (
    <>
      <path d="M4 11.5L12 4l8 7.5" />
      <path d="M6.5 10.5V20h11V10.5" />
      <path d="M10 20v-5h4v5" />
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
  plus: <path d="M12 5v14M5 12h14" />,
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
  eye: (
    <>
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
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
  zoomIn: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5L21 21M10.5 7.5v6M7.5 10.5h6" />
    </>
  ),
  zoomOut: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5L21 21M7.5 10.5h6" />
    </>
  ),
  x: <path d="M5 5l14 14M19 5L5 19" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
};
