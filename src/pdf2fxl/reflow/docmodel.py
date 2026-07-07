from __future__ import annotations
from dataclasses import dataclass, field, asdict
from typing import List, Optional, Union
import json


@dataclass
class Run:
    text: str
    bold: bool = False
    italic: bool = False
    underline: bool = False
    dropcap: bool = False


@dataclass
class Heading:
    level: int
    text: str


@dataclass
class Paragraph:
    runs: List[Run] = field(default_factory=list)


@dataclass
class Figure:
    src: str
    caption: Optional[str]
    width_frac: float
    kind: str          # plate | figure | inline


@dataclass
class Table:
    html: Optional[str]
    image_src: Optional[str]
    caption: Optional[str]


@dataclass
class Formula:
    mathml: Optional[str]
    text: Optional[str]
    image_src: Optional[str]
    caption: Optional[str]


@dataclass
class ChapterBreak:
    pass


Node = Union[Heading, Paragraph, Figure, Table, Formula, ChapterBreak]
_KINDS = {"Heading": Heading, "Paragraph": Paragraph, "Figure": Figure,
          "Table": Table, "Formula": Formula, "ChapterBreak": ChapterBreak}


@dataclass
class Doc:
    title: str
    language: str
    nodes: List[Node] = field(default_factory=list)

    def to_json(self) -> str:
        def enc(n):
            d = asdict(n)
            d["_kind"] = type(n).__name__
            return d
        return json.dumps(
            {"title": self.title, "language": self.language,
             "nodes": [enc(n) for n in self.nodes]},
            indent=2, ensure_ascii=False)

    @staticmethod
    def from_json(s: str) -> "Doc":
        d = json.loads(s)
        nodes: List[Node] = []
        for nd in d["nodes"]:
            kind = nd.pop("_kind")
            cls = _KINDS[kind]
            if cls is Paragraph:
                nodes.append(Paragraph(runs=[Run(**r) for r in nd.get("runs", [])]))
            else:
                nodes.append(cls(**nd))
        return Doc(title=d["title"], language=d["language"], nodes=nodes)
