/**
 * Raster scan parameter form. Fields map 1:1 to RasterRequest in
 * glasgow_service.models. The "Resolution" and "Dwell Time" presets mirror
 * the dropdowns in the existing PyQt scan_parameters.py.
 *
 * Bounds match the Pydantic field validators:
 *   resolution    1..2048
 *   dwell         1..65535
 *   latency_bytes >= 2
 */
import { updateRaster } from "../store/scanSlice";
import { useAppDispatch, useAppSelector } from "../store";

const RES_PRESETS = [256, 512, 1024, 2048];
const DWELL_PRESETS = [1, 2, 4, 8, 16];
const LATENCY_PRESETS = [4096, 8192, 16384, 32768];

export function RasterParameters({ disabled }: { disabled: boolean }) {
  const dispatch = useAppDispatch();
  const r = useAppSelector((s) => s.scan.raster);

  return (
    <div>
      <div className="field-row">
        <PresetField
          label="Resolution"
          value={r.resolution}
          presets={RES_PRESETS}
          disabled={disabled}
          onChange={(v) => dispatch(updateRaster({ resolution: v }))}
        />
        <PresetField
          label="Dwell"
          value={r.dwell}
          presets={DWELL_PRESETS}
          disabled={disabled}
          onChange={(v) => dispatch(updateRaster({ dwell: v }))}
        />
      </div>

      <div className="field-row">
        <PresetField
          label="Latency (bytes)"
          value={r.latency_bytes}
          presets={LATENCY_PRESETS}
          disabled={disabled}
          onChange={(v) => dispatch(updateRaster({ latency_bytes: v }))}
        />
        <div className="field">
          <label>Cookie</label>
          <input
            className="input"
            type="number"
            min={0}
            max={0xffff}
            value={r.cookie}
            disabled={disabled}
            onChange={(e) =>
              dispatch(updateRaster({ cookie: clamp(e.target.value, 0, 0xffff, 123) }))
            }
          />
        </div>
      </div>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={r.frame_blank}
          disabled={disabled}
          onChange={(e) => dispatch(updateRaster({ frame_blank: e.target.checked }))}
        />
        Frame blank (start and end blanked)
      </label>

      <div className="divider" />

      <div className="card__title" style={{ marginBottom: 6 }}>
        Validated run options
      </div>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={r.do_validate}
          disabled={disabled}
          onChange={(e) => dispatch(updateRaster({ do_validate: e.target.checked }))}
        />
        Run chunk-count / size / padding checks
      </label>

      <p className="muted" style={{ fontSize: 11, marginTop: 6, marginBottom: 0 }}>
        Validation applies to <b>Run validated</b>. After any scan
        completes, use the <b>Download CSV</b> / <b>Download figure</b>
        buttons in the Run report to export the data.
      </p>
    </div>
  );
}

function PresetField(props: {
  label: string;
  value: number;
  presets: number[];
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  const { label, value, presets, disabled, onChange } = props;
  return (
    <div className="field">
      <label>{label}</label>
      <select
        className="select"
        value={String(value)}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {presets.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
    </div>
  );
}

function clamp(s: string, lo: number, hi: number, fallback: number): number {
  const n = Number(s);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}
