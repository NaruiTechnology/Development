"""numpy <-> QImage <-> PNG helpers."""
from __future__ import annotations

from typing import Optional

import numpy as np
from PyQt6.QtCore import QBuffer, QByteArray, QIODevice
from PyQt6.QtGui import QImage


def rgba_to_qimage(rgba: np.ndarray) -> QImage:
    """(H, W, 4) uint8 RGBA -> QImage (deep copy, safe to keep)."""
    arr = np.ascontiguousarray(rgba, dtype=np.uint8)
    h, w = arr.shape[:2]
    img = QImage(arr.data, w, h, w * 4, QImage.Format.Format_RGBA8888)
    return img.copy()


def qimage_to_rgba(img: QImage) -> np.ndarray:
    img = img.convertToFormat(QImage.Format.Format_RGBA8888)
    w, h = img.width(), img.height()
    ptr = img.constBits()
    ptr.setsize(img.sizeInBytes())
    arr = np.frombuffer(ptr, dtype=np.uint8).reshape(h, img.bytesPerLine())[:, : w * 4]
    return arr.reshape(h, w, 4).copy()


def qimage_to_png(img: QImage) -> bytes:
    ba = QByteArray()
    buf = QBuffer(ba)
    buf.open(QIODevice.OpenModeFlag.WriteOnly)
    img.save(buf, "PNG")
    buf.close()
    return bytes(ba.data())


def png_to_qimage(data: Optional[bytes]) -> Optional[QImage]:
    if not data:
        return None
    img = QImage()
    if not img.loadFromData(data):
        return None
    return img


def png_data_url(png: bytes) -> str:
    import base64
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")
