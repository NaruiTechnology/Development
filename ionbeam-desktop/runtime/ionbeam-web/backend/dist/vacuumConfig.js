"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readVacuumEnabled = readVacuumEnabled;
const node_fs_1 = __importDefault(require("node:fs"));
/**
 * UI availability is a configured feature flag, not a controller health
 * probe.  An enabled but temporarily unavailable SBC must remain visible so
 * the operator can inspect its error state and recover it.
 */
function readVacuumEnabled(configPath) {
    try {
        const parsed = JSON.parse(node_fs_1.default.readFileSync(configPath, "utf8"));
        return parsed.Enable === true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=vacuumConfig.js.map