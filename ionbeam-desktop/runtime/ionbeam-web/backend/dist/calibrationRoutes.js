"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerCalibrationRoutes = registerCalibrationRoutes;
const calibrationRepository_1 = require("./calibrationRepository");
const calibrationCsvFile_1 = require("./calibrationCsvFile");
const calibrationVendorFile_1 = require("./calibrationVendorFile");
const BASE = "/api/admin/iobeam/calibration";
const MAX_WRITE_ITEMS = 2000;
const MAX_IMPORT_CHARS = 8_000_000;
function registerCalibrationRoutes(app, deps) {
    const route = (minRole, message, handler) => async (req, res) => {
        try {
            res.set("Cache-Control", "no-store");
            const actor = await deps.currentActor(req);
            if (!actor || !actor.is_active) {
                throw new calibrationRepository_1.CalibrationRequestError("sign in to use the calibration parameters", 401, "unauthenticated");
            }
            if (actor.role < minRole) {
                throw new calibrationRepository_1.CalibrationRequestError(message, 403, "forbidden_role");
            }
            await handler(req, res, actor);
        }
        catch (err) {
            if (err instanceof calibrationRepository_1.CalibrationRequestError) {
                res.status(err.status).json({ ok: false, error: err.message, code: err.code, errors: err.details, ...err.extra });
                return;
            }
            deps.sendError(res, err);
        }
    };
    // -------------------------------------------------------------------------------- reads
    app.get(`${BASE}/groups`, route(0, "", async (req, res) => {
        const type = parseType(req.query.equipment_type);
        const equipmentId = req.query.equipment_id === undefined ? null : parseId(req.query.equipment_id, "equipment_id");
        res.json(await (0, calibrationRepository_1.listCalibrationGroups)(type, equipmentId, optionalString(req.query.profile_name)));
    }));
    app.get(`${BASE}/:equipmentId/:type`, route(0, "", async (req, res) => {
        res.json(await (0, calibrationRepository_1.getEquipmentCalibrationBundle)(parseId(req.params.equipmentId, "equipment id"), parseType(req.params.type), readQuery(req.query)));
    }));
    app.get(`${BASE}/:equipmentId/:type/tables/:tableCode`, route(0, "", async (req, res) => {
        res.json(await (0, calibrationRepository_1.getCalibrationTable)(parseId(req.params.equipmentId, "equipment id"), parseType(req.params.type), String(req.params.tableCode), optionalString(req.query.profile_name)));
    }));
    app.get(`${BASE}/:equipmentId/:type/history`, route(0, "", async (req, res) => {
        const revisions = await (0, calibrationRepository_1.listEquipmentCalibrationHistory)(parseId(req.params.equipmentId, "equipment id"), parseType(req.params.type), {
            profile_name: optionalString(req.query.profile_name),
            parameter_key: optionalString(req.query.parameter_key),
            limit: optionalInt(req.query.limit),
            offset: optionalInt(req.query.offset),
        });
        res.json({ ok: true, revisions });
    }));
    app.get(`${BASE}/:equipmentId/:type/history/:revision`, route(0, "", async (req, res) => {
        res.json(await (0, calibrationRepository_1.getCalibrationRevision)(parseId(req.params.equipmentId, "equipment id"), parseType(req.params.type), parseId(req.params.revision, "revision"), optionalString(req.query.profile_name)));
    }));
    app.get(`${BASE}/:equipmentId/:type/export.csv`, route(0, "", async (req, res) => {
        const equipmentId = parseId(req.params.equipmentId, "equipment id");
        const type = parseType(req.params.type);
        const bundle = await (0, calibrationRepository_1.getEquipmentCalibrationBundle)(equipmentId, type, {
            ...readQuery(req.query),
            include_cells: true,
            limit: 5000,
            offset: 0,
        });
        res
            .type("text/csv; charset=utf-8")
            .set("Content-Disposition", `attachment; filename="calibration_${equipmentId}_${type}_r${bundle.profile?.revision ?? 0}.csv"`)
            .send(bundleToCsv(bundle));
    }));
    // -------------------------------------------------------------------------------- writes
    app.put(`${BASE}/:equipmentId/:type/values`, route(deps.roles.superUser, "editing calibration parameters needs SuperUser or higher", async (req, res, actor) => {
        const body = asObject(req.body);
        const values = body.values;
        if (!Array.isArray(values) || values.length === 0 || values.length > MAX_WRITE_ITEMS) {
            throw new calibrationRepository_1.CalibrationRequestError(`expected { values: [...] } with 1..${MAX_WRITE_ITEMS} entries`, 400, "bad_request");
        }
        const bundle = await (0, calibrationRepository_1.saveEquipmentCalibration)({
            equipment_id: parseId(req.params.equipmentId, "equipment id"),
            equipment_type: parseType(req.params.type),
            profile_name: optionalString(body.profile_name) ?? "",
            notes: optionalString(body.notes) ?? "",
            actor_user_id: actor.id,
            actor_role: actor.role,
            reason: optionalString(body.reason)?.slice(0, 500),
            expected_revision: optionalInt(body.expected_revision),
            acknowledge_risk: body.acknowledge_risk === true,
            dry_run: body.dry_run === true,
            values: values.map(readWriteItem),
        });
        res.json(bundle);
    }));
    app.post(`${BASE}/:equipmentId/:type/restore`, route(deps.roles.superUser, "restoring calibration parameters needs SuperUser or higher", async (req, res, actor) => {
        const body = asObject(req.body);
        const result = await (0, calibrationRepository_1.restoreCalibrationRevision)({
            equipment_id: parseId(req.params.equipmentId, "equipment id"),
            equipment_type: parseType(req.params.type),
            profile_name: optionalString(body.profile_name),
            revision: parseId(body.revision, "revision"),
            reason: optionalString(body.reason)?.slice(0, 500),
            acknowledge_risk: body.acknowledge_risk === true,
            expected_revision: optionalInt(body.expected_revision),
            dry_run: body.dry_run === true,
            actor_user_id: actor.id,
            actor_role: actor.role,
        });
        res.json({ ok: true, result });
    }));
    app.post(`${BASE}/:equipmentId/:type/import`, route(deps.roles.developer, "importing a vendor file needs Developer or higher", async (req, res, actor) => {
        const body = asObject(req.body);
        const content = typeof body.content === "string" ? body.content : "";
        if (!content.trim() || content.length > MAX_IMPORT_CHARS) {
            throw new calibrationRepository_1.CalibrationRequestError("expected { file_name, content } with the text of a vendor file or calibration CSV", 400, "bad_request");
        }
        const equipmentId = parseId(req.params.equipmentId, "equipment id");
        const type = parseType(req.params.type);
        const fileName = (optionalString(body.file_name) ?? "vendor file").slice(0, 300);
        // A calibration CSV (the Export CSV format) is validated as a whole: any structural problem refuses the file, with
        // every problem and its line number in errors[]. Vendor text files keep their line-based parsers.
        let parsed;
        try {
            parsed = (0, calibrationCsvFile_1.isCalibrationCsv)(fileName, content)
                ? (0, calibrationCsvFile_1.parseCalibrationCsv)(content, { fileName, equipmentId, type })
                : (0, calibrationVendorFile_1.parseVendorFile)(content);
        }
        catch (err) {
            if (err instanceof calibrationCsvFile_1.CalibrationCsvError) {
                throw new calibrationRepository_1.CalibrationRequestError(err.message, 422, "invalid_csv", err.issues, { total_errors: err.totalIssues });
            }
            throw new calibrationRepository_1.CalibrationRequestError(err instanceof Error ? err.message : String(err), 422, "unrecognised_file");
        }
        const payload = {
            equipment_id: equipmentId,
            equipment_type: type,
            profile_name: optionalString(body.profile_name),
            file_name: fileName,
            items: parsed.items,
            dry_run: body.dry_run !== false, // preview unless the caller explicitly commits
            reason: optionalString(body.reason)?.slice(0, 500),
            acknowledge_risk: body.acknowledge_risk === true,
            actor_user_id: actor.id,
            actor_role: actor.role,
        };
        // Never trust a client to perform the preview first. A commit is validated again server-side and refused as a
        // whole when any recognised value is invalid; unmatched vendor-only settings remain intentionally ignored.
        if (!payload.dry_run) {
            const validation = await (0, calibrationRepository_1.importEquipmentCalibration)({ ...payload, dry_run: true });
            if (validation.rejected_count > 0) {
                throw new calibrationRepository_1.CalibrationRequestError(`${validation.rejected_count} recognised value(s) failed validation; nothing was imported`, 422, "validation_failed", validation.rejected.map((item) => ({ code: "invalid_value", ...item })), { total_errors: validation.rejected_count });
            }
        }
        const result = await (0, calibrationRepository_1.importEquipmentCalibration)(payload);
        if (parsed.format !== "csv") {
            res.json({ ...result, format: parsed.format, lines: parsed.lines, skipped_binary: parsed.skippedBinary });
            return;
        }
        res.json({ ...withCsvLines(result, parsed), format: "csv", lines: parsed.lines, skipped_binary: 0, csv: csvSummary(result, parsed) });
    }));
    // -------------------------------------------------------------------------------- catalog administration
    app.patch(`${BASE}/definitions/:id`, route(deps.roles.admin, "editing the parameter catalog needs Admin", async (req, res, actor) => {
        const body = asObject(req.body);
        const definition = await (0, calibrationRepository_1.updateCalibrationDefinition)({
            id: parseId(req.params.id, "definition id"),
            actor_user_id: actor.id,
            actor_role: actor.role,
            display_name: optionalString(body.display_name),
            description: typeof body.description === "string" ? body.description : undefined,
            unit: typeof body.unit === "string" ? body.unit : undefined,
            param_class: optionalString(body.param_class),
            semantics_known: typeof body.semantics_known === "boolean" ? body.semantics_known : undefined,
            review_state: optionalString(body.review_state),
            is_active: typeof body.is_active === "boolean" ? body.is_active : undefined,
        });
        res.json({ ok: true, definition });
    }));
    app.post(`${BASE}/catalog/reload`, route(deps.roles.admin, "reloading the parameter catalog needs Admin", async (_req, res) => {
        await (0, calibrationRepository_1.loadCalibrationCatalogSeed)();
        res.json({ ok: true });
    }));
}
// ------------------------------------------------------------------------------------------ helpers
function parseType(value) {
    const type = String(Array.isArray(value) ? value[0] : value ?? "").toUpperCase();
    if (type !== "FIB" && type !== "SEM") {
        throw new calibrationRepository_1.CalibrationRequestError("equipment type must be FIB or SEM", 400, "bad_request");
    }
    return type;
}
function parseId(value, label) {
    const n = Number(Array.isArray(value) ? value[0] : value);
    if (!Number.isInteger(n) || n <= 0) {
        throw new calibrationRepository_1.CalibrationRequestError(`${label} must be a positive integer`, 400, "bad_request");
    }
    return n;
}
function optionalInt(value) {
    if (value === undefined || value === null || value === "")
        return undefined;
    const n = Number(Array.isArray(value) ? value[0] : value);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
}
function optionalString(value) {
    const s = Array.isArray(value) ? value[0] : value;
    return typeof s === "string" && s.trim() ? s.trim() : undefined;
}
function optionalBool(value) {
    const s = String(Array.isArray(value) ? value[0] : value ?? "").toLowerCase();
    if (s === "1" || s === "true")
        return true;
    if (s === "0" || s === "false")
        return false;
    return undefined;
}
function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function readQuery(query) {
    const keys = optionalString(query.keys);
    return {
        profile_name: optionalString(query.profile_name),
        group_code: optionalString(query.group_code),
        q: optionalString(query.q)?.slice(0, 100),
        param_class: optionalString(query.param_class),
        access_level: optionalString(query.access_level),
        review_state: optionalString(query.review_state),
        undocumented: optionalBool(query.undocumented),
        low_confidence: optionalBool(query.low_confidence),
        include_cells: optionalBool(query.include_cells),
        keys: keys ? keys.split(",").map((k) => k.trim()).filter(Boolean).slice(0, 500) : undefined,
        limit: optionalInt(query.limit),
        offset: optionalInt(query.offset),
    };
}
function readWriteItem(raw) {
    const item = asObject(raw);
    const key = optionalString(item.parameter_key);
    if (!key) {
        throw new calibrationRepository_1.CalibrationRequestError("every value needs a parameter_key", 400, "bad_request");
    }
    return {
        parameter_key: key,
        ...(item.clear === true ? { clear: true } : { value: item.value }),
        ...(typeof item.notes === "string" ? { notes: item.notes.slice(0, 1000) } : {}),
        ...(item.verified === true ? { verified: true } : {}),
    };
}
/** Point the database's per-parameter findings (rejected / warnings) at the line of the CSV they came from. */
function withCsvLines(result, parsed) {
    const addLine = (list) => Array.isArray(list)
        ? list.map((entry) => {
            const key = entry && typeof entry === "object" ? entry.parameter_key : undefined;
            const line = typeof key === "string" ? parsed.lineOfKey.get(key) : undefined;
            return line === undefined ? entry : { ...entry, line };
        })
        : list;
    const r = result;
    return { ...result, rejected: addLine(r.rejected), warnings: addLine(r.warnings) };
}
function csvSummary(result, parsed) {
    const r = result;
    const warnings = [...parsed.warnings];
    if ((r.matched ?? 0) === 0 && (r.unmatched_count ?? 0) === parsed.items.length && (r.other_type_count ?? 0) === 0) {
        // Nothing matched at all: either a foreign file, or a database whose import function predates CSV matching.
        warnings.push({
            line: 0,
            code: "no_key_matched",
            message: "none of the parameter keys is known to this column's catalog. If the file was exported by this application, " +
                "re-apply the admin database setup (CONFIGURATION > Admin > Configuration) so the database can match CSV keys.",
        });
    }
    return {
        rows: parsed.rows,
        values: parsed.items.length,
        skipped_empty: parsed.skippedEmpty,
        delimiter: parsed.delimiter,
        warnings,
        file_equipment_id: parsed.fileEquipmentId,
        file_type: parsed.fileType,
        file_revision: parsed.fileRevision,
    };
}
function bundleToCsv(bundle) {
    const values = new Map(bundle.values.map((v) => [v.parameter_key, v]));
    const header = [
        "parameter_key", "vendor_name", "category", "display_name", "value", "unit", "value_type",
        "access_level", "param_class", "semantics_known", "review_state", "verified_at", "notes", "source_reference",
    ];
    const lines = [header.join(",")];
    for (const d of bundle.definitions) {
        const v = values.get(d.parameter_key);
        lines.push([
            d.parameter_key, d.vendor_name ?? "", d.category, d.display_name,
            v && v.value !== null && v.value !== undefined ? String(v.value) : "",
            d.unit, d.value_type, d.access_level ?? "", d.param_class ?? "", d.semantics_known === false ? "no" : "yes",
            d.review_state ?? "", v?.verified_at ?? "", v?.notes ?? "", d.source_reference,
        ]
            .map((cell, i) => csvCell(String(cell), i === 4))
            .join(","));
    }
    return `\uFEFF${lines.join("\r\n")}\r\n`;
}
/** RFC 4180 quoting; text that a spreadsheet would execute as a formula is neutralised (except the value column, which is numeric). */
function csvCell(text, isValueColumn) {
    let cell = text;
    if (!isValueColumn && /^[=+\-@\t\r]/.test(cell))
        cell = `'${cell}`;
    return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}
//# sourceMappingURL=calibrationRoutes.js.map