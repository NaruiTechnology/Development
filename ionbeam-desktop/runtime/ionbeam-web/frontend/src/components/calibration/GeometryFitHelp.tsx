/**
 * Help popover for the "Fit" button (Scan geometry, section 4). Same thin-shell pattern as
 * ScanGeometryHelp / MagCalibrationHelp — title and aria come from t(), body comes from
 * useHelpBody() (src/i18n/help/).
 */
import { HelpPopover } from "../HelpPopover";
import { useTranslation } from "../../i18n";
import { useHelpBody } from "../../i18n/help";

export function GeometryFitHelp() {
  const { t } = useTranslation();
  return (
    <HelpPopover title={t("help.geometryFit.title")} ariaLabel={t("help.geometryFit.aria")} openOnHover>
      {useHelpBody("geometryFit")}
    </HelpPopover>
  );
}
