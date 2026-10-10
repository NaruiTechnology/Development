"""Management report / dashboard (ManagementReport.tsx), including PDF + CSV export."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from PyQt6.QtCore import QRectF, Qt
from PyQt6.QtGui import QColor, QFont, QPainter
from PyQt6.QtWidgets import (
    QComboBox, QFileDialog, QGridLayout, QHBoxLayout, QHeaderView, QLabel, QPushButton, QScrollArea, QSizePolicy,
    QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget,
)

from ..core.helpers import site_label_key
from ..core.jsmath import js_round
from .. import i18n
from ..i18n import fmt, t
from . import theme
from .common import Card, button, icon, label, run_bg, set_prop
from .panel import Panel

PALETTES = {
    "account": ("#38bdf8", "#facc15", "#fde047"),
    "site": ("#22c55e", "#f59e0b", "#14b8a6"),
    "daily": ("#60a5fa", "#34d399", "#fbbf24"),
    "weekly": ("#fb7185", "#38bdf8", "#fde047"),
    "monthly": ("#f97316", "#06b6d4", "#84cc16"),
    "yearly": ("#facc15", "#2dd4bf", "#facc15"),
    "equipment": ("#70ec76", "hsl(222, 70%, 48%)", "#facc15"),
}
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def _color(c: str) -> QColor:
    if c.startswith("hsl"):
        h, s, l_ = [float(x.strip().rstrip("%")) for x in c[4:-1].split(",")]
        q = QColor()
        q.setHslF(h / 360, s / 100, l_ / 100)
        return q
    return QColor(c)


def parse_date(value) -> Optional[datetime]:
    if not value:
        return None
    try:
        text = str(value).replace("Z", "+00:00")
        d = datetime.fromisoformat(text)
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def date_ms(value) -> float:
    d = parse_date(value)
    return d.timestamp() * 1000 if d else 0


def format_date_time(locale: str, value: str) -> str:
    """``toLocaleString(locale, {month: short, day: numeric, hour: 2-digit, minute: 2-digit})``."""
    d = parse_date(value)
    if d is None:
        return str(value)
    d = d.astimezone()
    if locale == "en":
        h12 = d.hour % 12 or 12
        return f"{MONTHS[d.month - 1]} {d.day}, {h12:02d}:{d.minute:02d} {'AM' if d.hour < 12 else 'PM'}"
    if locale == "zh-TW":
        ampm = "上午" if d.hour < 12 else "下午"
        return f"{d.month}月{d.day}日 {ampm}{(d.hour % 12 or 12):02d}:{d.minute:02d}"
    return f"{d.month}月{d.day}日 {d.hour:02d}:{d.minute:02d}"


def site_label(value) -> str:
    key = site_label_key(value)
    return t(key) if key else (value or "")


def percent(value: float, total: float) -> float:
    if total <= 0:
        return 0.0
    return max(0.0, min(100.0, value / total * 100))


def normalize_report(data: dict) -> dict:
    out = dict(data)
    for k in ("accounts", "totals", "daily", "weekly", "monthly", "yearly", "recent", "equipment_groups"):
        out[k] = data.get(k) if isinstance(data.get(k), list) else []
    if isinstance(data.get("site_groups"), list):
        out["site_groups"] = data["site_groups"]
    elif isinstance(data.get("geography"), list):
        out["site_groups"] = [{**r, "site": r.get("site") or r.get("location") or ""} for r in data["geography"]]
    else:
        out["site_groups"] = []
    return out


def equipment_label(e: Optional[dict]) -> str:
    if not e:
        return ""
    details = " · ".join(x for x in (e.get("model"), e.get("serial_number")) if x)
    return f"{e.get('name')} ({details})" if details else str(e.get("name") or "")


def period_label(row: dict) -> str:
    for k in ("bucket", "week_start", "month_start", "year_start"):
        if row.get(k) is not None:
            return str(row[k])
    return ""


def _metrics(r):
    return {k: r.get(k, 0) or 0 for k in ("total_scans", "raster_scans", "vector_scans", "other_activity")}


def aggregate_ranking(totals, equipment_rows, group, site_by_id) -> list:
    if group == "account":
        return [{"id": str(r["user_id"]), "label": r.get("name") or r.get("login_name"), **_metrics(r),
                 "last_activity": r.get("last_activity")} for r in totals]
    if group == "equipment":
        return [{"id": str(r.get("equipment_id") if r.get("equipment_id") is not None else r.get("equipment_name")),
                 "label": r.get("equipment_name") or t("report.equipment.unknown"), **_metrics(r),
                 "last_activity": r.get("last_activity")} for r in equipment_rows]
    grouped: dict = {}
    for r in totals:
        site = site_by_id.get(r.get("user_id"), "")
        gid = site or "unknown"
        g = grouped.setdefault(gid, {"id": gid, "label": site_label(site) or t("report.site.unknown"),
                                     "total_scans": 0, "raster_scans": 0, "vector_scans": 0, "other_activity": 0,
                                     "last_activity": None})
        for k, v in _metrics(r).items():
            g[k] += v
        a, b = g["last_activity"], r.get("last_activity")
        g["last_activity"] = b if not a else (a if not b else (b if date_ms(b) > date_ms(a) else a))
    rows = list(grouped.values())
    rows.sort(key=lambda x: (-x["total_scans"], x["label"]))
    return rows


def sort_ranking(rows, mode) -> list:
    rows = list(rows)
    key = {
        "name": lambda r: (r["label"],),
        "raster": lambda r: (-r["raster_scans"], r["label"]),
        "vector": lambda r: (-r["vector_scans"], r["label"]),
        "recent": lambda r: (-date_ms(r.get("last_activity")), r["label"]),
    }.get(mode, lambda r: (-r["total_scans"], r["label"]))
    rows.sort(key=key)
    return rows


def aggregate_period(rows, group, site_by_id, name_by_id) -> list:
    grouped: dict = {}
    for r in rows:
        period = period_label(r)
        if group == "account":
            gid, glabel = f"account-{r.get('user_id')}", name_by_id.get(r.get("user_id")) or r.get("login_name") \
                or t("report.account.selected")
        elif group == "equipment":
            name = r.get("equipment_name") or t("report.equipment.unknown")
            gid, glabel = f"equipment-{r.get('equipment_id') if r.get('equipment_id') is not None else name}", name
        else:
            site = site_by_id.get(r.get("user_id"), "")
            gid, glabel = f"site-{site or 'unknown'}", site_label(site) or t("report.site.unknown")
        rid = f"{period}-{gid}"
        g = grouped.setdefault(rid, {**r, "id": rid, "user_id": 0, "login_name": "", "total_scans": 0,
                                     "raster_scans": 0, "vector_scans": 0, "other_activity": 0,
                                     "label": f"{period} · {glabel}"})
        for k, v in _metrics(r).items():
            g[k] += v
    out = list(grouped.values())
    out.sort(key=lambda x: (period_label(x), x["label"]))
    return out


def escape_csv(value: str) -> str:
    return '"' + value.replace('"', '""') + '"' if any(c in value for c in '"\n,\r') else value


def wrap_line(line: str, width: int) -> list:
    if len(line) <= width:
        return [line]
    out, cur = [], ""
    for word in line.split():
        if not cur:
            cur = word
        elif len(cur + " " + word) <= width:
            cur += " " + word
        else:
            out.append(cur)
            cur = word
    if cur:
        out.append(cur)
    return out or [line]


def create_pdf(pages: list) -> bytes:
    """Byte-compatible port of the web's hand-written PDF writer (Courier, Latin-1 text)."""
    def esc(v: str) -> str:
        return v.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

    font_id, content_start = 1, 2
    page_start = content_start + len(pages)
    pages_id = page_start + len(pages)
    catalog_id = pages_id + 1
    objects = [(font_id, "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>")]
    for i, lines in enumerate(pages):
        all_lines = [f"Report export{f' ({i + 1}/{len(pages)})' if len(pages) > 1 else ''}"] + lines
        text = [esc(x) for x in all_lines]
        content = "\n".join(["BT", "/F1 10 Tf", "14 TL", "50 760 Td"] +
                            [f"({ln}) Tj" if j == 0 else f"T* ({ln}) Tj" for j, ln in enumerate(text)] + ["ET"])
        objects.append((content_start + i,
                        f"<< /Length {len(content.encode('utf-8'))} >>\nstream\n{content}\nendstream"))
    for i in range(len(pages)):
        objects.append((page_start + i, "".join(["<< /Type /Page", f" /Parent {pages_id} 0 R",
                                                 " /MediaBox [0 0 612 792]",
                                                 f" /Resources << /Font << /F1 {font_id} 0 R >> >>",
                                                 f" /Contents {content_start + i} 0 R >>"])))
    objects.append((pages_id, f"<< /Type /Pages /Kids [{' '.join(f'{page_start + i} 0 R' for i in range(len(pages)))}]"
                              f" /Count {len(pages)} >>"))
    objects.append((catalog_id, f"<< /Type /Catalog /Pages {pages_id} 0 R >>"))
    objects.sort()
    header = "%PDF-1.4\n"
    chunks, offsets, length = [header], [], len(header.encode("utf-8"))
    for oid, body in objects:
        chunk = f"{oid} 0 obj\n{body}\nendobj\n"
        offsets.append(length)
        chunks.append(chunk)
        length += len(chunk.encode("utf-8"))
    xref = ["xref", f"0 {len(objects) + 1}", "0000000000 65535 f "] + \
           [f"{o:010d} 00000 n " for o in offsets] + \
           ["trailer", f"<< /Size {len(objects) + 1} /Root {catalog_id} 0 R >>", "startxref", str(length), "%%EOF"]
    return ("".join(chunks) + "\n".join(xref)).encode("utf-8")


class _Pie(QWidget):
    def __init__(self):
        super().__init__()
        self.setFixedSize(180, 180)
        self.values = (0, 0, 0)
        self.total = 0
        self.palette = PALETTES["account"]

    def paintEvent(self, e):  # noqa: N802
        tk = theme.current()
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        rp, vp = percent(self.values[0], self.total), percent(self.values[1], self.total)
        r = QRectF(2, 2, 176, 176)
        start = 90 * 16
        spans = [rp / 100 * 360, vp / 100 * 360, max(0.0, 360 - (rp + vp) / 100 * 360)]
        colors = [_color(c) for c in self.palette]
        angle = start
        for span, col in zip(spans, colors):
            if span <= 0:
                continue
            p.setBrush(col)
            p.setPen(Qt.PenStyle.NoPen)
            p.drawPie(r, angle, -int(span * 16))
            angle -= int(span * 16)
        p.setBrush(QColor(tk.bg_elev))
        p.drawEllipse(r.adjusted(38, 38, -38, -38))
        p.setPen(QColor(tk.text))
        f = QFont()
        f.setPixelSize(22)
        f.setBold(True)
        p.setFont(f)
        p.drawText(QRectF(0, 64, 180, 30), Qt.AlignmentFlag.AlignCenter, fmt(self.total))
        f.setPixelSize(11)
        f.setBold(False)
        p.setFont(f)
        p.setPen(QColor(tk.text_dim))
        p.drawText(QRectF(0, 94, 180, 20), Qt.AlignmentFlag.AlignCenter, t("report.chart.total"))
        p.end()


class _Bar(QWidget):
    """Horizontal stacked bar (usage rows / geo meters / mix bars)."""

    def __init__(self, height: int = 10):
        super().__init__()
        self.setFixedHeight(height)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.parts: list = []

    def set_parts(self, parts: list) -> None:
        self.parts = parts
        self.update()

    def paintEvent(self, e):  # noqa: N802
        tk = theme.current()
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(tk.bg_input))
        p.drawRoundedRect(QRectF(0, 0, self.width(), self.height()), 4, 4)
        x = 0.0
        for pct, color in self.parts:
            w = self.width() * max(0.0, min(100.0, pct)) / 100
            if w > 0:
                p.setBrush(_color(color))
                p.drawRoundedRect(QRectF(x, 0, w, self.height()), 3, 3)
                x += w
        p.end()


class ManagementReport(Panel):
    TOPICS = frozenset({"report"})

    def __init__(self, ctl, on_back, parent=None):
        super().__init__(ctl, parent)
        self.on_back = on_back
        user = ctl.signed_in_user or {}
        uid = user.get("id")
        self.account_id = str(uid) if isinstance(uid, int) and uid > 0 else "all"
        self.equipment_id = "all"
        self.group = "account"
        self.sort = "total"
        self.period = "daily"
        self.equipment_options: list = []
        self.report: Optional[dict] = None
        self.loading = True
        self.error: Optional[str] = None
        self.cleanup_state, self.cleanup_msg = "idle", None
        self._build()
        self.retranslate()
        self._load_equipment()
        self._load()

    # ------------------------------------------------------------------ layout
    def _build(self) -> None:
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        outer.addWidget(scroll)
        body = QWidget()
        scroll.setWidget(body)
        lay = QVBoxLayout(body)
        lay.setContentsMargins(20, 16, 20, 20)
        lay.setSpacing(14)
        hero = QHBoxLayout()
        left = QVBoxLayout()
        self.eyebrow = label("", "dim")
        self.title = label("", "brand")
        self.title.setStyleSheet("font-size: 22px; font-weight: 700;")
        self.subtitle = label("", "dim", wrap=True)
        left.addWidget(self.eyebrow)
        left.addWidget(self.title)
        left.addWidget(self.subtitle)
        src = QHBoxLayout()
        self.source_lbl = label("", "dim")
        self.source_val = label("", "title")
        self.cleanup_btn = button("", "ghost")
        self.cleanup_btn.clicked.connect(self._cleanup)
        src.addWidget(self.source_lbl)
        src.addWidget(self.source_val)
        src.addWidget(self.cleanup_btn)
        src.addStretch(1)
        left.addLayout(src)
        self.cleanup_status = label("", "muted", wrap=True)
        left.addWidget(self.cleanup_status)
        hero.addLayout(left, 1)
        actions = QGridLayout()
        self.acc_lbl, self.acc = label(), QComboBox()
        self.acc.activated.connect(lambda i: self._set("account_id", self.acc.itemData(i), reload=True))
        self.eq_lbl, self.eq = label(), QComboBox()
        self.eq.activated.connect(lambda i: self._set("equipment_id", self.eq.itemData(i), reload=True))
        self.grp_lbl, self.grp = label(), QComboBox()
        self.grp.activated.connect(lambda i: self._set("group", self.grp.itemData(i)))
        self.sort_lbl, self.sort_in = label(), QComboBox()
        self.sort_in.activated.connect(lambda i: self._set("sort", self.sort_in.itemData(i)))
        for col, (lw, w) in enumerate(((self.acc_lbl, self.acc), (self.eq_lbl, self.eq), (self.grp_lbl, self.grp),
                                       (self.sort_lbl, self.sort_in))):
            actions.addWidget(lw, 0, col)
            actions.addWidget(w, 1, col)
        self.pdf_btn = QPushButton()
        self.pdf_btn.setIcon(icon("fileText", size=22))
        self.pdf_btn.clicked.connect(self._export_pdf)
        self.csv_btn = QPushButton()
        self.csv_btn.setIcon(icon("sheet", size=22))
        self.csv_btn.clicked.connect(self._export_csv)
        self.back_btn = button("", "ghost", "scan")
        self.back_btn.clicked.connect(self.on_back)
        actions.addWidget(self.pdf_btn, 1, 4)
        actions.addWidget(self.csv_btn, 1, 5)
        actions.addWidget(self.back_btn, 1, 6)
        hero.addLayout(actions)
        lay.addLayout(hero)
        self.error_lbl = label("", "danger", wrap=True)
        lay.addWidget(self.error_lbl)
        kpis = QHBoxLayout()
        self.kpis = []
        for _ in range(4):
            card = Card()
            v = label("", "brand")
            v.setStyleSheet("font-size: 24px; font-weight: 700;")
            name, detail = label("", "dim"), label("", "muted")
            card.body.addWidget(name)
            card.body.addWidget(v)
            card.body.addWidget(detail)
            self.kpis.append((name, v, detail))
            kpis.addWidget(card)
        lay.addLayout(kpis)
        grid = QGridLayout()
        grid.setSpacing(14)
        # scan mix
        self.mix_card = Card("")
        mix = QHBoxLayout()
        self.pie = _Pie()
        mix.addWidget(self.pie)
        bars = QVBoxLayout()
        self.mix_rows = []
        for _ in range(3):
            row = QVBoxLayout()
            head = QHBoxLayout()
            nl, vl = label(), label("", "title")
            head.addWidget(nl)
            head.addStretch(1)
            head.addWidget(vl)
            bar = _Bar(10)
            pl = label("", "muted")
            row.addLayout(head)
            row.addWidget(bar)
            row.addWidget(pl)
            bars.addLayout(row)
            self.mix_rows.append((nl, vl, bar, pl))
        mix.addLayout(bars, 1)
        self.mix_sub = label("", "muted")
        self.mix_card.body.addWidget(self.mix_sub)
        self.mix_card.body.addLayout(mix)
        grid.addWidget(self.mix_card, 0, 0)
        # usage trend
        self.usage_card = Card("")
        self.usage_sub = label("", "muted")
        self.period_btns = {}
        seg = QHBoxLayout()
        seg.setSpacing(0)
        for m in ("daily", "weekly", "monthly", "yearly"):
            b = QPushButton()
            b.setCheckable(True)
            b.setProperty("kind", "seg")
            b.clicked.connect(lambda _c, mode=m: self._set("period", mode))
            self.period_btns[m] = b
            seg.addWidget(b)
        self.usage_card.header_tools.addLayout(seg)
        self.usage_card.body.addWidget(self.usage_sub)
        self.usage_list = QVBoxLayout()
        self.usage_card.body.addLayout(self.usage_list)
        grid.addWidget(self.usage_card, 0, 1)
        # sites
        self.geo_card = Card("")
        self.geo_sub = label("", "muted")
        self.geo_card.body.addWidget(self.geo_sub)
        self.geo_list = QVBoxLayout()
        self.geo_card.body.addLayout(self.geo_list)
        grid.addWidget(self.geo_card, 1, 0)
        # ranking
        self.rank_card = Card("")
        self.rank_sub = label("", "muted")
        self.rank_card.body.addWidget(self.rank_sub)
        self.rank_table = QTableWidget(0, 4)
        self.rank_table.verticalHeader().hide()
        self.rank_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self.rank_table.setMinimumHeight(220)
        self.rank_card.body.addWidget(self.rank_table)
        grid.addWidget(self.rank_card, 1, 1)
        # recent
        self.recent_card = Card("")
        self.recent_sub = label("", "muted")
        self.recent_card.body.addWidget(self.recent_sub)
        self.recent_list = QVBoxLayout()
        self.recent_card.body.addLayout(self.recent_list)
        grid.addWidget(self.recent_card, 2, 0, 1, 2)
        grid.setColumnStretch(0, 1)
        grid.setColumnStretch(1, 2)
        lay.addLayout(grid)
        lay.addStretch(1)

    # ------------------------------------------------------------------ data
    def _set(self, attr, value, reload=False):
        setattr(self, attr, value)
        if reload:
            self._load()
        else:
            self.refresh()

    def _load_equipment(self):
        def call():
            r = self.ctl.backend.request("GET", "/api/admin/iobeam/equipment")
            data = r.json() if r.content else None
            if r.status_code >= 400 or not isinstance(data, dict) or not data.get("ok"):
                raise RuntimeError((data or {}).get("error") or f"HTTP {r.status_code}")
            return data.get("equipment") if isinstance(data.get("equipment"), list) else []

        def ok(rows):
            self.equipment_options = rows
            self.refresh()
        run_bg(call, on_ok=ok, on_err=lambda e: setattr(self, "equipment_options", []))

    def _load(self):
        params = {"days": "90"}
        if self.account_id != "all":
            params["account_id"] = self.account_id
        if self.equipment_id != "all":
            params["equipment_id"] = self.equipment_id
        self.loading, self.error = True, None
        self.refresh()

        def call():
            r = self.ctl.backend.request("GET", "/api/admin/iobeam/reports/activity", params=params, timeout=30)
            try:
                data = r.json()
            except ValueError:
                data = None
            if r.status_code >= 400 or not isinstance(data, dict) or not data.get("ok"):
                raise RuntimeError((data or {}).get("error") or f"HTTP {r.status_code}")
            if data.get("report_error"):
                raise RuntimeError(data["report_error"])
            return data

        def ok(data):
            self.report = normalize_report(data)
            self.loading = False
            self.refresh()

        def err(exc):
            self.error = str(exc)
            self.loading = False
            self.refresh()
        run_bg(call, on_ok=ok, on_err=err)

    def _cleanup(self):
        if self.cleanup_state == "running":
            return
        self.cleanup_state, self.cleanup_msg = "running", None
        self.refresh()

        def call():
            r = self.ctl.backend.request("POST", "/api/admin/iobeam/activity/dedupe", json_body={})
            try:
                data = r.json()
            except ValueError:
                data = None
            if r.status_code >= 400 or not isinstance(data, dict) or not data.get("ok"):
                raise RuntimeError((data or {}).get("error") or f"HTTP {r.status_code}")
            return data

        def ok(data):
            self.cleanup_state = "done"
            self.cleanup_msg = t("report.cleanup.done", count=data.get("deleted", 0))
            self.refresh()

        def err(exc):
            self.cleanup_state, self.cleanup_msg = "error", str(exc)
            self.refresh()
        run_bg(call, on_ok=ok, on_err=err)

    # ------------------------------------------------------------------ derived
    def _derived(self) -> dict:
        rep = self.report or {}
        totals = rep.get("totals", [])
        s = {k: sum(r.get(k, 0) or 0 for r in totals)
             for k in ("total_scans", "raster_scans", "vector_scans", "other_activity")}
        accounts = rep.get("accounts", [])
        site_by_id = {a["id"]: a.get("site", "") for a in accounts if isinstance(a.get("id"), int)}
        name_by_id = {a["id"]: a.get("name") or a.get("login_name") for a in accounts if isinstance(a.get("id"), int)}
        if not rep or self.account_id == "all":
            selected = t("report.account.all")
        else:
            acc = next((a for a in accounts if str(a.get("id")) == self.account_id), None)
            selected = (acc or {}).get("name") or (acc or {}).get("login_name") or t("report.account.selected")
        if self.equipment_id == "all":
            eq_name = t("report.equipment.all")
        else:
            eq = next((e for e in self.equipment_options if str(e.get("id")) == self.equipment_id), None)
            eq_name = equipment_label(eq) or t("report.equipment.unknown")
        period_rows = aggregate_period(rep.get(self.period, []) if rep else [], self.group, site_by_id, name_by_id)
        ranking = sort_ranking(aggregate_ranking(totals, rep.get("equipment_groups", []), self.group, site_by_id),
                               self.sort)
        return {"totals": s, "accounts": len(accounts), "selected": selected, "equipment": eq_name,
                "period_rows": period_rows, "site_rows": rep.get("site_groups", []), "ranking": ranking,
                "recent": rep.get("recent", [])}

    def _ranking_header(self) -> str:
        return t({"site": "report.table.site", "equipment": "report.table.equipment"}.get(self.group,
                                                                                            "report.table.account"))

    # ------------------------------------------------------------------ view
    def retranslate(self):
        self.eyebrow.setText(t("report.eyebrow"))
        self.title.setText(t("report.title"))
        self.source_lbl.setText(t("report.source.label"))
        self.cleanup_btn.setText(t("report.cleanup.action"))
        self.cleanup_btn.setToolTip(t("report.cleanup.title"))
        self.acc_lbl.setText(t("report.account.label"))
        self.eq_lbl.setText(t("report.equipment.label"))
        self.grp_lbl.setText(t("report.group.label"))
        self.sort_lbl.setText(t("report.sort.label"))
        self.pdf_btn.setToolTip(t("report.export.pdf"))
        self.csv_btn.setToolTip(t("report.export.csv"))
        self.back_btn.setText(t("report.scanConsole"))
        self.mix_card.set_title(t("report.mix.title"))
        self.mix_sub.setText(t("report.mix.subtitle"))
        self.usage_card.set_title(t("report.usage.title"))
        for m, b in self.period_btns.items():
            b.setText(t(f"report.period.{m}"))
        self.geo_card.set_title(t("report.geo.title"))
        self.geo_sub.setText(t("report.geo.subtitle"))
        self.rank_card.set_title(t("report.ranking.title"))
        self.recent_card.set_title(t("report.recent.title"))
        self.recent_sub.setText(t("report.recent.subtitle"))

    @staticmethod
    def _clear(layout) -> None:
        while layout.count():
            item = layout.takeAt(0)
            w = item.widget()
            if w is not None:
                w.deleteLater()
            elif item.layout() is not None:
                ManagementReport._clear(item.layout())

    def refresh(self):
        rep = self.report
        d = self._derived()
        busy = self.loading
        # selectors
        self.acc.blockSignals(True)
        self.acc.clear()
        self.acc.addItem(t("report.account.all"), "all")
        for a in (rep or {}).get("accounts", []):
            self.acc.addItem(a.get("name") or a.get("login_name"), str(a.get("id")))
        self.acc.setCurrentIndex(max(0, self.acc.findData(self.account_id)))
        self.acc.blockSignals(False)
        self.eq.blockSignals(True)
        self.eq.clear()
        self.eq.addItem(t("report.equipment.all"), "all")
        for e in self.equipment_options:
            self.eq.addItem(equipment_label(e), str(e.get("id")))
        self.eq.setCurrentIndex(max(0, self.eq.findData(self.equipment_id)))
        self.eq.blockSignals(False)
        self.grp.blockSignals(True)
        self.grp.clear()
        for g in ("account", "site", "equipment"):
            self.grp.addItem(t(f"report.group.{g}"), g)
        self.grp.setCurrentIndex(("account", "site", "equipment").index(self.group))
        self.grp.blockSignals(False)
        self.sort_in.blockSignals(True)
        self.sort_in.clear()
        for key, txt in (("total", t("report.sort.total")), ("name", self._ranking_header()),
                         ("raster", t("report.kind.raster")), ("vector", t("report.kind.vector")),
                         ("recent", t("report.sort.recent"))):
            self.sort_in.addItem(txt, key)
        self.sort_in.setCurrentIndex(max(0, self.sort_in.findData(self.sort)))
        self.sort_in.blockSignals(False)
        for w in (self.acc, self.grp, self.sort_in):
            w.setEnabled(not busy)
        self.eq.setEnabled(not busy and bool(self.equipment_options))
        self.pdf_btn.setEnabled(not busy and rep is not None)
        self.csv_btn.setEnabled(not busy and rep is not None)
        self.cleanup_btn.setEnabled(self.cleanup_state != "running")
        self.cleanup_status.setText(self.cleanup_msg or "")
        self.cleanup_status.setVisible(bool(self.cleanup_msg))
        set_prop(self.cleanup_status, "role", "danger" if self.cleanup_state == "error" else "muted")
        self.subtitle.setText(t("report.subtitle", account=d["selected"], equipment=d["equipment"]))
        src = (rep or {}).get("data_source")
        self.source_val.setText(t("report.source.remoteDb") if src == "remote_db" else
                                t("report.source.localDb") if src == "local_db" else
                                (src or t("report.source.unknown")))
        self.error_lbl.setText(self.error or "")
        self.error_lbl.setVisible(bool(self.error))
        tot = d["totals"]
        total = tot["total_scans"]
        kpi_data = [(t("report.kpi.total"), fmt(total), t("report.kpi.activeAccounts", count=fmt(d["accounts"]))),
                    (t("report.kpi.raster"), fmt(tot["raster_scans"]),
                     t("report.percent.scanVolume", percent=js_round(percent(tot["raster_scans"], total)))),
                    (t("report.kpi.vector"), fmt(tot["vector_scans"]),
                     t("report.percent.scanVolume", percent=js_round(percent(tot["vector_scans"], total)))),
                    (t("report.kpi.geo"), fmt(len(d["site_rows"])), t("report.kpi.geo.detail"))]
        for (n, v, det), (a, b, c) in zip(self.kpis, kpi_data):
            n.setText(a)
            v.setText(b)
            det.setText(c)
        # mix
        pal = PALETTES.get(self.group, PALETTES["account"])
        self.pie.palette = pal
        self.pie.values = (tot["raster_scans"], tot["vector_scans"], tot["other_activity"])
        self.pie.total = total
        self.pie.update()
        rp, vp = percent(tot["raster_scans"], total), percent(tot["vector_scans"], total)
        op = max(0.0, 100 - rp - vp)
        for (nl, vl, bar, pl), (name, val, pct, col) in zip(self.mix_rows, (
                (t("report.kind.raster"), tot["raster_scans"], rp, pal[0]),
                (t("report.kind.vector"), tot["vector_scans"], vp, pal[1]),
                (t("report.kind.other"), tot["other_activity"], op, pal[2]))):
            nl.setText(name)
            vl.setText(fmt(val))
            bar.set_parts([(pct, col)])
            pl.setText(f"{js_round(pct)}%")
        self.pie.setToolTip(t("report.mix.aria", raster=js_round(rp), vector=js_round(vp),
                              other=js_round(max(0, 100 - rp - vp))))
        # usage
        for m, b in self.period_btns.items():
            b.setChecked(m == self.period)
        self.usage_sub.setText(t(f"report.usage.subtitle.{self.period}"))
        self._clear(self.usage_list)
        ppal = PALETTES[self.period]
        rows = d["period_rows"]
        if busy:
            self.usage_list.addWidget(label(t("report.loading"), "muted"))
        elif not rows:
            self.usage_list.addWidget(label(t("report.empty.period"), "muted"))
        else:
            mx = max([1] + [r["total_scans"] for r in rows])
            for r in rows[-14:]:
                line = QHBoxLayout()
                lab = label(r["label"], "dim")
                lab.setMinimumWidth(180)
                bar = _Bar(12)
                bar.set_parts([(r["raster_scans"] / mx * 100, ppal[0]), (r["vector_scans"] / mx * 100, ppal[1])])
                bar.setToolTip(f"{r['label']}: {fmt(r['total_scans'])} {t('report.unit.scans')}")
                line.addWidget(lab)
                line.addWidget(bar, 1)
                line.addWidget(label(fmt(r["total_scans"]), "title"))
                self.usage_list.addLayout(line)
        # geo
        self._clear(self.geo_list)
        spal = PALETTES["site"]
        sites = d["site_rows"]
        if not sites:
            self.geo_list.addWidget(label(t("report.empty.geo"), "muted"))
        mx = max([1] + [r.get("total_scans", 0) for r in sites])
        for r in sites:
            line = QHBoxLayout()
            col = QVBoxLayout()
            col.addWidget(label(site_label(r.get("site") or r.get("location")), "title"))
            col.addWidget(label(t("report.geo.accounts", count=fmt(r.get("accounts", 0))), "muted"))
            bar = _Bar(10)
            bar.set_parts([(percent(r.get("raster_scans", 0), mx), spal[0]),
                           (percent(r.get("vector_scans", 0), mx), spal[1])])
            line.addLayout(col)
            line.addWidget(bar, 1)
            line.addWidget(label(fmt(r.get("total_scans", 0)), "title"))
            self.geo_list.addLayout(line)
        # ranking
        self.rank_sub.setText(t({"site": "report.ranking.subtitle.site",
                                 "equipment": "report.ranking.subtitle.equipment"}.get(self.group,
                                                                                        "report.ranking.subtitle.account")))
        self.rank_table.setHorizontalHeaderLabels([self._ranking_header(), t("report.kind.raster"),
                                                   t("report.kind.vector"), t("report.table.total")])
        ranking = d["ranking"]
        self.rank_table.clearSpans()
        self.rank_table.setRowCount(max(1, len(ranking)))
        if not ranking:
            self.rank_table.setSpan(0, 0, 1, 4)
            self.rank_table.setItem(0, 0, QTableWidgetItem(t("report.empty.accounts")))
        for i, r in enumerate(ranking):
            for c, v in enumerate((r["label"], fmt(r["raster_scans"]), fmt(r["vector_scans"]), fmt(r["total_scans"]))):
                self.rank_table.setItem(i, c, QTableWidgetItem(str(v)))
        # recent
        self._clear(self.recent_list)
        recent = d["recent"]
        if not recent:
            self.recent_list.addWidget(label(t("report.empty.recent"), "muted"))
        for r in recent[:10]:
            line = QHBoxLayout()
            kind = QLabel(str(r.get("scan_kind", "")).upper())
            kind.setObjectName("Pill")
            set_prop(kind, "tone", "accent" if r.get("scan_kind") == "raster" else "busy")
            col = QVBoxLayout()
            col.addWidget(label(r.get("login_name", ""), "title"))
            col.addWidget(label(f"{format_date_time(i18n.locale(), r.get('date', ''))} · "
                                f"{site_label(r.get('site') or r.get('location'))} · "
                                f"{r.get('equipment_name') or t('report.equipment.unknown')}", "muted"))
            line.addWidget(kind)
            line.addLayout(col, 1)
            self.recent_list.addLayout(line)

    # ------------------------------------------------------------------ export
    def _context(self) -> dict:
        d = self._derived()
        return {**d, "generated_at": (self.report or {}).get("generated_at", "")}

    def _export_lines(self) -> list:
        c = self._context()
        loc = i18n.locale()
        tot = c["totals"]
        L = [t("report.title"), f"Generated: {format_date_time(loc, c['generated_at'])}", f"Account: {c['selected']}",
             f"Equipment: {c['equipment']}", f"Group by: {t('report.group.' + self.group)}",
             f"Sort by: {t({'name': 'report.sort.name', 'raster': 'report.kind.raster', 'vector': 'report.kind.vector', 'recent': 'report.sort.recent'}.get(self.sort, 'report.sort.total'))}",
             f"Period: {t('report.usage.subtitle.' + self.period)}", "", "Summary",
             f"Total scans: {fmt(tot['total_scans'])}", f"Raster scans: {fmt(tot['raster_scans'])}",
             f"Vector scans: {fmt(tot['vector_scans'])}", f"Other activity: {fmt(tot['other_activity'])}",
             f"Active accounts: {fmt(c['accounts'])}", f"Site groups: {fmt(len(c['site_rows']))}", "", "Ranking",
             "Label | Raster | Vector | Total | Other | Last activity"]
        for r in c["ranking"]:
            L.append(f"{r['label']} | {fmt(r['raster_scans'])} | {fmt(r['vector_scans'])} | {fmt(r['total_scans'])} | "
                     f"{fmt(r['other_activity'])} | {format_date_time(loc, r['last_activity']) if r.get('last_activity') else '-'}")
        L += ["", "Sites", "Site | Accounts | Raster | Vector | Total | Last activity"]
        for r in c["site_rows"]:
            L.append(f"{site_label(r.get('site') or r.get('location'))} | {fmt(r.get('accounts', 0))} | "
                     f"{fmt(r.get('raster_scans', 0))} | {fmt(r.get('vector_scans', 0))} | {fmt(r.get('total_scans', 0))} | "
                     f"{format_date_time(loc, r['last_activity']) if r.get('last_activity') else '-'}")
        L += ["", "Period Trend", "Bucket | Total | Raster | Vector | Other"]
        for r in c["period_rows"]:
            L.append(f"{r['label']} | {fmt(r['total_scans'])} | {fmt(r['raster_scans'])} | {fmt(r['vector_scans'])} | "
                     f"{fmt(r['other_activity'])}")
        L += ["", "Recent Activity", "Date | User | Site | Equipment | Kind"]
        for r in c["recent"]:
            L.append(f"{format_date_time(loc, r.get('date', ''))} | {r.get('login_name', '')} | "
                     f"{site_label(r.get('site') or r.get('location'))} | "
                     f"{r.get('equipment_name') or t('report.equipment.unknown')} | {str(r.get('scan_kind', '')).upper()}")
        return L

    def _filename(self, kind: str) -> str:
        d = parse_date((self.report or {}).get("generated_at"))
        stamp = d.astimezone(timezone.utc).strftime("%Y-%m-%d") if d else "export"
        return f"management-report-{stamp}.{kind}"

    def _save_dialog(self, kind: str, data: bytes) -> None:
        default = str(Path.home() / "Downloads" / self._filename(kind))
        path, _ = QFileDialog.getSaveFileName(self, t(f"report.export.{kind}"), default,
                                              "PDF (*.pdf)" if kind == "pdf" else "CSV (*.csv)")
        if path:
            Path(path).write_bytes(data)

    def _export_pdf(self):
        if self.report is None:
            return
        lines = [w for line in self._export_lines() for w in wrap_line(line, 94)]
        pages = [lines[i:i + 44] for i in range(0, len(lines), 44)] or [[]]
        self._save_dialog("pdf", create_pdf(pages))

    def _export_csv(self):
        if self.report is None:
            return
        c = self._context()
        loc = i18n.locale()
        tot = c["totals"]
        rows = [[t("report.title")], ["Generated", format_date_time(loc, c["generated_at"])],
                ["Account", c["selected"]], ["Equipment", c["equipment"]],
                ["Group by", t("report.group." + self.group)],
                ["Sort by", t({'name': 'report.sort.name', 'raster': 'report.kind.raster', 'vector': 'report.kind.vector',
                               'recent': 'report.sort.recent'}.get(self.sort, 'report.sort.total'))],
                ["Period", t("report.usage.subtitle." + self.period)], [], ["Summary"],
                ["Total scans", str(tot["total_scans"])], ["Raster scans", str(tot["raster_scans"])],
                ["Vector scans", str(tot["vector_scans"])], ["Other activity", str(tot["other_activity"])],
                ["Active accounts", str(c["accounts"])], ["Site groups", str(len(c["site_rows"]))], [], ["Ranking"],
                ["Label", "Raster", "Vector", "Total", "Other", "Last activity"]]
        for r in c["ranking"]:
            rows.append([str(r["label"]), str(r["raster_scans"]), str(r["vector_scans"]), str(r["total_scans"]),
                         str(r["other_activity"]),
                         format_date_time(loc, r["last_activity"]) if r.get("last_activity") else ""])
        rows += [[], ["Sites"], ["Site", "Accounts", "Raster", "Vector", "Total", "Last activity"]]
        for r in c["site_rows"]:
            rows.append([site_label(r.get("site") or r.get("location")), str(r.get("accounts", 0)),
                         str(r.get("raster_scans", 0)), str(r.get("vector_scans", 0)), str(r.get("total_scans", 0)),
                         format_date_time(loc, r["last_activity"]) if r.get("last_activity") else ""])
        rows += [[], ["Period Trend"], ["Bucket", "Total", "Raster", "Vector", "Other"]]
        for r in c["period_rows"]:
            rows.append([r["label"], str(r["total_scans"]), str(r["raster_scans"]), str(r["vector_scans"]),
                         str(r["other_activity"])])
        rows += [[], ["Recent Activity"], ["Date", "User", "Site", "Equipment", "Kind"]]
        for r in c["recent"]:
            rows.append([format_date_time(loc, r.get("date", "")), r.get("login_name", ""),
                         site_label(r.get("site") or r.get("location")),
                         r.get("equipment_name") or t("report.equipment.unknown"), str(r.get("scan_kind", "")).upper()])
        text = "\n".join(",".join(escape_csv(str(v)) for v in row) for row in rows)
        self._save_dialog("csv", text.encode("utf-8"))
