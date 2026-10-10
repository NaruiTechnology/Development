/**
 * Help popover for the "DAC check" card. Thin shell, same pattern as
 * DwellHelp.tsx etc. — see that file's header comment for the 4-step
 * recipe to add a new help topic.
 */
import { HelpPopover } from "./HelpPopover";
import { useTranslation } from "../i18n";
import { useHelpBody } from "../i18n/help";

export function DacCheckHelp() {
  const { t } = useTranslation();
  return (
    <HelpPopover title={t("help.dacCheck.title")} ariaLabel={t("help.dacCheck.aria")}>
      {useHelpBody("dacCheck")}
    </HelpPopover>
  );
}
