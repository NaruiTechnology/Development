import { HelpPopover } from "./HelpPopover";
import { useTranslation } from "../i18n";
import { useHelpBody } from "../i18n/help";

export function AdcValidHelp() {
  const { t } = useTranslation();
  return <HelpPopover title={t("help.adcValid.title")} ariaLabel={t("help.adcValid.aria")}>{useHelpBody("adcValid")}</HelpPopover>;
}
