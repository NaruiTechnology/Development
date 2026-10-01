/** Same bound as MAX_IMPORT_CHARS in calibrationRoutes.ts (8 M characters; bytes are a close upper bound). */
export const IMPORT_MAX_BYTES = 8_000_000;
export const IMPORT_ACCEPT = ".txt,.TXT,.csv,.CSV,text/plain,text/csv";
const EXPORT_NAME = /calibration_(\d+)_(FIB|SEM)_r(\d+)/i;
/** What an Export CSV file name says (calibration_<equipment>_<FIB|SEM>_r<revision>.csv), or null. */
export function exportFileInfo(name) {
    const m = EXPORT_NAME.exec(name);
    return m ? { equipmentId: Number(m[1]), type: m[2].toUpperCase(), revision: Number(m[3]) } : null;
}
export function precheckImportFile(file, type) {
    const name = file.name.trim();
    const kind = /\.csv$/i.test(name) ? "csv" : /\.txt$/i.test(name) ? "vendor" : null;
    if (kind === null)
        return { ok: false, reason: "extension" };
    if (file.size === 0)
        return { ok: false, reason: "empty" };
    if (file.size > IMPORT_MAX_BYTES)
        return { ok: false, reason: "tooLarge" };
    if (kind === "csv") {
        const info = exportFileInfo(name);
        if (info && info.type !== type)
            return { ok: false, reason: "wrongType", fileType: info.type };
    }
    return { ok: true, kind };
}
