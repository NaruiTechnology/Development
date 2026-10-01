"""Translations shared with the web UI.

``data/{en,zh-CN,zh-TW}.json`` and ``data/help.json`` are generated from the
web frontend's TypeScript tables by ``scripts/i18n/extract_i18n.mjs`` so the
desktop app shows exactly the same strings (and help popovers) as the
browser. Missing keys fall back to English, then to the key itself - the
same rules as ``frontend/src/i18n/index.ts``.
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Callable, Optional

from ..core.jsmath import to_fixed

DATA = Path(__file__).resolve().parent / "data"
ALL_LOCALES = ("en", "zh-CN", "zh-TW")
LOCALE_NAMES = {"en": "English", "zh-CN": "简体中文", "zh-TW": "繁體中文"}
LOCALE_SHORT = {"en": "EN", "zh-CN": "简", "zh-TW": "繁"}

_tables: dict = {}
_help: Optional[dict] = None
_locale = "en"
_listeners: list = []
_VAR = re.compile(r"\{(\w+)\}")


def _table(locale: str) -> dict:
    if locale not in _tables:
        path = DATA / f"{locale}.json"
        table = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
        # strings for native-only controls; kept out of data/ because the
        # extractor regenerates that folder from the web tables
        table.update(_native_strings().get(locale, {}))
        _tables[locale] = table
    return _tables[locale]


def _native_strings() -> dict:
    path = Path(__file__).resolve().parent / "native_strings.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}


def locale() -> str:
    return _locale


def set_locale(code: str) -> None:
    global _locale
    code = code if code in ALL_LOCALES else "en"
    if code == _locale:
        return
    _locale = code
    for fn in list(_listeners):
        fn(code)


def on_locale_changed(fn: Callable[[str], None]) -> None:
    _listeners.append(fn)


def remove_listener(fn) -> None:
    if fn in _listeners:
        _listeners.remove(fn)


def translate(code: str, key: str, vars: Optional[dict] = None) -> str:
    raw = _table(code).get(key) or _table("en").get(key) or key
    if not vars:
        return raw
    return _VAR.sub(lambda m: str(vars[m.group(1)]) if vars.get(m.group(1)) is not None else m.group(0), raw)


def t(key: str, vars: Optional[dict] = None, **kwargs) -> str:
    if kwargs:
        vars = {**(vars or {}), **kwargs}
    return translate(_locale, key, vars)


def has_key(key: str) -> bool:
    return key in _table("en")


def help_html(topic: str) -> str:
    global _help
    if _help is None:
        path = DATA / "help.json"
        _help = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    return (_help.get(_locale) or {}).get(topic) or (_help.get("en") or {}).get(topic) or ""


def help_topics() -> list:
    help_html("")
    return sorted((_help or {}).get("en", {}).keys())


def fmt(n, *, minimum_fraction_digits: int = 0, maximum_fraction_digits: Optional[int] = None,
        use_grouping: bool = True) -> str:
    """``Intl.NumberFormat(locale, opts).format(n)`` for en / zh-CN / zh-TW.

    All three locales group integers with "," and use "." as the decimal
    separator; the default maximum fraction digits is 3 (Intl default).
    """
    try:
        value = float(n)
    except (TypeError, ValueError):
        return str(n)
    if not math.isfinite(value):
        return "NaN" if math.isnan(value) else ("∞" if value > 0 else "-∞")
    max_digits = 3 if maximum_fraction_digits is None else maximum_fraction_digits
    max_digits = max(max_digits, minimum_fraction_digits)
    text = to_fixed(value, max_digits)
    negative = text.startswith("-")
    if negative:
        text = text[1:]
    whole, _, frac = text.partition(".")
    frac = frac.rstrip("0")
    if len(frac) < minimum_fraction_digits:
        frac = frac + "0" * (minimum_fraction_digits - len(frac))
    if use_grouping:
        whole = f"{int(whole):,}"
    out = whole + ("." + frac if frac else "")
    if negative and out.strip("0.,") != "":
        out = "-" + out
    return out


def fmt_count(n) -> str:
    return fmt(n, maximum_fraction_digits=0)
