/** Always use the backend managed by the desktop launcher. */
export function apiOrigin() { return ""; }
export function apiUrl(path) { return path; }
export function wsUrl(path) { return `${window.location.origin}${path}`; }
