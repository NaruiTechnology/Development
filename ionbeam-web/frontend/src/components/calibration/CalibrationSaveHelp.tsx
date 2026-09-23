/** "?" next to History in Admin > Calibration: shows the annotated walkthrough of editing and saving values. */
import { useTranslation } from "../../i18n";
import saveHelpImage from "../../assets/CalibrationSaveHelp.png";
import { HelpPopover } from "../HelpPopover";

export function CalibrationSaveHelp() {
  const { t } = useTranslation();
  return (
    <HelpPopover title={t("help.calibrationSave.title")} ariaLabel={t("help.calibrationSave.aria")} openOnHover dismissOnPointer size="wide">
      <figure className="calib-save-help">
        <img src={saveHelpImage} width={1718} height={982} alt={t("help.calibrationSave.alt")} />
        <figcaption>{t("help.calibrationSave.caption")}</figcaption>
      </figure>
    </HelpPopover>
  );
}
