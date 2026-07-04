function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isLocalViteHost(): boolean {
  if (typeof window === "undefined") return false;
  const { hostname, port } = window.location;
  return (
    (hostname === "localhost" || hostname === "127.0.0.1") &&
    (port === "5173" || port === "4173")
  );
}

export function apiOrigin(): string {
  const explicit = import.meta.env.VITE_API_BASE_URL?.trim();
  if (explicit) return normalizeOrigin(explicit);
  if (isLocalViteHost()) return "http://127.0.0.1:4000";
  return "";
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
  if (isLocalViteHost()) return `ws://127.0.0.1:4000${path}`;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}
