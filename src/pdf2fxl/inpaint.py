from __future__ import annotations
from typing import Protocol
import cv2
import numpy as np
from PIL import Image


class Inpainter(Protocol):
    def __call__(self, image: Image.Image, mask: Image.Image) -> Image.Image: ...


class LamaInpainter:
    """LaMa via simple-lama-inpainting. Torch is imported lazily."""
    def __init__(self) -> None:
        from simple_lama_inpainting import SimpleLama
        self._lama = SimpleLama()

    def __call__(self, image: Image.Image, mask: Image.Image) -> Image.Image:
        return self._lama(image.convert("RGB"), mask.convert("L"))


def apply_inpainting(image_bgr: np.ndarray, mask: np.ndarray,
                     inpainter: Inpainter) -> np.ndarray:
    """Run an inpainter over a BGR array + single-channel mask; return BGR array."""
    img_rgb = Image.fromarray(cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB))
    out = inpainter(img_rgb, Image.fromarray(mask))
    return cv2.cvtColor(np.array(out.convert("RGB")), cv2.COLOR_RGB2BGR)
