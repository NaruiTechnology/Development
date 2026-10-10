"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.attachDesktopSessions = attachDesktopSessions;
const node_crypto_1 = require("node:crypto");
const wsProxy_1 = require("./wsProxy");
function attachDesktopSessions(app, authorize) {
    const sessions = new Map();
    const cleanup = setInterval(() => {
        for (const [id, session] of sessions)
            if (Date.now() - session.created > 86400000)
                sessions.delete(id);
    }, 60000);
    cleanup.unref();
    app.post("/desktop-session/start", async (req, res) => {
        try {
            const auth = await authorize(req);
            if (!auth.ok) {
                res.status(auth.status).json({ error: auth.message });
                return;
            }
            const { kind, request } = req.body ?? {};
            if (!["raster", "vector", "adc", "dac_ramp"].includes(kind) || !request || typeof request !== "object") {
                res.status(400).json({ error: "Invalid native scan request" });
                return;
            }
            const activity = (kind === "raster" || kind === "vector") && !(0, wsProxy_1.isPreviewScan)(request)
                ? (0, wsProxy_1.recordScanStart)(kind, auth.actor, request).catch(error => { console.warn("Scan activity recording failed", error.message); return null; }) : null;
            const id = (0, node_crypto_1.randomUUID)();
            sessions.set(id, { actor: Number(auth.actor.id), kind, request, activity, created: Date.now() });
            res.json({ id });
        }
        catch (error) {
            res.status(500).json({ error: String(error) });
        }
    });
    app.post("/desktop-session/:id/finish", async (req, res) => {
        try {
            const auth = await authorize(req);
            if (!auth.ok) {
                res.status(auth.status).json({ error: auth.message });
                return;
            }
            const session = sessions.get(req.params.id);
            if (!session || session.actor !== Number(auth.actor.id)) {
                res.status(404).json({ error: "Unknown scan session" });
                return;
            }
            sessions.delete(req.params.id);
            const event = req.body ?? {};
            if (event.event === "done" && (session.kind === "raster" || session.kind === "vector")) {
                try {
                    const output = await (0, wsProxy_1.recordAndMaybePersistScanCompletion)(session.kind, session.request, session.activity, event, !(0, wsProxy_1.isPreviewScan)(session.request));
                    if (output)
                        Object.assign(event, { csv_filename: output.csvFilename, image_filename: output.imageFilename });
                }
                catch (error) {
                    event.persistence_warning = String(error);
                }
            }
            res.json(event);
        }
        catch (error) {
            res.status(500).json({ error: String(error) });
        }
    });
}
//# sourceMappingURL=desktopStream.js.map