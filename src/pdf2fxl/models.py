from __future__ import annotations
from dataclasses import dataclass, field
from typing import List, Tuple
import json


@dataclass
class Block:
    type: str
    bbox: Tuple[float, float, float, float]  # x, y, w, h (px on trimmed page)
    text: str
    script: str = "Latn"
    font_px: float = 0.0
    color: str = "#000000"
    align: str = "left"
    reading_order: int = 0
    confidence: float = 1.0


@dataclass
class Page:
    index: int
    page_size_px: Tuple[int, int]
    background: str
    original: str
    blocks: List[Block] = field(default_factory=list)

    def to_json(self) -> str:
        return json.dumps({
            "index": self.index,
            "page_size_px": list(self.page_size_px),
            "background": self.background,
            "original": self.original,
            "blocks": [{
                "type": b.type, "bbox": list(b.bbox), "text": b.text,
                "script": b.script, "font_px": b.font_px, "color": b.color,
                "align": b.align, "reading_order": b.reading_order,
                "confidence": b.confidence,
            } for b in self.blocks],
        }, indent=2, ensure_ascii=False)

    @staticmethod
    def from_json(s: str) -> "Page":
        d = json.loads(s)
        return Page(
            index=d["index"],
            page_size_px=tuple(d["page_size_px"]),
            background=d["background"],
            original=d["original"],
            blocks=[Block(
                type=b["type"], bbox=tuple(b["bbox"]), text=b["text"],
                script=b.get("script", "Latn"), font_px=b.get("font_px", 0.0),
                color=b.get("color", "#000000"), align=b.get("align", "left"),
                reading_order=b.get("reading_order", 0),
                confidence=b.get("confidence", 1.0),
            ) for b in d["blocks"]],
        )
