"""JavaScript-compatible numeric helpers.

The web UI's geometry, level and timing maths use ``Math.round`` and
``Number.prototype.toFixed``. Python's ``round`` and ``format`` round halves
to even, so a naive port drifts by one DAC code / one displayed digit on exact
halves. These helpers reproduce the ECMAScript definitions so the desktop app
produces the same requests and labels as the browser.
"""
from __future__ import annotations

import math
from decimal import Decimal, ROUND_HALF_UP

__all__ = [
    "js_round", "to_fixed", "clamp", "is_finite", "js_number", "trunc",
    "fmt_number", "to_precision", "to_exponential",
]


def is_finite(value) -> bool:
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def js_number(value, default=math.nan) -> float:
    """``Number(value)`` for the value shapes the UI handles."""
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if value is None:
        return default if default is not math.nan else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if text == "":
        return 0.0
    try:
        return float(text)
    except ValueError:
        return math.nan


def js_round(x: float) -> int:
    """``Math.round``: halves round towards +infinity."""
    x = float(x)
    if not math.isfinite(x):
        raise ValueError("js_round of non-finite value")
    floor = math.floor(x)
    return int(floor + 1 if x - floor >= 0.5 else floor)


def trunc(x: float) -> int:
    return int(math.trunc(float(x)))


def clamp(value: float, lo: float, hi: float) -> float:
    if not is_finite(value):
        return lo
    return min(hi, max(lo, value))


def to_fixed(x: float, digits: int) -> str:
    """``Number.prototype.toFixed`` (round half away from zero on the exact binary value)."""
    x = float(x)
    if not math.isfinite(x):
        return "NaN" if math.isnan(x) else ("Infinity" if x > 0 else "-Infinity")
    quant = Decimal(1).scaleb(-digits)
    text = format(Decimal(x).quantize(quant, rounding=ROUND_HALF_UP), "f")
    if text.startswith("-") and float(text) == 0.0:
        text = text[1:]
    return text


def to_precision(x: float, precision: int) -> str:
    """``Number.prototype.toPrecision`` for finite values."""
    x = float(x)
    if x == 0:
        return to_fixed(0.0, precision - 1)
    exponent = math.floor(math.log10(abs(x)))
    # Re-derive the exponent after rounding (e.g. 9.9996 -> 10.00).
    rounded = Decimal(x).scaleb(-exponent).quantize(Decimal(1).scaleb(-(precision - 1)), rounding=ROUND_HALF_UP)
    if abs(rounded) >= 10:
        exponent += 1
        rounded = Decimal(x).scaleb(-exponent).quantize(Decimal(1).scaleb(-(precision - 1)), rounding=ROUND_HALF_UP)
    if exponent < -6 or exponent >= precision:
        mantissa = format(rounded, "f")
        sign = "+" if exponent >= 0 else "-"
        return f"{mantissa}e{sign}{abs(exponent)}"
    return to_fixed(x, max(0, precision - 1 - exponent))


def to_exponential(x: float, digits: int) -> str:
    """``Number.prototype.toExponential(digits)``."""
    x = float(x)
    if x == 0:
        return f"{to_fixed(0.0, digits)}e+0"
    exponent = math.floor(math.log10(abs(x)))
    mantissa = Decimal(x).scaleb(-exponent).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP)
    if abs(mantissa) >= 10:
        exponent += 1
        mantissa = Decimal(x).scaleb(-exponent).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP)
    sign = "+" if exponent >= 0 else "-"
    return f"{format(mantissa, 'f')}e{sign}{abs(exponent)}"


def fmt_number(n: float, max_fraction_digits: int = 3) -> str:
    """``Intl.NumberFormat(locale).format(n)``; en, zh-CN and zh-TW all group with commas."""
    if not is_finite(n):
        return str(n)
    n = float(n)
    text = to_fixed(n, max_fraction_digits)
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    negative = text.startswith("-")
    if negative:
        text = text[1:]
    whole, _, frac = text.partition(".")
    whole = f"{int(whole):,}"
    out = f"{whole}.{frac}" if frac else whole
    if negative and out != "0":
        out = "-" + out
    return out


def js_string(x) -> str:
    """JavaScript ``String(number)`` (shortest round-trip digits, JS exponent rules)."""
    if isinstance(x, bool):
        return "true" if x else "false"
    x = float(x)
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    if x == 0:
        return "0"
    sign = "-" if x < 0 else ""
    r = repr(abs(x))
    if "e" in r:
        mant, exp = r.split("e")
        exp = int(exp)
    else:
        mant, exp = r, 0
    if "." in mant:
        whole, frac = mant.split(".")
    else:
        whole, frac = mant, ""
    digits = (whole + frac).lstrip("0")
    # decimal exponent n such that value = 0.d1d2... * 10^n
    point = len(whole) + exp if whole != "0" else exp - (len(frac) - len(frac.lstrip("0")))
    digits = digits.rstrip("0") or "0"
    k = len(digits)
    n = point
    if k <= n <= 21:
        out = digits + "0" * (n - k)
    elif 0 < n <= 21:
        out = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        out = (digits[0] + ("." + digits[1:] if k > 1 else "")) + ("e+" if e >= 0 else "e-") + str(abs(e))
    return sign + out
