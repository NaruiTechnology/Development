import { HelpPopover } from "./HelpPopover";
import { useTranslation } from "../i18n";
import { useHelpBody } from "../i18n/help";

export function MagCalibrationHelp() {
  const { t } = useTranslation();
  return (
    <HelpPopover title={t("help.magCalibration.title")} ariaLabel={t("help.magCalibration.aria")}>
      {useHelpBody("magCalibration")}
    </HelpPopover>
  );
}
