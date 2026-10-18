/** Workflow help for the ROI / SELECT tab. */
import { HelpPopover } from "./HelpPopover";
import { useTranslation } from "../i18n";
import { useHelpBody } from "../i18n/help";

export function ROISelectHelp() {
  const { t } = useTranslation();
  return (
    <HelpPopover title={t("help.roiSelect.title")} ariaLabel={t("help.roiSelect.aria")}>
      {useHelpBody("roiSelect")}
    </HelpPopover>
  );
}
