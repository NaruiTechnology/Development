"""Processing tab: the "Patterns" card (icon strip) and one collapsible card per
pattern, all built at start-up from ``processingPatterns.json``.

* Icon strip: one checkable icon per non-skipped pattern. Clicking an icon
  expands that pattern's card, collapses every sibling and arms the canvas tool
  so the operator can draw the pattern's ROI on the image (ring = two concentric
  circles). Clicking the active icon again disarms the tool.
* Each card is bound to its data model (``processing.models``): parameter
  widgets write to the model, the model notifies the card (ROI read-out) and the
  canvas (repaint).
"""
from __future__ import annotations

import logging
from typing import Optional

from PyQt6.QtCore import QSize, Qt, pyqtSignal
from PyQt6.QtWidgets import QCheckBox, QComboBox, QFrame, QGridLayout, QHBoxLayout, QLabel, QToolButton, QVBoxLayout

from ..i18n import fmt, t
from ..paths import processing_patterns_path
from ..processing import PatternConfigError, load_models
from . import theme
from .common import Card, NumberStepper, button, icon, label
from .panel import Panel
from .pattern_tool import ACTIVE_COLOR, PatternTool

log = logging.getLogger(__name__)
ICON_SIZE = 26
BUTTON_SIZE = 38


def tr(key: str, fallback: str) -> str:
    """Translated string, or ``fallback`` (the JSON's English text) when the key is unknown."""
    text = t(key)
    return fallback if text == key else text


class PatternCard(Card):
    """Collapsible card bound to one pattern model. Starts collapsed."""

    collapse_toggled = pyqtSignal(str, bool)        # (pattern key, collapsed) - user-driven only
    _silent = True                                  # Card.__init__ calls set_collapsed before we exist

    def __init__(self, model, unit_provider):
        super().__init__("", collapsible=True, collapsed=True)
        self.model = model
        self._unit = unit_provider
        self._widgets: dict = {}
        self._build()
        self._silent = False
        model.subscribe(self._on_model)
        self.retranslate()

    # ---- collapse handling
    def set_collapsed(self, collapsed: bool) -> None:
        super().set_collapsed(collapsed)
        if self.collapse_btn is not None:
            self.collapse_btn.setToolTip(t("processing.expand" if collapsed else "processing.collapse"))
        if not self._silent:
            self.collapse_toggled.emit(self.model.key, collapsed)

    def set_collapsed_silently(self, collapsed: bool) -> None:
        was, self._silent = self._silent, True
        try:
            self.set_collapsed(collapsed)
        finally:
            self._silent = was

    @property
    def collapsed(self) -> bool:
        return self._collapsed

    # ---- body
    def _build(self) -> None:
        m = self.model
        self.hint = label("", "dim", wrap=True)
        self.body.addWidget(self.hint)
        grid = QGridLayout()
        grid.setHorizontalSpacing(8)
        grid.setVerticalSpacing(6)
        for row, spec in enumerate(m.param_specs.values()):
            name_lbl = QLabel()
            grid.addWidget(name_lbl, row, 0)
            if spec.type in ("int", "float"):
                w = NumberStepper(m.parameters[spec.name], step=spec.step, minimum=spec.minimum,
                                  maximum=spec.maximum, width=90)
                w.valueChanged.connect(lambda text, s=spec, ww=w: self._edit_number(s, ww, text))
            elif spec.type == "bool":
                w = QCheckBox()
                w.setChecked(bool(m.parameters[spec.name]))
                w.toggled.connect(lambda v, s=spec: m.set_parameter(s.name, v))
            else:
                w = QComboBox()
                for c in spec.choices:
                    w.addItem(tr(f"processing.choice.{c}", str(c)), c)
                w.setCurrentIndex(max(0, spec.choices.index(m.parameters[spec.name])))
                w.currentIndexChanged.connect(lambda _i, s=spec, ww=w: m.set_parameter(s.name, ww.currentData()))
            grid.addWidget(w, row, 1)
            unit_lbl = label(spec.unit, "dim")
            grid.addWidget(unit_lbl, row, 2)
            self._widgets[spec.name] = (name_lbl, w, unit_lbl)
        grid.setColumnStretch(3, 1)
        self.body.addLayout(grid)
        self.readout = label("", "dim", wrap=True)
        self.body.addWidget(self.readout)
        row = QHBoxLayout()
        self.clear_btn = button("", "ghost")
        self.clear_btn.clicked.connect(m.clear_roi)
        row.addWidget(self.clear_btn)
        row.addStretch(1)
        self.body.addLayout(row)

    def _edit_number(self, spec, widget: NumberStepper, text: str) -> None:
        try:
            self.model.set_parameter(spec.name, text)
            widget.set_invalid(False)
        except ValueError:
            widget.set_invalid(True)

    def _on_model(self, _model) -> None:
        self.refresh()

    # ---- text / state
    def retranslate(self) -> None:
        m = self.model
        self.set_title(tr(f"processing.pattern.{m.key}", m.caption))
        self.hint.setText(t(f"processing.hint.{m.ROI_KIND}"))
        self.clear_btn.setText(t("processing.clear"))
        for name, (name_lbl, w, _u) in self._widgets.items():
            name_lbl.setText(tr(f"processing.param.{m.key}.{name}", m.param_specs[name].label))
            if isinstance(w, QComboBox):
                for i, c in enumerate(m.param_specs[name].choices):
                    w.setItemText(i, tr(f"processing.choice.{c}", str(c)))
        self.set_collapsed_silently(self._collapsed)        # refresh the chevron tooltip
        self.refresh()

    def refresh(self) -> None:
        m, r = self.model, self.model.roi
        unit = self._unit()
        if not r:
            text = t("processing.roi.none")
        else:
            def n(v):
                return fmt(v, maximum_fraction_digits=2)
            if m.ROI_KIND == "rect":
                text = t("processing.roi.rect", x0=n(r["x_start"]), x1=n(r["x_end"]), y0=n(r["y_start"]),
                         y1=n(r["y_end"]), unit=unit)
            elif m.ROI_KIND == "ring":
                text = t("processing.roi.ring", cx=n(r["cx"]), cy=n(r["cy"]), ri=n(r["r_inner"]),
                         ro=n(r["r_outer"]), unit=unit)
            else:
                text = t("processing.roi.polygon", n=len(r["points"]))
            text += "\n" + t("processing.area", area=fmt(m.area(), maximum_fraction_digits=2), unit=unit)
        self.readout.setText(text)
        self.clear_btn.setEnabled(r is not None)


class ProcessingPanel(Panel):
    """Content of the Processing tab."""

    TOPICS = frozenset({"theme", "roi"})
    canvas_dirty = pyqtSignal()                     # a model changed: repaint the ROI canvas

    def __init__(self, ctl, config_path=None, parent=None):
        super().__init__(ctl, parent)
        self.models: dict = {}
        self.cards: dict = {}
        self.buttons: dict = {}
        self.active_key: Optional[str] = None
        self.config_error: Optional[str] = None
        self.entry_errors: list = []
        try:
            cfg, self.models = load_models(config_path or processing_patterns_path())
            self.entry_errors = list(cfg.errors)
        except PatternConfigError as e:
            log.error("processing patterns: %s", e)
            self.config_error = str(e)
        self.tool = PatternTool(self)

        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(10)
        # "Patterns" card: not collapsible, holds the icon strip
        self.patterns_card = Card("")
        self.patterns_card.header.show()
        strip_frame = QFrame()
        strip_frame.setObjectName("PatternStrip")
        strip = QHBoxLayout(strip_frame)
        strip.setContentsMargins(4, 4, 4, 4)
        strip.setSpacing(4)
        for key, model in self.models.items():
            b = QToolButton()
            b.setCheckable(True)
            b.setFixedSize(BUTTON_SIZE, BUTTON_SIZE)
            b.setIconSize(QSize(ICON_SIZE, ICON_SIZE))
            b.setCursor(Qt.CursorShape.PointingHandCursor)
            b.clicked.connect(lambda _c, k=key: self._icon_clicked(k))
            strip.addWidget(b)
            self.buttons[key] = b
        strip.addStretch(1)
        self.patterns_card.body.addWidget(strip_frame)
        self.status = label("", "dim", wrap=True)
        self.patterns_card.body.addWidget(self.status)
        lay.addWidget(self.patterns_card)
        # one card per pattern, created from the configuration
        for key, model in self.models.items():
            card = PatternCard(model, self._unit)
            card.collapse_toggled.connect(self._card_toggled)
            model.subscribe(lambda _m: self.canvas_dirty.emit())
            self.cards[key] = card
            lay.addWidget(card)
        lay.addStretch(1)
        self.retranslate()

    # ---- canvas tool contract
    def active_model(self):
        return self.models.get(self.active_key) if self.active_key else None

    def _unit(self) -> str:
        from .roi import unit_label
        return unit_label(self.ctl.scan.roi.scale_unit)

    def set_tab_active(self, on: bool) -> None:
        if on != self.tool.enabled:
            self.tool.set_enabled(on)
            self.canvas_dirty.emit()

    # ---- selection
    def _icon_clicked(self, key: str) -> None:
        self.select(None if key == self.active_key else key)

    def _card_toggled(self, key: str, collapsed: bool) -> None:
        if not collapsed:
            self.select(key)
        elif key == self.active_key:
            self.select(None)

    def select(self, key: Optional[str]) -> None:
        """Make ``key`` the drawing pattern: expand its card, collapse all siblings."""
        if key is not None and key not in self.models:
            return
        self.active_key = key
        self.tool.cancel()
        for k, b in self.buttons.items():
            b.blockSignals(True)
            b.setChecked(k == key)
            b.blockSignals(False)
        for k, card in self.cards.items():
            card.set_collapsed_silently(k != key)
            card.set_active(k == key, ACTIVE_COLOR if k == key else None)
        self.canvas_dirty.emit()

    # ---- text / theme
    def retranslate(self) -> None:
        self.patterns_card.set_title(t("processing.patterns"))
        for key, b in self.buttons.items():
            m = self.models[key]
            b.setToolTip(tr(f"processing.pattern.{key}", m.caption))
        for card in self.cards.values():
            card.retranslate()
        self.refresh()

    def refresh(self) -> None:
        tk = theme.current()
        for key, b in self.buttons.items():
            b.setIcon(icon(self.models[key].icon, ACTIVE_COLOR if key == self.active_key else None, size=ICON_SIZE))
        msgs = []
        if self.config_error:
            msgs.append(t("processing.configError", error=self.config_error))
        elif not self.models:
            msgs.append(t("processing.noPatterns"))
        if self.entry_errors:
            msgs.append(t("processing.entryErrors", errors="; ".join(self.entry_errors)))
        self.status.setText("\n".join(msgs))
        self.status.setVisible(bool(msgs))
        self.status.setStyleSheet(f"color: {tk.danger};" if msgs else "")
        for card in self.cards.values():
            card.refresh()
