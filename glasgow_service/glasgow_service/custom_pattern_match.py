"""Multi-scale grayscale template matching used by the Processing image overlay."""
from __future__ import annotations

import base64
import binascii
import io
import re
from dataclasses import dataclass

import torch
import torch.nn.functional as F
from PIL import Image, UnidentifiedImageError

_DATA_URL = re.compile(r"^data:image/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$", re.I)
_MAX_IMAGE_BYTES = 10 * 1024 * 1024
_MAX_SIDE = 256
_SCALE_STEPS = (0.5, 0.68, 0.85, 1.0, 1.2, 1.45, 1.75, 2.1)
_SCORE_THRESHOLD = 0.85
_MAX_MATCHES = 24


class CustomPatternMatchError(ValueError):
    pass


@dataclass(frozen=True)
class Match:
    x: float
    y: float
    width: float
    height: float
    score: float

    def as_dict(self) -> dict[str, float]:
        return {"x": self.x, "y": self.y, "width": self.width, "height": self.height, "score": self.score}


def _decode_image(data_url: str, label: str) -> Image.Image:
    match = _DATA_URL.fullmatch(data_url or "")
    if not match:
        raise CustomPatternMatchError(f"{label} must be a PNG, JPEG, WebP, or GIF image.")
    try:
        raw = base64.b64decode(match.group(1), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise CustomPatternMatchError(f"{label} is not valid base64 image data.") from exc
    if not raw or len(raw) > _MAX_IMAGE_BYTES:
        raise CustomPatternMatchError(f"{label} must be 10 MB or smaller.")
    try:
        with Image.open(io.BytesIO(raw)) as source:
            source.seek(0)
            rgba = source.convert("RGBA")
            background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
            background.alpha_composite(rgba)
            return background.convert("L")
    except (OSError, UnidentifiedImageError) as exc:
        raise CustomPatternMatchError(f"{label} could not be decoded as an image.") from exc


def _tensor(image: Image.Image, size: tuple[int, int]) -> torch.Tensor:
    resized = image.resize(size, Image.Resampling.BILINEAR)
    values = torch.frombuffer(bytearray(resized.tobytes()), dtype=torch.uint8)
    return values.reshape(1, 1, size[1], size[0]).to(dtype=torch.float32).div_(255.0)


def _iou(a: Match, b: Match) -> float:
    left, top = max(a.x, b.x), max(a.y, b.y)
    right, bottom = min(a.x + a.width, b.x + b.width), min(a.y + a.height, b.y + b.height)
    intersection = max(0.0, right - left) * max(0.0, bottom - top)
    union = a.width * a.height + b.width * b.height - intersection
    return intersection / union if union > 0 else 0.0


def find_custom_pattern_matches(image_data: str, template_data: str, threshold: float = _SCORE_THRESHOLD) -> list[dict[str, float]]:
    """Find template instances in the provided canvas image; coordinates use the source image's pixel space."""
    if not 0.1 <= threshold <= 1.0:
        raise CustomPatternMatchError("threshold must be between 0.1 and 1.0.")
    image = _decode_image(image_data, "Canvas image")
    template = _decode_image(template_data, "Custom pattern")
    image_width, image_height = image.size
    if min(image_width, image_height) < 16:
        raise CustomPatternMatchError("Canvas image is too small to search.")
    if min(template.size) < 8:
        raise CustomPatternMatchError("Custom pattern image is too small to match.")

    image_scale = min(1.0, _MAX_SIDE / max(image.size))
    match_width = max(1, round(image_width * image_scale))
    match_height = max(1, round(image_height * image_scale))
    search_image = _tensor(image, (match_width, match_height))
    base_template_width = max(8, round(template.width * image_scale))
    base_template_height = max(8, round(template.height * image_scale))
    source_scale_x, source_scale_y = image_width / match_width, image_height / match_height

    candidates: list[Match] = []
    with torch.inference_mode():
        for factor in _SCALE_STEPS:
            width = max(8, round(base_template_width * factor))
            height = max(8, round(base_template_height * factor))
            if width >= match_width or height >= match_height:
                continue
            patch = _tensor(template, (width, height))
            kernel = patch - patch.mean()
            template_energy = kernel.square().sum()
            if float(template_energy) < 1e-5:
                continue

            numerator = F.conv2d(search_image, kernel)
            area = width * height
            patch_mean = F.avg_pool2d(search_image, (height, width), stride=1)
            patch_energy = (F.avg_pool2d(search_image.square(), (height, width), stride=1) - patch_mean.square()).clamp_min_(1e-8) * area
            scores = (numerator / (patch_energy * template_energy).sqrt()).clamp_(-1.0, 1.0)
            # Per-scale local maxima avoid keeping every neighbouring pixel of one match.
            radius = max(3, min(width, height) // 3)
            kernel_size = radius * 2 + 1
            local_max = F.max_pool2d(scores, kernel_size=kernel_size, stride=1, padding=radius)
            peaks = (scores >= local_max - 1e-6) & (scores >= threshold)
            indexes = torch.nonzero(peaks[0, 0], as_tuple=False)
            if indexes.numel() == 0:
                continue
            peak_scores = scores[0, 0, indexes[:, 0], indexes[:, 1]]
            order = torch.argsort(peak_scores, descending=True)[:48]
            for item in order.tolist():
                top, left = (int(value) for value in indexes[item].tolist())
                candidates.append(Match(
                    x=left * source_scale_x,
                    y=top * source_scale_y,
                    width=width * source_scale_x,
                    height=height * source_scale_y,
                    score=float(peak_scores[item]),
                ))

    candidates.sort(key=lambda match: match.score, reverse=True)
    selected: list[Match] = []
    for candidate in candidates:
        if all(_iou(candidate, prior) < 0.24 for prior in selected):
            selected.append(candidate)
            if len(selected) >= _MAX_MATCHES:
                break
    return [match.as_dict() for match in selected]
