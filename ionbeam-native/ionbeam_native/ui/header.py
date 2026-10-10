"""Header, footer and sign-in dialog (Header.tsx, LanguagePicker.tsx, Footer.tsx, AuthDialog.tsx).

The CONFIGURATION cog is intentionally absent: the desktop app does not
include the Settings dialog (configuration stays in the web UI).
"""
from __future__ import annotations

from typing import Optional

from PyQt6.QtCore import QSize, Qt, pyqtSignal
from PyQt6.QtGui import QPixmap
from PyQt6.QtWidgets import (
    QComboBox, QDialog, QFrame, QGridLayout, QHBoxLayout, QLabel, QLineEdit, QMenu, QPushButton, QToolButton,
    QVBoxLayout,
    QWidget,
)

from .. import i18n
from ..core.helpers import DEFAULT_SITE, SITE_OPTIONS, normalize_site_value, should_show_vacuum_controller
from ..i18n import t
from ..paths import resource
from . import theme
from .common import button, icon, label, run_bg, set_prop
from .panel import Panel

STATE_KEYS = {"idle": "header.state.idle", "busy": "header.state.busy", "connecting": "header.state.connecting",
              "error": "header.state.error", "disconnected": "header.state.disconnected"}


def _img_button(image: str, size: int = 26) -> QToolButton:
    b = QToolButton()
    pm = QPixmap(str(resource("images", image)))
    b.setIcon(__import__("PyQt6.QtGui", fromlist=["QIcon"]).QIcon(pm))
    b.setIconSize(QSize(size, size))
    b.setAutoRaise(True)
    b.setCursor(Qt.CursorShape.PointingHandCursor)
    return b


class Header(Panel):
    TOPICS = frozenset({"status", "defaults", "scan", "auth", "vacuum", "adc", "panel", "theme", "view",
                        "dashboards"})
    open_report = pyqtSignal()
    open_scan = pyqtSignal()
    open_vacuum = pyqtSignal()
    open_stage = pyqtSignal()
    open_auth = pyqtSignal()

    def __init__(self, ctl, parent=None):
        super().__init__(ctl, parent)
        self.active_view = "control"
        self.vacuum_minimized = True
        self.vacuum_busy = False
        self.stage_minimized = True
        self.stage_busy = False
        frame = QFrame()
        frame.setObjectName("Header")
        outer = QHBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.addWidget(frame)
        lay = QHBoxLayout(frame)
        lay.setContentsMargins(14, 8, 14, 8)
        lay.setSpacing(10)
        logo = QLabel()
        logo.setPixmap(QPixmap(str(resource("images", "brand-logo.png"))).scaled(
            34, 34, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation))
        lay.addWidget(logo)
        title = QVBoxLayout()
        title.setSpacing(0)
        row = QHBoxLayout()
        self.brand = label("", "brand")
        self.version = QLabel()
        self.version.setObjectName("Pill")
        row.addWidget(self.brand)
        row.addWidget(self.version)
        row.addStretch(1)
        title.addLayout(row)
        self.tagline = label("", "dim")
        title.addWidget(self.tagline)
        lay.addLayout(title)
        lay.addStretch(1)
        self.lang_lbl = label("", "title")
        self.lang = QComboBox()
        for code in i18n.ALL_LOCALES:
            self.lang.addItem(i18n.LOCALE_NAMES[code], code)
        self.lang.activated.connect(lambda i: ctl.set_locale(self.lang.itemData(i)))
        lay.addWidget(self.lang_lbl)
        lay.addWidget(self.lang)
        self.beam = QLabel()
        self.beam.setObjectName("Pill")
        lay.addWidget(self.beam)
        self.status = QLabel()
        self.status.setObjectName("Pill")
        lay.addWidget(self.status)
        self.theme_lbl = label("", "title")
        self.theme_sel = QComboBox()
        self.theme_sel.activated.connect(lambda i: ctl.set_theme(self.theme_sel.itemData(i)))
        lay.addWidget(self.theme_lbl)
        lay.addWidget(self.theme_sel)
        self.view_btn = button("", "ghost")
        self.view_btn.clicked.connect(self._toggle_view)
        lay.addWidget(self.view_btn)
        self.reconnect = QToolButton()
        self.reconnect.setAutoRaise(True)
        self.reconnect.clicked.connect(ctl.reconnect_device)
        # native-only: the desktop app keeps the Glasgow open between scans, so
        # the operator needs a way to hand the device back to the web stack.
        self.device_menu = QMenu(self.reconnect)
        self.act_reconnect = self.device_menu.addAction("")
        self.act_reconnect.triggered.connect(ctl.reconnect_device)
        self.act_release = self.device_menu.addAction("")
        self.act_release.triggered.connect(ctl.release_device)
        self.reconnect.setMenu(self.device_menu)
        self.reconnect.setPopupMode(QToolButton.ToolButtonPopupMode.MenuButtonPopup)
        lay.addWidget(self.reconnect)
        self.vacuum_btn = _img_button("UHVacuumPump_1.png")
        self.vacuum_btn.clicked.connect(self.open_vacuum.emit)
        lay.addWidget(self.vacuum_btn)
        self.stage_btn = _img_button("SampleStage.png")
        self.stage_btn.clicked.connect(self.open_stage.emit)
        lay.addWidget(self.stage_btn)
        self.hv_btn = _img_button("HighVoltageTransformer.png")
        self.hv_btn.setCheckable(True)
        self.hv_btn.clicked.connect(lambda: ctl.toggle_high_voltage())
        lay.addWidget(self.hv_btn)
        self.auth = QPushButton()
        self.auth.setProperty("kind", "ghost")
        self.auth.clicked.connect(self.open_auth.emit)
        lay.addWidget(self.auth)
        self.led = QLabel()
        self.led.setFixedSize(12, 12)
        lay.addWidget(self.led)
        self.retranslate()
        self.refresh()

    def _toggle_view(self):
        if self.active_view == "report":
            self.open_scan.emit()
        else:
            self.open_report.emit()

    def retranslate(self):
        self.brand.setText(t("app.brand.name"))
        self.tagline.setText(t("app.brand.tagline"))
        self.lang_lbl.setText(t("header.language.label"))
        self.lang.setToolTip(t("header.language.title"))
        self.theme_lbl.setText(t("header.theme.label"))
        self.theme_sel.clear()
        for name in theme.THEMES:
            self.theme_sel.addItem(t(f"header.theme.{name}"), name)
            self.theme_sel.setItemData(self.theme_sel.count() - 1, t(f"header.theme.{name}.title"),
                                       Qt.ItemDataRole.ToolTipRole)
        self.reconnect.setToolTip(t("header.reconnect.title"))
        self.act_reconnect.setText(t("native.reconnect"))
        self.act_release.setText(t("native.releaseDevice"))

    def refresh(self):
        ctl = self.ctl
        tk = theme.current()
        v = ctl.version
        self.version.setText(f"v{v}")
        self.version.setVisible(bool(v))
        self.lang.setCurrentIndex(max(0, self.lang.findData(i18n.locale())))
        self.lang.setToolTip(i18n.LOCALE_NAMES[i18n.locale()])
        self.theme_sel.setCurrentIndex(max(0, self.theme_sel.findData(theme.current_name())))
        self.theme_sel.setToolTip(t(f"header.theme.{theme.current_name()}.title"))
        # beam pill
        beam = ctl.selected_beam
        if beam in ("ebeam", "ion"):
            active = ctl.scan.phase == "running"
            state = t("header.beam.on" if active else "header.beam.off")
            color = "lawngreen" if beam == "ebeam" else tk.danger
            self.beam.setText(f"⚛ {t('header.beam.' + beam)}  {state}")
            self.beam.setToolTip(f"{t('header.beam.' + beam + '.title')} - {state}")
            self.beam.setStyleSheet(f"color: {color if active else tk.text_muted};"
                                    + ("" if active else "border-color: " + tk.border + ";"))
            self.beam.show()
        else:
            self.beam.hide()
        # status pill
        state = (ctl.service_status or {}).get("state", "disconnected")
        key = "header.state.adcConnecting" if ctl.adc_active else STATE_KEYS.get(state)
        self.status.setText("● " + (t(key) if key else state))
        set_prop(self.status, "tone", {"idle": "dim", "busy": "busy", "connecting": "accent", "error": "error"}
                 .get(state, "dim") if not ctl.adc_active else "accent")
        session = (ctl.service_status or {}).get("session") or {}
        tip = [f"state: {state}"]
        if session:
            tip.append(f"session connects: {session.get('connects')} · soft resets: {session.get('soft_resets')} "
                       f"· mean reset: {session.get('mean_reset_ms')} ms")
        if (ctl.service_status or {}).get("last_error"):
            tip.append(str(ctl.service_status["last_error"]))
        self.status.setToolTip("\n".join(tip))
        locked = ctl.scan_active or ctl.adc_active
        header_disabled = locked or not ctl.signed_in
        report = self.active_view == "report"
        self.view_btn.setText(t("header.desktop.label") if report else t("header.dashboard.label"))
        self.view_btn.setIcon(icon("scan" if report else "layers", tk.accent))
        self.view_btn.setToolTip(t("header.scan.title") if report else t("header.dashboard.title"))
        self.reconnect.setIcon(icon("link", tk.accent))
        self.reconnect.setEnabled(not ctl.reconnecting and not header_disabled)
        self.act_release.setEnabled(not ctl.scan_active and not ctl.adc_active and ctl.session_open)
        show_vac = should_show_vacuum_controller(ctl.vacuum_enabled)
        self.vacuum_btn.setVisible(show_vac)
        self.vacuum_btn.setEnabled(not header_disabled)
        self.vacuum_btn.setToolTip(t("vacuum.restore") if self.vacuum_minimized else t("header.vacuum.title"))
        self.vacuum_btn.setStyleSheet(f"QToolButton {{ border: 2px solid {tk.warn}; border-radius: 6px; }}"
                                      if self.vacuum_busy else "")
        self.stage_btn.setEnabled(not header_disabled)
        self.stage_btn.setToolTip(t("sampleStage.restore") if self.stage_minimized else t("header.sampleStage.title"))
        self.stage_btn.setStyleSheet(f"QToolButton {{ border: 2px solid {tk.warn}; border-radius: 6px; }}"
                                     if self.stage_busy else "")
        self.hv_btn.setVisible(show_vac)
        ready = ctl.vacuum_enabled and ctl.vacuum_ready
        self.hv_btn.setChecked(ctl.hv_power)
        self.hv_btn.setEnabled(not header_disabled and ready and not ctl.hv_pending)
        self.hv_btn.setToolTip(ctl.hv_error or t(("header.highVoltage.turnOff" if ctl.hv_power else
                                                  "header.highVoltage.turnOn") if ready else "header.highVoltage.notReady"))
        self.hv_btn.setStyleSheet(f"QToolButton:checked {{ border: 2px solid {tk.success}; border-radius: 6px; }}")
        user = ctl.signed_in_user
        self.auth.setText(f"  {(user or {}).get('initials') or '?'}   {(user or {}).get('login_name') or t('auth.signIn')}")
        self.auth.setToolTip(t("auth.signedIn.title") if user else t("auth.signIn.title"))
        self.auth.setEnabled(not locked)
        prod = ctl.is_production
        color = "lawngreen" if prod else "#f59e0b"
        self.led.setStyleSheet(f"background: {color}; border-radius: 6px; border: 2px solid {color};")
        self.led.setToolTip(t("header.production.true.title") if prod else t("header.production.false.title"))


class Footer(Panel):
    TOPICS = frozenset()

    def __init__(self, ctl, parent=None):
        super().__init__(ctl, parent)
        frame = QFrame()
        frame.setObjectName("Footer")
        outer = QHBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.addWidget(frame)
        lay = QHBoxLayout(frame)
        lay.setContentsMargins(14, 6, 14, 6)
        self.left = QLabel()
        self.left.setTextFormat(Qt.TextFormat.RichText)
        self.left.setOpenExternalLinks(True)
        self.right = label("", "muted")
        lay.addWidget(self.left)
        lay.addStretch(1)
        lay.addWidget(self.right)
        self.retranslate()

    def retranslate(self):
        self.left.setText(f"{t('app.footer.copyright')} · <a href='http://www.ionbeamtech.com/' "
                          f"style='color: inherit'>ionbeamtech.com</a>")
        self.right.setText(t("app.footer.build") + " · native desktop")


# ---------------------------------------------------------------------------- auth dialog

def user_id_value(user: Optional[dict]) -> str:
    if not user:
        return ""
    return f"login:{user.get('login_name')}" if user.get("id") is None else f"id:{user.get('id')}"


def find_user_by_login(users: list, login: str) -> Optional[dict]:
    n = (login or "").strip().lower()
    if not n:
        return None
    return next((u for u in users if str(u.get("login_name", "")).lower() == n or
                 str(u.get("email", "")).lower() == n), None)


def user_option_label(user: dict) -> str:
    name = f"{user.get('first_name', '')} {user.get('last_name', '')}".strip()
    identity = str(user.get("email") or "").strip() or user.get("login_name", "")
    return f"{name} ({identity})" if name else identity


def response_error(r) -> str:
    text = r.text
    if not text:
        return f"HTTP {r.status_code}"
    try:
        data = r.json()
        return str(data.get("error", text)) if isinstance(data, dict) else text
    except ValueError:
        return text


class AuthDialog(QDialog):
    signed_in = pyqtSignal(dict)

    def __init__(self, ctl, parent=None):
        super().__init__(parent)
        self.ctl = ctl
        self.setObjectName("Modal")
        self.setModal(True)
        self.setMinimumWidth(460)
        self.mode = "loading"
        self.users: list = []
        self.os_login = ""
        self.login = (ctl.p.get("ionbeam:lastAdminLogin", "") or "").strip()
        self.selected_id = ""
        self.challenge: Optional[str] = None
        self.masked_phone = ""
        self.dev_code = ""
        self.session_expired = False
        self.site = DEFAULT_SITE
        self.busy = False
        self.error: Optional[str] = None
        lay = QVBoxLayout(self)
        self.title_lbl = label("", "title")
        lay.addWidget(self.title_lbl)
        self.loading = label("", "muted")
        lay.addWidget(self.loading)
        self.form = QWidget()
        fl = QVBoxLayout(self.form)
        fl.setContentsMargins(0, 0, 0, 0)
        self.user_lbl = label()
        self.user_sel = QComboBox()
        self.user_sel.activated.connect(lambda i: self._select_user(self.user_sel.itemData(i)))
        self.site_lbl = label()
        self.site_sel = QComboBox()
        self.site_sel.activated.connect(lambda i: self._set_site(self.site_sel.itemData(i)))
        self.sudo = label("", "muted", wrap=True)
        for w in (self.user_lbl, self.user_sel, self.site_lbl, self.site_sel, self.sudo):
            fl.addWidget(w)
        self.reg_box = QWidget()
        rl = QGridLayout(self.reg_box)
        rl.setContentsMargins(0, 0, 0, 0)
        self.reg_note = label("", "muted", wrap=True)
        rl.addWidget(self.reg_note, 0, 0, 1, 2)
        self.reg = {}
        for i, key in enumerate(("first_name", "last_name", "email", "phone_number", "company_name")):
            lbl = label()
            edit = QLineEdit()
            edit.textEdited.connect(lambda _t: self._render())
            self.reg[key] = (lbl, edit)
            row, col = (1 + i // 2 * 2, i % 2) if i < 2 else (3 + (i - 2) * 2, 0)
            rl.addWidget(lbl, row, col, 1, 1 if i < 2 else 2)
            rl.addWidget(edit, row + 1, col, 1, 1 if i < 2 else 2)
        fl.addWidget(self.reg_box)
        self.expired = label("", "warn", wrap=True)
        fl.addWidget(self.expired)
        self.code_lbl = label()
        self.code = QLineEdit()
        self.code.textEdited.connect(lambda _t: self._render())
        fl.addWidget(self.code_lbl)
        fl.addWidget(self.code)
        self.sms = QLabel()
        self.sms.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self.sms.setWordWrap(True)
        fl.addWidget(self.sms)
        self.err = label("", "danger", wrap=True)
        fl.addWidget(self.err)
        row = QHBoxLayout()
        row.addStretch(1)
        self.register_btn = button("", "ghost", "plus")
        self.register_btn.clicked.connect(self._open_registration)
        self.primary = button("", "primary", "check")
        self.primary.clicked.connect(self._primary)
        self.close_btn = button("", "ghost", "x")
        self.close_btn.clicked.connect(self.reject)
        row.addWidget(self.close_btn)
        row.addWidget(self.register_btn)
        row.addWidget(self.primary)
        fl.addLayout(row)
        lay.addWidget(self.form)
        self._load()

    # ------------------------------------------------------------------ flow
    def _load(self):
        self.mode, self.busy, self.error = "loading", True, None
        self._render()

        def call():
            b = self.ctl.backend
            r1 = b.request("GET", "/api/admin/iobeam/auth/current-account")
            if r1.status_code >= 400:
                raise RuntimeError(response_error(r1))
            cur = b.read_json(r1, "current account")
            r2 = b.request("GET", "/api/admin/iobeam/auth/users")
            if r2.status_code >= 400:
                raise RuntimeError(response_error(r2))
            users = b.read_json(r2, "auth users")
            return cur, users

        def ok(res):
            cur, users_resp = res
            users = [u for u in users_resp.get("users", []) if u.get("is_active")]
            cached = (self.ctl.p.get("ionbeam:lastAdminLogin", "") or "").strip()
            self.os_login = cur.get("login", "")
            preferred = (find_user_by_login(users, cached or cur.get("login", ""))
                         or (find_user_by_login(users, (cur.get("user") or {}).get("login_name", ""))
                             if cur.get("user") else None)
                         or (users[0] if users else None))
            self.users = users
            self.selected_id = user_id_value(preferred)
            if preferred:
                self.login = preferred.get("login_name", "")
                self.site = normalize_site_value(preferred.get("site"))
            elif not cached:
                self.login = cur.get("login", "")
            if (cur.get("user") or {}).get("site") and not preferred:
                self.site = normalize_site_value(cur["user"]["site"])
            self.session_expired = cur.get("session_expired") is True
            self.mode = "sign-in" if cur.get("registered") else "register"
            self.busy = False
            self._render()

        def err(exc):
            self.mode, self.busy, self.error = "sign-in", False, str(exc)
            self._render()
        run_bg(call, on_ok=ok, on_err=err)

    def _selected_user(self) -> Optional[dict]:
        return next((u for u in self.users if user_id_value(u) == self.selected_id), None)

    def _select_user(self, uid: str):
        self.selected_id = uid
        user = self._selected_user()
        if user:
            self.login = user.get("login_name", "")
            self.site = normalize_site_value(user.get("site"))
        self.code.clear()
        self.challenge, self.masked_phone, self.dev_code = None, "", ""
        self._render()

    def _set_site(self, value: str):
        self.site = value
        self._render()

    def _open_registration(self):
        self.mode = "register"
        self.selected_id = ""
        self.login = self.os_login
        self.site = DEFAULT_SITE
        for _, e in self.reg.values():
            e.clear()
        self.code.clear()
        self.challenge, self.masked_phone, self.dev_code, self.error = None, "", "", None
        self._render()

    def _primary(self):
        if self.mode == "register":
            self._register()
        elif not self.challenge:
            self._send_sms(self._selected_user())
        else:
            self._verify()

    def _send_sms(self, user: Optional[dict]):
        sms_login = (user or {}).get("login_name") or self.login
        self.busy, self.error = True, None
        self._render()
        body = {"login": sms_login}
        if (user or {}).get("id") is not None:
            body["user_id"] = user["id"]

        def call():
            r = self.ctl.backend.request("POST", "/api/admin/iobeam/auth/send-sms", json_body=body)
            if r.status_code == 404:
                return "__register__"
            if r.status_code >= 400:
                raise RuntimeError(response_error(r))
            return self.ctl.backend.read_json(r, "send sms")

        def ok(data):
            self.busy = False
            if data == "__register__":
                self.mode = "register"
                self.error = t("auth.registration.required")
                self._render()
                return
            self.challenge = data.get("challenge_id")
            self.masked_phone = data.get("phone_number", "")
            self.dev_code = data.get("dev_code") or ""
            self.code.clear()
            if user:
                self.selected_id = user_id_value(user)
                self.login = user.get("login_name", "")
            self._render()

        def err(exc):
            self.busy, self.error = False, str(exc)
            self._render()
        run_bg(call, on_ok=ok, on_err=err)

    def _register(self):
        body = {k: e.text() for k, (_, e) in self.reg.items()}
        body["site"] = self.site
        self.busy, self.error = True, None
        self._render()

        def call():
            r = self.ctl.backend.request("POST", "/api/admin/iobeam/auth/register", json_body=body)
            if r.status_code >= 400:
                raise RuntimeError(response_error(r))
            return self.ctl.backend.read_json(r, "register")

        def ok(data):
            user = data.get("user") or {}
            self.users = [u for u in self.users if u.get("id") != user.get("id")] + [user]
            self.selected_id = user_id_value(user)
            self.login = user.get("login_name", "")
            self.site = normalize_site_value(user.get("site"))
            self.mode = "sign-in"
            self.busy = False
            self._send_sms(user)

        def err(exc):
            self.busy, self.error = False, str(exc)
            self._render()
        run_bg(call, on_ok=ok, on_err=err)

    def _verify(self):
        if not self.challenge:
            return
        user = self._selected_user()
        body = {"challenge_id": self.challenge, "code": self.code.text(), "site": self.site,
                "login": (user or {}).get("login_name") or self.login}
        if (user or {}).get("id") is not None:
            body["user_id"] = user["id"]
        self.busy, self.error = True, None
        self._render()

        def call():
            r = self.ctl.backend.request("POST", "/api/admin/iobeam/auth/verify-sms", json_body=body)
            if r.status_code >= 400:
                raise RuntimeError(response_error(r))
            return self.ctl.backend.read_json(r, "verify sms")

        def ok(data):
            self.busy = False
            user = data.get("user") or {}
            self.ctl.set_signed_in(user)
            self.signed_in.emit(user)
            self.accept()

        def err(exc):
            self.busy, self.error = False, str(exc)
            self._render()
        run_bg(call, on_ok=ok, on_err=err)

    # ------------------------------------------------------------------ view
    def _can_register(self) -> bool:
        vals = [e.text().strip() for _, e in self.reg.values()]
        return bool(self.os_login.strip() and self.site.strip() and all(vals))

    def _render(self):
        self.setWindowTitle(t("auth.title"))
        self.title_lbl.setText(t("auth.title"))
        loading = self.mode == "loading"
        self.loading.setText(t("auth.checking"))
        self.loading.setVisible(loading)
        self.form.setVisible(not loading)
        signin = self.mode == "sign-in"
        self.user_lbl.setText(t("auth.user"))
        self.user_lbl.setVisible(signin)
        self.user_sel.setVisible(signin)
        self.user_sel.blockSignals(True)
        self.user_sel.clear()
        if not self.users:
            self.user_sel.addItem(t("auth.users.empty"), "")
        for u in self.users:
            self.user_sel.addItem(user_option_label(u), user_id_value(u))
        self.user_sel.setCurrentIndex(max(0, self.user_sel.findData(self.selected_id)))
        self.user_sel.blockSignals(False)
        self.user_sel.setEnabled(not self.busy and not self.challenge and bool(self.users))
        self.site_lbl.setText(t("auth.site"))
        self.site_sel.blockSignals(True)
        self.site_sel.clear()
        for value, key in SITE_OPTIONS:
            self.site_sel.addItem(t(key), value)
        self.site_sel.setCurrentIndex(max(0, self.site_sel.findData(self.site)))
        self.site_sel.blockSignals(False)
        self.site_sel.setEnabled(not self.busy)
        self.sudo.setText(t("auth.sudoWarning"))
        reg = self.mode == "register"
        self.reg_box.setVisible(reg)
        self.reg_note.setText(t("auth.registration.required"))
        for key, (lbl, edit) in self.reg.items():
            lbl.setText(t({"first_name": "auth.registration.firstName", "last_name": "auth.registration.lastName",
                           "email": "auth.registration.email", "phone_number": "auth.registration.phone",
                           "company_name": "auth.registration.company"}[key]))
            edit.setEnabled(not self.busy)
        self.expired.setText(t("auth.sessionExpired"))
        self.expired.setVisible(signin and self.session_expired and not self.challenge)
        self.code_lbl.setText(t("auth.code"))
        self.code_lbl.setVisible(bool(self.challenge))
        self.code.setVisible(bool(self.challenge))
        self.code.setEnabled(not self.busy)
        if self.masked_phone:
            text = t("auth.sms.sent.mock" if self.dev_code else "auth.sms.sent", phone=self.masked_phone)
            self.sms.setText(text + (f"  <code>{self.dev_code}</code>" if self.dev_code else ""))
            self.sms.show()
        else:
            self.sms.hide()
        self.err.setText(self.error or "")
        self.err.setVisible(bool(self.error))
        self.close_btn.setText(t("help.close"))
        self.close_btn.setEnabled(not self.busy)
        if reg:
            self.register_btn.hide()
            self.primary.setText(t("auth.register"))
            self.primary.setIcon(icon("check", "#ffffff"))
            self.primary.setEnabled(not self.busy and self._can_register())
        elif not self.challenge:
            self.register_btn.show()
            self.register_btn.setText(t("auth.register"))
            self.register_btn.setEnabled(not self.busy)
            self.primary.setText(t("auth.sendSms"))
            self.primary.setIcon(icon("link", "#ffffff"))
            self.primary.setEnabled(not self.busy and self._selected_user() is not None and bool(self.login.strip())
                                    and bool(self.site.strip()))
        else:
            self.register_btn.hide()
            self.primary.setText(t("auth.verify"))
            self.primary.setIcon(icon("check", "#ffffff"))
            self.primary.setEnabled(not self.busy and bool(self.code.text().strip()) and bool(self.site.strip()))
