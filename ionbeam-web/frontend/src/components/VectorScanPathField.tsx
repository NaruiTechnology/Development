import { VECTOR_SCAN_PATHS } from "../lib/vectorScanPath";
import { useAppDispatch, useAppSelector } from "../store";
import { updateVector } from "../store/scanSlice";
import type { VectorScanPath } from "../types/api";
import { useTranslation } from "../i18n";
import { VectorScanPathPreview } from "./VectorScanPathPreview";
import { PatternHelp } from "./PatternHelp";

export function VectorScanPathField({
  disabled,
  id = "vector-scan-path",
}: {
  disabled: boolean;
  id?: string;
}) {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const scanPath = useAppSelector((state) => state.scan.vector.scan_path);

  return (
    <div className="field vector-scan-path-field">
      <label htmlFor={id}><PatternHelp />{t("vector.scanPath")}</label>
      <div className="vector-scan-path-field__content">
        <select
          id={id}
          className="select"
          value={scanPath}
          disabled={disabled}
          onChange={(event) =>
            dispatch(updateVector({ scan_path: event.target.value as VectorScanPath }))
          }
        >
          {VECTOR_SCAN_PATHS.map((path) => (
            <option key={path} value={path}>
              {t(`vector.scanPath.${path}` as const)}
            </option>
          ))}
        </select>
        <VectorScanPathPreview
          path={scanPath}
          label={t("vector.scanPath.preview", {
            path: t(`vector.scanPath.${scanPath}` as const),
          })}
        />
      </div>
    </div>
  );
}
