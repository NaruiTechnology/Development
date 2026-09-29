/**
 * Help popover for the Scan geometry panel. Thin shell, same pattern as
 * MagCalibrationHelp / CanvasViewHelp — title and aria come from t(), body
 * comes from useHelpBody() (src/i18n/help/). Opens on hover as well as
 * click/keyboard (openOnHover — see HelpPopover), since this panel packs a
 * lot of terminology (HFOV, fiducials, fold-scale) an operator may want a
 * quick reminder of without leaving the page.
 */
import { HelpPopover } from "../HelpPopover";
import { useTranslation } from "../../i18n";
import { useHelpBody } from "../../i18n/help";

export function ScanGeometryHelp() {
  const { t } = useTranslation();
  return (
    <HelpPopover title={t("help.scanGeometry.title")} ariaLabel={t("help.scanGeometry.aria")} openOnHover>
      {useHelpBody("scanGeometry")}
    </HelpPopover>
  );
}
