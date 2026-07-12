/**
 * Help popover for the raster / vector scan mode distinction.
 */
import { HelpPopover } from "./HelpPopover";
import { useTranslation } from "../i18n";
import { useHelpBody } from "../i18n/help";

export function ScanModeHelp() {
  const { t } = useTranslation();
  return (
    <HelpPopover title={t("help.scanModes.title")} ariaLabel={t("help.scanModes.aria")}>
      {useHelpBody("scanModes")}
    </HelpPopover>
  );
}
