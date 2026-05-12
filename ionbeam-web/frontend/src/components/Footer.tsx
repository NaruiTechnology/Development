import { useTranslation } from "../i18n";

export function Footer() {
  const { t } = useTranslation();
  return (
    <footer className="app-footer">
      <span>
        {t("app.footer.copyright")} ·{" "}
        <a
          href="http://www.ionbeamtech.com/"
          target="_blank"
          rel="noreferrer"
          style={{ color: "inherit" }}
        >
          ionbeamtech.com
        </a>
      </span>
      <span className="muted">{t("app.footer.build")}</span>
    </footer>
  );
}
