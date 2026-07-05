/**
 * Help popover for the vector gray level filter toggle. The body is
 * intentionally specific to the vector fallback path, not the ROI
 * gray-scale spectrum help.
 */
import { HelpPopover } from "./HelpPopover";
import { useTranslation } from "../i18n";
import { useHelpBody } from "../i18n/help";

export function VectorGrayLevelHelp() {
  const { t } = useTranslation();
  return (
    <HelpPopover
      title={t("help.vectorGrayLevelFilter.title")}
      ariaLabel={t("help.vectorGrayLevelFilter.aria")}
      iconName="alertTriangle"
    >
      {useHelpBody("vectorGrayLevelFilter")}
    </HelpPopover>
  );
}
