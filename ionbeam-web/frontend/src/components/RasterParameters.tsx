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
          min={1}
          max={2048}
          disabled={disabled}
          onChange={(v) => dispatch(updateRaster({ resolution: v }))}
        />
        <PresetField
          label="Dwell"
          value={r.dwell}
          presets={DWELL_PRESETS}
          min={1}
          max={65535}
          disabled={disabled}
          onChange={(v) => dispatch(updateRaster({ dwell: v }))}
        />
      </div>

      <div className="field-row">
        <PresetField
          label="Latency (bytes)"
          value={r.latency_bytes}
          presets={LATENCY_PRESETS}
          min={2}
          max={1 << 20}
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

      <label className="checkbox">
        <input
          type="checkbox"
          checked={r.save_csv}
          disabled={disabled}
          onChange={(e) => dispatch(updateRaster({ save_csv: e.target.checked }))}
        />
        Save CSV (raster_NxN.csv in ~/Downloads)
      </label>

      <p className="muted" style={{ fontSize: 11, marginTop: 6, marginBottom: 0 }}>
        Validation and CSV apply to <b>Run validated</b>. Live streaming
        ignores them — that path mirrors the WebSocket endpoint behaviour
        in <code>glasgow_service.api</code>.
      </p>
    </div>
  );
}

function PresetField(props: {
  label: string;
  value: number;
  presets: number[];
  min: number;
  max: number;
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  const { label, value, presets, min, max, disabled, onChange } = props;
  const inPresets = presets.includes(value);
  return (
    <div className="field">
      <label>{label}</label>
      <div className="row" style={{ gap: 6 }}>
        <select
          className="select"
          style={{ flex: "0 0 100px" }}
          value={inPresets ? String(value) : "custom"}
          disabled={disabled}
          onChange={(e) => {
            const v = e.target.value;
            if (v !== "custom") onChange(Number(v));
          }}
        >
          {presets.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
          <option value="custom">Custom…</option>
        </select>
        <input
          className="input"
          type="number"
          min={min}
          max={max}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(clamp(e.target.value, min, max, value))}
        />
      </div>
    </div>
  );
}

function clamp(s: string, lo: number, hi: number, fallback: number): number {
  const n = Number(s);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}
