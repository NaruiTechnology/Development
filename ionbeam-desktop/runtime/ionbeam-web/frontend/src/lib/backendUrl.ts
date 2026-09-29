/** Always use the backend managed by the desktop launcher. */
export function apiOrigin(): string { return ""; }
export function apiUrl(path: string): string { return path; }
export function wsUrl(path: string): string { return `${window.location.origin}${path}`; }
