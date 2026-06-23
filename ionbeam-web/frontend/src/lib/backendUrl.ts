function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function apiOrigin(): string {
  const explicit = import.meta.env.VITE_API_BASE_URL?.trim();
  return explicit ? normalizeOrigin(explicit) : "";
}

export function apiUrl(path: string): string {
  const origin = apiOrigin();
  return origin ? `${origin}${path}` : path;
}

export function wsUrl(path: string): string {
  const origin = apiOrigin();
  if (origin) {
    return `${origin.replace(/^http/, "ws")}${path}`;
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}
