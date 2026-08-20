/**
 * Help popover for the gray-scale spectrum selector.
 *
 * Title and aria come from t(), body comes from useHelpBody() which
 * dispatches to the active locale's content registry under
 * src/i18n/help/.
 */
import { HelpPopover } from "./HelpPopover";
import { useTranslation } from "../i18n";
import { useHelpBody } from "../i18n/help";

export function GrayScaleHelp() {
  const { t } = useTranslation();
  return (
    <HelpPopover title={t("help.grayScale.title")} ariaLabel={t("help.grayScale.aria")}>
      {useHelpBody("grayScale")}
    </HelpPopover>
  );
}
