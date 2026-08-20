import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import mechanicalPumpImage from "../assets/MechanicalVacuumPump.png";
import turboPumpImage from "../assets/TurboVacuumPump.png";
import uhPump1Image from "../assets/UHVacuumPump_1.png";
import uhPump2Image from "../assets/UHVacuumPump_2.png";
import { useTranslation } from "../i18n";
import { scanAuthHeaders } from "../lib/authIdentity";
import { apiUrl } from "../lib/backendUrl";
import { readJsonResponse } from "../lib/readJsonResponse";
import type { VacuumPumpState, VacuumSystemStatus } from "../types/api";

const MECHANICAL_PUMP = "MechanicalVacuumPump";
const PUMP_IMAGES: Record<string, string> = {
  MechanicalVacuumPump: mechanicalPumpImage,
  TurboVacuumPump: turboPumpImage,
  UHVacuumPump_1: uhPump1Image,
  UHVacuumPump_2: uhPump2Image,
};

export function VacuumDashboard({ open, minimized, onMinimizedChange, onActivityChange, onClose }: { open: boolean; minimized: boolean; onMinimizedChange: (minimized: boolean) => void; onActivityChange: (active: boolean) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<VacuumSystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [windowOffset, setWindowOffset] = useState({ x: 0, y: 0 });
  const mutationRef = useRef(false);
  const statusVersionRef = useRef(0);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  } | null>(null);

  useEffect(() => {
    const initializing = status?.running === true
      && status.isVacuumSystemReady !== true
      && status.cascade_stopped !== true
      && error === null;
    onActivityChange(open && (pending !== null || initializing));
  }, [error, onActivityChange, open, pending, status?.cascade_stopped, status?.isVacuumSystemReady, status?.running]);

  useEffect(() => () => onActivityChange(false), [onActivityChange]);

  function startDragging(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, input, label, a")) return;
    const dialog = event.currentTarget.closest<HTMLElement>(".vacuum-dashboard");
    if (!dialog) return;
    const bounds = dialog.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: windowOffset.x,
      originY: windowOffset.y,
      minX: windowOffset.x + 8 - bounds.left,
      maxX: windowOffset.x + window.innerWidth - 8 - bounds.right,
      minY: windowOffset.y + 8 - bounds.top,
      maxY: windowOffset.y + window.innerHeight - 8 - bounds.bottom,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDragging(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setWindowOffset({
      x: Math.min(drag.maxX, Math.max(drag.minX, drag.originX + event.clientX - drag.startX)),
      y: Math.min(drag.maxY, Math.max(drag.minY, drag.originY + event.clientY - drag.startY)),
    });
  }

  function stopDragging(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (mutationRef.current) return;
    const statusVersion = statusVersionRef.current;
    try {
      const response = await fetch(apiUrl("/api/vacuum"), { headers: scanAuthHeaders(), signal });
      if (response.status === 404) {
        onCloseRef.current();
        return;
      }
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const refreshed = await readJsonResponse<VacuumSystemStatus>(response, "vacuum status");
      if (mutationRef.current || statusVersion !== statusVersionRef.current) return;
      setStatus(refreshed);
      setError(null);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      if (mutationRef.current || statusVersion !== statusVersionRef.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setWindowOffset({ x: 0, y: 0 });
    const pollController = new AbortController();
    setStatus(null);
    setError(null);
    setPending(null);
    void refresh(pollController.signal);
    const timer = window.setInterval(() => void refresh(pollController.signal), 1000);

    return () => {
      pollController.abort();
      window.clearInterval(timer);
    };
  }, [open, refresh]);

  const closeDashboard = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeDashboard();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeDashboard, open]);

  async function updatePower(name: string, power: boolean) {
    setPending(name);
    setError(null);
    try {
      const response = await fetch(apiUrl(`/api/vacuum/pumps/${encodeURIComponent(name)}/power`), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...scanAuthHeaders() },
        body: JSON.stringify({ power }),
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || `${response.status} ${response.statusText}`);
      }
      setStatus(await readJsonResponse<VacuumSystemStatus>(response, "vacuum power"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  }

  if (!open) return null;

  const mechanicalPump = status?.pumps.find((pump) => pump.name === MECHANICAL_PUMP);
  const turboPump = status?.pumps.find((pump) => pump.name === "TurboVacuumPump");
  const uhPumps = status?.pumps.filter((pump) => pump.group === "ultra-high-vacuum") ?? [];
  const workflowNames = new Set([
    MECHANICAL_PUMP,
    "TurboVacuumPump",
    ...uhPumps.map((pump) => pump.name),
  ]);
  const otherPumps = status?.pumps.filter((pump) => !workflowNames.has(pump.name)) ?? [];

  function renderPumpCard(pump: VacuumPumpState) {
    const mechanical = pump.name === MECHANICAL_PUMP;
    return (
      <article key={pump.name} className="card vacuum-card" data-border={pump.border}>
        <div className="card__header vacuum-card__header">
          <span className="card__title">{pump.name}</span>
          <label className="vacuum-switch" title={mechanical ? t("vacuum.mechanicalAlwaysOn") : pump.name}>
            <input
              type="checkbox"
              checked={pump.port_b_value === status?.voltage}
              disabled
              aria-label={`${pump.name} ${t("vacuum.power")}`}
            />
            <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
          </label>
        </div>
        <div className="card__body vacuum-card__body">
          {PUMP_IMAGES[pump.name] && (
            <div className="vacuum-card__image-wrap">
              <img className="vacuum-card__image" src={PUMP_IMAGES[pump.name]} alt="" />
            </div>
          )}
          <div className="vacuum-card__reading"><span>{t("vacuum.threshold")}</span><strong>{formatVacuumValue(pump.threshold)}</strong></div>
          <div className="vacuum-card__reading"><span>{t("vacuum.realtime")}</span><strong className={`vacuum-card__realtime-value${pump.power && pump.port_b_value === 0 ? " vacuum-card__realtime-value--reading" : ""}`}>{pump.value == null ? "—" : formatVacuumValue(pump.value)}</strong></div>
          <div className="vacuum-card__actions">
            <span className="vacuum-card__pins"><code>{pump.write}</code> → <code>{pump.read}</code></span>
            <div className="vacuum-card__controls">
              <button
                type="button"
                className="vacuum-power-button"
                data-state={pump.power ? "on" : "off"}
                disabled={mechanical || !status?.running || pending !== null}
                aria-pressed={pump.power}
                aria-label={`${pump.name} ${t("vacuum.power")}`}
                title={`${t("vacuum.power")} ${pump.power ? "off" : "on"}`}
                onClick={() => void updatePower(pump.name, !pump.power)}
              >
                <svg className="vacuum-power-button__icon" viewBox="0 0 24 24" aria-hidden>
                  <path d="M12 3v8" />
                  <path d="M7.05 5.93a9 9 0 1 0 9.9 0" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </article>
    );
  }

  return (
    <div className="modal-backdrop vacuum-dashboard__backdrop" role="presentation">
      {!minimized && <section className="modal vacuum-dashboard" role="dialog" aria-labelledby="vacuum-title" style={{ transform: `translate3d(${windowOffset.x}px, ${windowOffset.y}px, 0)` }}>
        <div className="modal__header vacuum-dashboard__drag-handle" onPointerDown={startDragging} onPointerMove={moveDragging} onPointerUp={stopDragging} onPointerCancel={stopDragging}>
          <div>
            <div id="vacuum-title" className="modal__title">{t("vacuum.title")}</div>
            {status && (
              <div className="vacuum-dashboard__device">
                {status.device_id} · {status.voltage.toFixed(1)} V · {status.simulation ? t("vacuum.simulation") : t("vacuum.hardware")} · {status.control_transport === "raspberry-pi-gpio" ? "Raspberry Pi GPIO" : t("vacuum.gpioSimulation")} · {formatRuntime(status.runtime_seconds)}
              </div>
            )}
          </div>
          <div className="vacuum-dashboard__window-actions">
            <button type="button" className="modal__close vacuum-dashboard__minimize" onClick={() => onMinimizedChange(true)} aria-label={t("vacuum.minimize")} title={t("vacuum.minimize")}>
              <span aria-hidden>−</span>
            </button>
          </div>
        </div>

        {!minimized && <><div className="modal__body vacuum-dashboard__body">
          {error && <div className="vacuum-dashboard__error" role="alert">{error}</div>}
          {!status ? (
            <div className="vacuum-dashboard__loading">
              {pending === "acquire" ? t("vacuum.acquiring") : t("vacuum.loading")}
            </div>
          ) : (
            mechanicalPump && turboPump && uhPumps.length > 0 && otherPumps.length === 0 ? (
              <div className="vacuum-workflow">
                <div className="vacuum-workflow__stage">{renderPumpCard(mechanicalPump)}</div>
                <WorkflowArrow state={mechanicalPump.border} />
                <div className="vacuum-workflow__stage">{renderPumpCard(turboPump)}</div>
                <WorkflowArrow state={turboPump.border} grouped />
                <div className="vacuum-workflow__group" data-state={groupState(uhPumps)}>
                  <div className="vacuum-workflow__group-title">{t("vacuum.uhGroup")}</div>
                  {uhPumps.map(renderPumpCard)}
                </div>
              </div>
            ) : (
              <div className="vacuum-dashboard__grid">{status.pumps.map(renderPumpCard)}</div>
            )
          )}
        </div>

        <div className="vacuum-dashboard__footer">
          <span>{status?.cascade_stopped ? t("vacuum.cascadeStopped") : t("vacuum.cascadeRunning")}</span>
        </div></>}
      </section>}
    </div>
  );
}

function WorkflowArrow({ state, grouped = false }: { state: VacuumPumpState["border"]; grouped?: boolean }) {
  return (
    <div className="vacuum-workflow__connector" data-state={state} data-grouped={grouped ? "true" : "false"} aria-hidden>
      <span className="vacuum-workflow__line" />
      <span className="vacuum-workflow__arrowhead" />
    </div>
  );
}

function groupState(pumps: VacuumPumpState[]): VacuumPumpState["border"] {
  if (pumps.some((pump) => pump.border === "error")) return "error";
  if (pumps.length > 0 && pumps.every((pump) => pump.border === "ready")) return "ready";
  if (pumps.some((pump) => pump.border === "waiting")) return "waiting";
  return "off";
}

function formatVacuumValue(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value === 0 ? "0" : value.toExponential(2);
}

function formatRuntime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`;
}
