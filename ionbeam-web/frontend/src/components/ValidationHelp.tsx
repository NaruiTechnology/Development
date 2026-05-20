/**
 * Help popover for the "validation" parameter. Thin shell: title and
 * aria come from t(), body comes from useHelpBody() which dispatches
 * to the active locale's content registry under src/i18n/help/.
 *
 * Adding a new help topic:
 *   1) add the HelpKey union entry in i18n/help/en.tsx
 *   2) add bodies in en.tsx / zh-CN.tsx / zh-TW.tsx
 *   3) add the title and aria keys to i18n/locales/en.ts and the others
 *   4) create a tiny shell like this one
 */
import { HelpPopover } from "./HelpPopover";
import { useTranslation } from "../i18n";
import { useHelpBody } from "../i18n/help";

export function ValidationHelp() {
  const { t } = useTranslation();
  return (
    <HelpPopover title={t("help.validation.title")} ariaLabel={t("help.validation.aria")}>
      {useHelpBody("validation")}
    </HelpPopover>
  );
}
