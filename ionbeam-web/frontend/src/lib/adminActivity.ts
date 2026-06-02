interface StoredAdminUser {
  id?: unknown;
}

export type ActivityScanKind = "raster" | "vector";

export function recordScanActivity(kind: ActivityScanKind): void {
  const userId = currentAdminUserId();
  if (!userId) return;

  void fetch("/api/admin/iobeam/activity", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: userId,
      activity_type: `${kind}_scan`,
    }),
  }).catch((err) => {
    console.warn(
      `[iobeam-admin/activity] failed to record ${kind} scan activity`,
      err,
    );
  });
}

function currentAdminUserId(): number | null {
  try {
    const raw = window.localStorage.getItem("ionbeam:adminUser");
    if (!raw) return null;
    const user = JSON.parse(raw) as StoredAdminUser;
    const id = Number(user.id);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}
