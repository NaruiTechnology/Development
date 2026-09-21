"""Parser for FEI xP machine-data text files (MD.TXT, icMD*.TXT).

Line grammar (observed in the vendor files):

    int   <slot>  <value>  /* SYMBOL  description  [unit]  FLAGS */
    float <slot>  <value>  /* SYMBOL  description  [unit]  FLAGS */

* `int` and `float` are *separate address spaces* (int 0 and float 0 both exist).
* FLAGS (right-aligned tokens): F = fixed value, A = adjustable, Axx = adjustment number xx,
  A-- = adjustable via SDB jumper/service, ACB = maintained by auto contrast/brightness,
  CS = Cascade UI only, DB = see note in file header, 611 = FIB-611 systems only.
* Stage rows carry an axis prefix: `X:  MD_8I_KP  [raw ]  A`.
* Many SEM rows have no symbol at all (`/* new  A */`) - vendor-undocumented.
"""
from __future__ import annotations
import re
from dataclasses import dataclass, field

_ROW = re.compile(r'^(int|float)\s+(\d+)\s+(\S+)\s*(?:/\*(.*?)\*/)?\s*$')
_AXIS = re.compile(r'^(X|Y|Z|T|R|LL):\s+(\S+)\s*(.*)$')
_SYMBOL = re.compile(r'^[A-Z][A-Z0-9]*_[A-Za-z0-9_]+$|^[A-Z][A-Z0-9_]{2,}$')  # allow vendor mixed case, e.g. MD_8I_spare_6
_UNIT_BRACKET = re.compile(r'\[\s*([^\]]*?)\s*\]')
_UNIT_PAREN = re.compile(r'\(\s*(um|uDeg|mm|nm)\s*\)')
_FLAG_TOKENS = {"F", "A", "CS", "DB", "611", "ACB", "A--", "*", "NotUsed"}
_UNNAMED = {"new", "not", "out", "obsolete", "IMD"}


@dataclass
class MdRow:
    file: str
    line: int
    kind: str            # 'int' | 'float'
    slot: int
    raw: str             # value exactly as written
    symbol: str | None   # vendor symbol (None when unnamed)
    axis: str | None     # stage axis prefix for MD_8I_* rows
    description: str
    unit: str | None     # only when the vendor wrote one
    flags: list[str] = field(default_factory=list)
    adjustment_no: str | None = None
    comment: str = ""    # full original comment text (for traceability)

    @property
    def value(self) -> float:
        return float(self.raw)

    @property
    def is_named(self) -> bool:
        return self.symbol is not None


def _is_flag(tok: str) -> bool:
    return tok in _FLAG_TOKENS or bool(re.fullmatch(r"A\d+", tok))


def parse_comment(comment: str) -> dict:
    """Split '/* SYMBOL description [unit] FLAGS */' into its parts."""
    text = comment.strip()
    axis = None
    m = _AXIS.match(text)
    if m:
        axis, text = m.group(1), (m.group(2) + " " + m.group(3)).strip()
    unit = None
    mu = _UNIT_BRACKET.search(text) or _UNIT_PAREN.search(text)
    if mu:
        unit = mu.group(1).strip() or None
        text = (text[:mu.start()] + " " + text[mu.end():]).strip()
    toks = text.split()
    flags: list[str] = []
    while toks and _is_flag(toks[-1]):
        flags.insert(0, toks.pop())
    symbol = None
    if toks and toks[0] not in _UNNAMED and _SYMBOL.match(toks[0]):
        symbol = toks.pop(0)
    elif toks and toks[0] in _UNNAMED and toks[0] != "IMD":
        pass  # keep the words as description ('new', 'not used', 'obsolete', 'out of use')
    adj = next((f[1:] for f in flags if re.fullmatch(r"A\d+", f)), None)
    return dict(symbol=symbol, axis=axis, description=" ".join(toks).strip(),
                unit=unit, flags=flags, adjustment_no=adj)


def parse_md_text(text: str, filename: str) -> list[MdRow]:
    rows: list[MdRow] = []
    for i, ln in enumerate(text.replace("\r", "").split("\n"), 1):
        m = _ROW.match(ln.strip())
        if not m:
            continue
        kind, slot, raw, comment = m.group(1), int(m.group(2)), m.group(3), (m.group(4) or "").strip()
        p = parse_comment(comment)
        rows.append(MdRow(file=filename, line=i, kind=kind, slot=slot, raw=raw,
                          comment=comment, **p))
    return rows


def parse_md_file(path: str, filename: str | None = None) -> list[MdRow]:
    import os
    with open(path, encoding="latin-1") as fh:
        return parse_md_text(fh.read(), filename or os.path.basename(path))
