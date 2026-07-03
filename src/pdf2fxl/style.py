from __future__ import annotations
from .config import Config


def font_for(script: str, cfg: Config) -> str:
    return cfg.font_map.get(script, cfg.font_map["Latn"])
