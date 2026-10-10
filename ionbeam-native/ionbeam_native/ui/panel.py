"""Base class for widgets bound to the AppController (Redux-selector style)."""
from __future__ import annotations

from typing import Iterable

from PyQt6.QtWidgets import QWidget


class Panel(QWidget):
    #: topics that trigger refresh(); "locale" always triggers retranslate() + refresh()
    TOPICS: frozenset = frozenset({"scan", "panel"})

    def __init__(self, ctl, parent=None):
        super().__init__(parent)
        self.ctl = ctl
        self._updating = False
        ctl.changed.connect(self._on_changed)

    def _on_changed(self, topics: Iterable[str]) -> None:
        topics = set(topics)
        try:
            if "locale" in topics:
                self.retranslate()
            if "locale" in topics or "theme" in topics or topics & self.TOPICS:
                self._updating = True
                try:
                    self.refresh()
                finally:
                    self._updating = False
        except RuntimeError:
            # the Qt object was deleted while a queued notification was in flight
            try:
                self.ctl.changed.disconnect(self._on_changed)
            except (TypeError, RuntimeError):
                pass

    def retranslate(self) -> None:  # pragma: no cover - overridden
        pass

    def refresh(self) -> None:  # pragma: no cover - overridden
        pass

    @property
    def disabled(self) -> bool:
        return self.ctl.panel_disabled
