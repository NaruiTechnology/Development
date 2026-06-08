import { scanAuthHeaders } from "./authIdentity";

interface StoredAdminUser {
  id?: unknown;
}

export type ActivityScanKind = "raster" | "vector";

const SELECTED_EQUIPMENT_KEY = "ionbeam:selectedEquipmentId";

export function recordScanActivity(kind: ActivityScanKind): void {
  const userId = currentAdminUserId();
  const equipmentId = currentEquipmentId();

  void fetch("/api/admin/iobeam/activity", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...scanAuthHeaders() },
    body: JSON.stringify({
      ...(userId ? { user_id: userId } : {}),
      ...(equipmentId ? { equipment_id: equipmentId } : {}),
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

export function selectedEquipmentId(): number | null {
  return currentEquipmentId();
}

export function setSelectedEquipmentId(id: number): void {
  try {
    window.localStorage.setItem(SELECTED_EQUIPMENT_KEY, String(id));
  } catch {
    /* ignore storage failures */
  }
}

function currentEquipmentId(): number | null {
  try {
    const id = Number(window.localStorage.getItem(SELECTED_EQUIPMENT_KEY));
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}
