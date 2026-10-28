import { useMemo, useRef, useState } from "react";

import { useAppDispatch, useAppSelector } from "../store";
import {
  addScanRegion,
  removeScanRegion,
  setActiveScanRegion,
  updateScanRegion,
} from "../store/scanSlice";
import type { ROIRequest } from "../types/api";
import { useTranslation } from "../i18n";

type Point = { x: number; y: number };
type Interaction =
  | { kind: "create"; start: Point }
  | { kind: "move"; index: number; start: Point; original: ROIRequest };

export function ScanRegionOverlay({ disabled }: { disabled: boolean }) {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const roi = useAppSelector((state) => state.scan.roi);
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const [draft, setDraft] = useState<ROIRequest | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const regions = roi.scan_regions;
  const active = roi.active_scan_region;
  const xMin = Math.min(roi.x_origin, roi.x_end);
  const xMax = Math.max(roi.x_origin, roi.x_end);
  const yMin = Math.min(roi.y_origin, roi.y_end);
  const yMax = Math.max(roi.y_origin, roi.y_end);

  const displayed = useMemo(
    () => regions.map((region, index) =>
      interaction?.kind === "move" && interaction.index === index && draft ? draft : region,
    ),
    [draft, interaction, regions],
  );

  function pointFromEvent(event: React.PointerEvent | React.MouseEvent): Point {
    const rect = layerRef.current!.getBoundingClientRect();
    return {
      x: xMin + Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * (xMax - xMin),
      y: yMin + Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) * (yMax - yMin),
    };
  }

  function regionAt(point: Point): number | null {
    for (let index = displayed.length - 1; index >= 0; index -= 1) {
      const region = displayed[index];
      if (
        point.x >= Math.min(region.x_start, region.x_end) &&
        point.x <= Math.max(region.x_start, region.x_end) &&
        point.y >= Math.min(region.y_start, region.y_end) &&
        point.y <= Math.max(region.y_start, region.y_end)
      ) return index;
    }
    return null;
  }

  function rectFromPoints(a: Point, b: Point): ROIRequest {
    return {
      x_start: Math.min(a.x, b.x),
      x_end: Math.max(a.x, b.x),
      y_start: Math.min(a.y, b.y),
      y_end: Math.max(a.y, b.y),
    };
  }

  function movedRegion(original: ROIRequest, start: Point, current: Point): ROIRequest {
    const width = original.x_end - original.x_start;
    const height = original.y_end - original.y_start;
    const dx = Math.max(xMin - original.x_start, Math.min(xMax - original.x_end, current.x - start.x));
    const dy = Math.max(yMin - original.y_start, Math.min(yMax - original.y_end, current.y - start.y));
    return {
      x_start: original.x_start + dx,
      x_end: original.x_start + dx + width,
      y_start: original.y_start + dy,
      y_end: original.y_start + dy + height,
    };
  }

  function styleFor(region: ROIRequest) {
    return {
      left: `${((Math.min(region.x_start, region.x_end) - xMin) / Math.max(Number.EPSILON, xMax - xMin)) * 100}%`,
      top: `${((Math.min(region.y_start, region.y_end) - yMin) / Math.max(Number.EPSILON, yMax - yMin)) * 100}%`,
      width: `${(Math.abs(region.x_end - region.x_start) / Math.max(Number.EPSILON, xMax - xMin)) * 100}%`,
      height: `${(Math.abs(region.y_end - region.y_start) / Math.max(Number.EPSILON, yMax - yMin)) * 100}%`,
    };
  }

  return (
    <div
      ref={layerRef}
      className="scan-roi-layer"
      data-editing={!disabled ? "true" : "false"}
      hidden={!roi.roi_scan_enabled}
      onPointerDown={(event) => {
        if (!roi.roi_scan_enabled || disabled || event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
        event.preventDefault();
        setMenu(null);
        const point = pointFromEvent(event);
        const index = regionAt(point);
        if (index === null) {
          setInteraction({ kind: "create", start: point });
          setDraft(rectFromPoints(point, point));
        } else {
          dispatch(setActiveScanRegion(index));
          setInteraction({ kind: "move", index, start: point, original: regions[index] });
          setDraft(regions[index]);
        }
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!interaction) return;
        const point = pointFromEvent(event);
        setDraft(interaction.kind === "create"
          ? rectFromPoints(interaction.start, point)
          : movedRegion(interaction.original, interaction.start, point));
      }}
      onPointerUp={(event) => {
        if (!interaction || !draft) return;
        event.preventDefault();
        const rect = layerRef.current!.getBoundingClientRect();
        const minWorldX = ((xMax - xMin) / Math.max(1, rect.width)) * 6;
        const minWorldY = ((yMax - yMin) / Math.max(1, rect.height)) * 6;
        if (interaction.kind === "move") {
          dispatch(updateScanRegion({ index: interaction.index, region: draft }));
        } else if (Math.abs(draft.x_end - draft.x_start) >= minWorldX && Math.abs(draft.y_end - draft.y_start) >= minWorldY) {
          dispatch(addScanRegion(draft));
        }
        setInteraction(null);
        setDraft(null);
      }}
      onContextMenu={(event) => {
        if (!roi.roi_scan_enabled || disabled) return;
        const index = regionAt(pointFromEvent(event));
        if (index === null) return;
        event.preventDefault();
        dispatch(setActiveScanRegion(index));
        const rect = layerRef.current!.getBoundingClientRect();
        setMenu({ x: event.clientX - rect.left, y: event.clientY - rect.top, index });
      }}
    >
      {displayed.map((region, index) => (
        <div
          key={index}
          className="scan-roi-layer__region"
          data-active={active === index ? "true" : "false"}
          style={styleFor(region)}
        >
          <span>{index + 1}</span>
        </div>
      ))}
      {interaction?.kind === "create" && draft && (
        <div className="scan-roi-layer__region scan-roi-layer__region--draft" style={styleFor(draft)} />
      )}
      {menu && (
        <div className="canvas-editor__menu scan-roi-layer__menu" style={{ left: menu.x, top: menu.y }}>
          <button
            type="button"
            className="canvas-editor__menu-item scan-roi-layer__menu-item"
            onClick={(event) => {
              event.stopPropagation();
              dispatch(removeScanRegion(menu.index));
              setMenu(null);
            }}
          >
            {t("scan.roi.remove")}
          </button>
        </div>
      )}
    </div>
  );
}
