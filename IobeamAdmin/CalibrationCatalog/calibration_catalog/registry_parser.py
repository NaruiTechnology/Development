"""Parser for the indented registry-tree export of HKLM\\Software\\Microscope (UI1280reg.txt).

Format: one key or value per line; nesting = 4 spaces per level; `name = value` is a value,
anything else is a key. Binary values are written as `REG_BINARY 0x..` followed by hex
continuation lines, which we skip (binary blobs are never imported).
"""
from __future__ import annotations
import re
from dataclasses import dataclass

_HEX = re.compile(r'^\s+(0x[0-9a-fA-F]+\s*)+$')


@dataclass
class RegLeaf:
    line: int
    path: str      # key path relative to the export root, '\\'-separated
    name: str      # value name ('' for the default/unnamed value)
    raw: str       # value as written
    is_binary: bool = False

    @property
    def full(self) -> str:
        return f"{self.path}\\{self.name}" if self.name else f"{self.path}\\(default)"


def parse_registry_text(text: str) -> tuple[str, list[RegLeaf]]:
    lines = text.replace("\r", "").split("\n")
    root = lines[0].strip()
    stack: list[str] = []
    leaves: list[RegLeaf] = []
    for no, ln in enumerate(lines[1:], 2):
        if not ln.strip() or _HEX.match(ln):
            continue
        depth = (len(ln) - len(ln.lstrip(" "))) // 4
        body = ln.strip()
        stack = stack[:depth - 1]
        if " = " in body or body.endswith(" =") or body.startswith("="):
            name, _, val = body.partition("=")
            val = val.strip()
            leaves.append(RegLeaf(no, "\\".join(stack), name.strip(), val,
                                  is_binary=val.startswith("REG_BINARY")))
        else:
            stack.append(body)
    return root, leaves


def parse_registry_file(path: str) -> tuple[str, list[RegLeaf]]:
    with open(path, encoding="latin-1") as fh:   # export is ISO-8859-1 (contains 'µ')
        return parse_registry_text(fh.read())


def infer_type(raw: str) -> tuple[str, float | str]:
    """Return (data_type, python value). bool -> 0/1 as float, text stays text."""
    s = raw.strip()
    if s.upper() in ("TRUE", "FALSE"):
        return "bool", 1.0 if s.upper() == "TRUE" else 0.0
    if re.fullmatch(r"-?\d+", s):
        return "int", float(int(s))
    if re.fullmatch(r"-?\d+\.\d*(?:[eE][+-]?\d+)?|-?\.\d+|-?\d+[eE][+-]?\d+", s):
        return "float", float(s)
    return "text", s
