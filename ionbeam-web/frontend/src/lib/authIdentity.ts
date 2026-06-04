interface StoredSignedInUser {
  login_name?: string;
  session_token?: string;
}

const STORAGE_KEY = "ionbeam:adminUser";

export function currentAdminSessionToken(): string {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return "";
  try {
    const user = JSON.parse(raw) as StoredSignedInUser;
    return typeof user.session_token === "string" ? user.session_token : "";
  } catch {
    return "";
  }
}

export function scanAuthHeaders(): Record<string, string> {
  const token = currentAdminSessionToken();
  return token ? { "X-Iobeam-Auth": token } : {};
}

export function withScanAuthQuery(path: string): string {
  const token = currentAdminSessionToken();
  if (!token) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}auth=${encodeURIComponent(token)}`;
}
