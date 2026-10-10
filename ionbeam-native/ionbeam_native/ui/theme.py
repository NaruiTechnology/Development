"""Navy / Black / Light themes, from ``frontend/src/styles/theme.css`` tokens.

Widgets reference roles through Qt object names / dynamic properties
(``class="primary"``, ``card``, ``pill`` ...) so switching theme only swaps
the application stylesheet and the palette used by custom painters.
"""
from __future__ import annotations

from dataclasses import dataclass

from PyQt6.QtGui import QColor, QPalette
from PyQt6.QtWidgets import QApplication

THEMES = ("navy", "black", "light")


@dataclass(frozen=True)
class Tokens:
    bg: str
    bg_elev: str
    bg_deep: str
    bg_input: str
    window: tuple          # gradient stops (0, 0.42|0.48, 1)
    header: tuple
    footer: tuple
    card: tuple
    card_header: tuple
    border: str
    border_soft: str
    pixel_grid: str
    text: str
    text_dim: str
    text_muted: str
    tab_icon: str
    accent: str
    accent_hot: str
    success: str
    warn: str
    danger: str
    warn_border: str
    danger_border: str
    btn_hover: str
    btn_primary: tuple
    btn_primary_hover: tuple
    btn_primary_border: str
    btn_primary_text: str
    report_raster: str = "#70ec76"
    report_vector: str = "hsl(222, 70%, 48%)"
    report_other: str = "#facc15"


NAVY = Tokens(
    bg="#0b1320", bg_elev="#11203a", bg_deep="#050a14", bg_input="#0b1828",
    window=("#08111e", "#0b1320", "#14294a"), header=("#10213c", "#1a3157", "#254674"),
    footer=("#08111e", "#10213c", "#1a3157"), card=("#26467c", "#11203a", "#0d1a2f"),
    card_header=("#2a4978", "#16294a", "#11203a"), border="#21385f", border_soft="#1b2c4d",
    pixel_grid="#102036", text="#e6eef9", text_dim="#8aa1c4", text_muted="#5d749a", tab_icon="#ffffff",
    accent="#5fb8ff", accent_hot="#88d3ff", success="#4ade80", warn="#facc15", danger="#f87171",
    warn_border="#5b4a14", danger_border="#d23535", btn_hover="#1c3463",
    btn_primary=("#2b78c2", "#1f5fa0"), btn_primary_hover=("#2e88dc", "#2068b0"),
    btn_primary_border="#3d8ed5", btn_primary_text="#ffffff",
)

BLACK = Tokens(
    bg="#000000", bg_elev="#0c0c0c", bg_deep="#000000", bg_input="#0a0a0a",
    window=("#000000", "#080808", "#181818"), header=("#050505", "#1c1c1c", "#2a2a2a"),
    footer=("#000000", "#0d0d0d", "#1c1c1c"), card=("#393838", "#0c0c0c", "#050505"),
    card_header=("#4c4a4a", "#161616", "#0c0c0c"), border="#2a2a2a", border_soft="#1a1a1a",
    pixel_grid="#0d0d0d", text="#f4f4f5", text_dim="#a1a1aa", text_muted="#71717a", tab_icon="#ffffff",
    accent="#5fb8ff", accent_hot="#88d3ff", success="#4ade80", warn="#facc15", danger="#f87171",
    warn_border="#4a3d10", danger_border="#4a1818", btn_hover="#1f1f1f",
    btn_primary=("#2b78c2", "#1f5fa0"), btn_primary_hover=("#2e88dc", "#2068b0"),
    btn_primary_border="#3d8ed5", btn_primary_text="#ffffff",
)

LIGHT = Tokens(
    bg="#f6f7fa", bg_elev="#ffffff", bg_deep="#0e1620", bg_input="#ffffff",
    window=("#f6f7fa", "#eef5ff", "#dfeaf8"), header=("#ffffff", "#e8f1fc", "#dce8f6"),
    footer=("#ffffff", "#eef5ff", "#dfeaf8"), card=("#ffffff", "#f4f7fb", "#92959a"),
    card_header=("#ffffff", "#eef2f7", "#686a6c"), border="#cdd5e0", border_soft="#e2e7ee",
    pixel_grid="#d6dbe3", text="#1a2233", text_dim="#5d6b82", text_muted="#8a96a8", tab_icon="#1a2233",
    accent="#1f6fc2", accent_hot="#1556a0", success="#16a34a", warn="#b45309", danger="#b91c1c",
    warn_border="#f4d089", danger_border="#f4b8b8", btn_hover="#e2eaf3",
    btn_primary=("#2b78c2", "#1f5fa0"), btn_primary_hover=("#3187d6", "#2068b0"),
    btn_primary_border="#1f5fa0", btn_primary_text="#ffffff",
)

TOKENS = {"navy": NAVY, "black": BLACK, "light": LIGHT}
_current = "navy"


def current() -> Tokens:
    return TOKENS[_current]


def current_name() -> str:
    return _current


def color(name: str) -> QColor:
    return QColor(getattr(current(), name))


def _lin(stops: tuple, *, horizontal: bool = False, diagonal: bool = False, mid: float = 0.58) -> str:
    x2, y2 = (1, 0) if horizontal else (1, 1) if diagonal else (0, 1)
    if len(stops) == 2:
        return f"qlineargradient(x1:0, y1:0, x2:{x2}, y2:{y2}, stop:0 {stops[0]}, stop:1 {stops[1]})"
    return (f"qlineargradient(x1:0, y1:0, x2:{x2}, y2:{y2}, stop:0 {stops[0]}, stop:{mid} {stops[1]}, "
            f"stop:1 {stops[2]})")


def stylesheet(tk: Tokens) -> str:
    return f"""
* {{ font-size: 13px; }}
QMainWindow, QDialog#Modal, QWidget#AppRoot {{ background: {_lin(tk.window, diagonal=True, mid=0.45)}; color: {tk.text}; }}
QWidget {{ color: {tk.text}; }}
QToolTip {{ background: {tk.bg_elev}; color: {tk.text}; border: 1px solid {tk.border}; padding: 4px; }}
QLabel[role="dim"] {{ color: {tk.text_dim}; }}
QLabel[role="muted"] {{ color: {tk.text_muted}; font-size: 12px; }}
QLabel[role="danger"] {{ color: {tk.danger}; }}
QLabel[role="success"] {{ color: {tk.success}; }}
QLabel[role="warn"] {{ color: {tk.warn}; }}
QLabel[role="mono"] {{ font-family: "JetBrains Mono", "DejaVu Sans Mono", monospace; }}
QLabel[role="title"] {{ font-weight: 600; font-size: 14px; }}
QLabel[role="brand"] {{ font-weight: 700; font-size: 16px; }}

QFrame#Header {{ background: {_lin(tk.header, horizontal=True)}; border-bottom: 1px solid {tk.border}; }}
QFrame#Footer {{ background: {_lin(tk.footer, horizontal=True)}; border-top: 1px solid {tk.border}; }}
QFrame#Card {{ background: {_lin(tk.card, diagonal=True)}; border: 1px solid {tk.border}; border-radius: 10px; }}
QFrame#Card[active="true"] {{ border: 2px solid {tk.accent}; }}
QFrame#CardHeader {{ background: {_lin(tk.card_header, horizontal=True, mid=0.6)}; border: none;
    border-top-left-radius: 10px; border-top-right-radius: 10px; border-bottom: 1px solid {tk.border}; }}
QFrame#CanvasBackdrop {{ background: {tk.bg_deep}; border: 1px solid {tk.border_soft}; border-radius: 6px; }}
QFrame#ErrorWedge {{ background: rgba(248, 113, 113, 0.10); border: 1px solid {tk.danger_border}; border-radius: 6px; }}
QFrame#WarnBox {{ background: rgba(250, 204, 21, 0.08); border: 1px solid {tk.warn_border}; border-radius: 6px; }}
QFrame#Pill, QLabel#Pill {{ border: 1px solid {tk.border}; border-radius: 10px; padding: 2px 8px; background: {tk.bg_elev}; }}
QLabel#Pill[tone="ok"] {{ color: {tk.success}; border-color: {tk.success}; }}
QLabel#Pill[tone="busy"] {{ color: {tk.warn}; border-color: {tk.warn}; }}
QLabel#Pill[tone="error"] {{ color: {tk.danger}; border-color: {tk.danger}; }}
QLabel#Pill[tone="accent"] {{ color: {tk.accent}; border-color: {tk.accent}; }}
QLabel#Pill[tone="dim"] {{ color: {tk.text_dim}; }}

QPushButton {{ background: {tk.bg_elev}; color: {tk.text}; border: 1px solid {tk.border}; border-radius: 6px;
    padding: 5px 12px; }}
QPushButton:hover {{ background: {tk.btn_hover}; }}
QPushButton:checked {{ border-color: {tk.accent}; color: {tk.accent}; }}
QPushButton:disabled {{ color: {tk.text_muted}; border-color: {tk.border_soft}; }}
QPushButton[kind="primary"] {{ background: {_lin(tk.btn_primary)}; color: {tk.btn_primary_text};
    border-color: {tk.btn_primary_border}; font-weight: 600; }}
QPushButton[kind="primary"]:hover {{ background: {_lin(tk.btn_primary_hover)}; }}
QPushButton[kind="primary"]:disabled {{ background: {tk.bg_elev}; color: {tk.text_muted}; border-color: {tk.border_soft}; }}
QPushButton[kind="danger"] {{ color: {tk.danger}; border-color: {tk.danger_border}; }}
QPushButton[kind="gold"] {{ background: {_lin(("#facc15", "#d97706"))}; color: #1f1300; border-color: #f59e0b; font-weight: 600; }}
QPushButton[kind="ghost"] {{ background: transparent; }}
QPushButton[kind="ghost"]:hover {{ background: {tk.btn_hover}; }}
QPushButton[kind="tab"] {{ background: transparent; border: none; border-bottom: 2px solid transparent; border-radius: 0;
    padding: 7px 12px; color: {tk.text_dim}; }}
QPushButton[kind="tab"]:checked {{ color: {tk.text}; border-bottom-color: {tk.accent}; }}
QPushButton[kind="tab"]:disabled {{ color: {tk.text_muted}; }}
QPushButton[kind="seg"] {{ border-radius: 0; padding: 3px 8px; }}
QPushButton[kind="help"] {{ border-radius: 9px; min-width: 18px; max-width: 18px; min-height: 18px; max-height: 18px;
    padding: 0; font-weight: 700; font-size: 11px; color: {tk.accent}; border-color: {tk.accent}; background: transparent; }}

QLineEdit, QSpinBox, QDoubleSpinBox, QComboBox, QPlainTextEdit, QTextEdit {{ background: {tk.bg_input}; color: {tk.text};
    border: 1px solid {tk.border}; border-radius: 6px; padding: 4px 6px; selection-background-color: {tk.accent}; }}
QLineEdit:focus, QSpinBox:focus, QDoubleSpinBox:focus, QComboBox:focus, QPlainTextEdit:focus {{ border-color: {tk.accent}; }}
QLineEdit:disabled, QSpinBox:disabled, QComboBox:disabled, QPlainTextEdit:disabled {{ color: {tk.text_muted}; }}
QLineEdit[invalid="true"], QComboBox[invalid="true"] {{ border-color: {tk.danger}; }}
QLineEdit[readOnly="true"] {{ color: {tk.text_dim}; }}
QComboBox QAbstractItemView {{ background: {tk.bg_elev}; color: {tk.text}; selection-background-color: {tk.accent}; }}
QCheckBox, QRadioButton {{ spacing: 6px; }}
QCheckBox::indicator {{ width: 30px; height: 16px; border-radius: 8px; background: {tk.border}; border: 1px solid {tk.border}; }}
QCheckBox::indicator:checked {{ background: {tk.accent}; border-color: {tk.accent}; }}
QCheckBox::indicator:disabled {{ background: {tk.border_soft}; }}
QCheckBox[plain="true"]::indicator {{ width: 14px; height: 14px; border-radius: 3px; }}
QProgressBar {{ background: {tk.bg_input}; border: 1px solid {tk.border_soft}; border-radius: 4px; height: 8px; text-align: center; }}
QProgressBar::chunk {{ background: {_lin(("#2b78c2", tk.accent), horizontal=True)}; border-radius: 4px; }}
QSlider::groove:horizontal {{ height: 4px; background: {tk.border}; border-radius: 2px; }}
QSlider::handle:horizontal {{ width: 14px; margin: -6px 0; border-radius: 7px; background: {tk.accent}; }}
QScrollArea, QScrollArea > QWidget > QWidget {{ background: transparent; border: none; }}
QScrollBar:vertical {{ background: transparent; width: 10px; }}
QScrollBar::handle:vertical {{ background: {tk.border}; border-radius: 4px; min-height: 24px; }}
QScrollBar:horizontal {{ background: transparent; height: 10px; }}
QScrollBar::handle:horizontal {{ background: {tk.border}; border-radius: 4px; min-width: 24px; }}
QScrollBar::add-line, QScrollBar::sub-line {{ width: 0; height: 0; }}
QTableWidget, QTableView, QListWidget, QTreeWidget {{ background: {tk.bg_input}; alternate-background-color: {tk.bg_elev};
    gridline-color: {tk.border_soft}; border: 1px solid {tk.border}; border-radius: 6px; }}
QHeaderView::section {{ background: {tk.bg_elev}; color: {tk.text_dim}; border: none; border-bottom: 1px solid {tk.border};
    padding: 4px 6px; }}
QMenu {{ background: {tk.bg_elev}; border: 1px solid {tk.border}; }}
QMenu::item:selected {{ background: {tk.btn_hover}; }}
QSplitter::handle {{ background: transparent; }}
QSplitter::handle:hover {{ background: {tk.border}; }}
QGroupBox {{ border: 1px solid {tk.border_soft}; border-radius: 6px; margin-top: 10px; padding-top: 6px; }}
QGroupBox::title {{ subcontrol-origin: margin; left: 8px; color: {tk.text_dim}; }}
"""


def apply(name: str) -> None:
    global _current
    _current = name if name in TOKENS else "navy"
    app = QApplication.instance()
    if app is None:
        return
    tk = current()
    pal = app.palette()
    pal.setColor(QPalette.ColorRole.Window, QColor(tk.bg))
    pal.setColor(QPalette.ColorRole.WindowText, QColor(tk.text))
    pal.setColor(QPalette.ColorRole.Base, QColor(tk.bg_input))
    pal.setColor(QPalette.ColorRole.AlternateBase, QColor(tk.bg_elev))
    pal.setColor(QPalette.ColorRole.Text, QColor(tk.text))
    pal.setColor(QPalette.ColorRole.Button, QColor(tk.bg_elev))
    pal.setColor(QPalette.ColorRole.ButtonText, QColor(tk.text))
    pal.setColor(QPalette.ColorRole.Highlight, QColor(tk.accent))
    pal.setColor(QPalette.ColorRole.PlaceholderText, QColor(tk.text_muted))
    pal.setColor(QPalette.ColorRole.ToolTipBase, QColor(tk.bg_elev))
    pal.setColor(QPalette.ColorRole.ToolTipText, QColor(tk.text))
    app.setPalette(pal)
    app.setStyleSheet(stylesheet(tk))
