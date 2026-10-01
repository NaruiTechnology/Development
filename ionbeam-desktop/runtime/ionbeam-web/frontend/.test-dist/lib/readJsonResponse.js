export async function readJsonResponse(response, label) {
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const url = response.url || "(unknown url)";
    const text = await response.text();
    if (!contentType.includes("application/json")) {
        const preview = text.trim().slice(0, 120).replace(/\s+/g, " ");
        const message = `${label}: expected JSON from ${url} but got ${contentType || "unknown content type"}${preview ? ` (${preview})` : ""}`;
        console.error(message);
        throw new Error(message);
    }
    try {
        return JSON.parse(text);
    }
    catch {
        const preview = text.trim().slice(0, 120).replace(/\s+/g, " ");
        const message = `${label}: invalid JSON from ${url}${preview ? ` (${preview})` : ""}`;
        console.error(message);
        throw new Error(message);
    }
}
