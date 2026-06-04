/**
 * Help popover for the canvas view toggle. Thin shell: title and
 * aria come from t(), body comes from useHelpBody() which dispatches
 * to the active locale's content registry under src/i18n/help/.
 */
import { HelpPopover } from "./HelpPopover";
import { useTranslation } from "../i18n";
import { useHelpBody } from "../i18n/help";

export function CanvasViewHelp() {
  const { t } = useTranslation();
  return (
    <HelpPopover title={t("help.canvasView.title")} ariaLabel={t("help.canvasView.aria")}>
      {useHelpBody("canvasView")}
    </HelpPopover>
  );
}
