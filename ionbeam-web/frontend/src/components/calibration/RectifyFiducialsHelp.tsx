/**
 * Help popover for "4 · Rectify with fiducials" (Scan geometry). Same thin-shell pattern as
 * GeometryFitHelp / ScanGeometryHelp — title and aria come from t(), body comes from
 * useHelpBody() (src/i18n/help/).
 */
import { HelpPopover } from "../HelpPopover";
import { useTranslation } from "../../i18n";
import { useHelpBody } from "../../i18n/help";

export function RectifyFiducialsHelp() {
  const { t } = useTranslation();
  return (
    <HelpPopover title={t("help.rectifyFiducials.title")} ariaLabel={t("help.rectifyFiducials.aria")} openOnHover>
      {useHelpBody("rectifyFiducials")}
    </HelpPopover>
  );
}
