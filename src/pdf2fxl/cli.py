from __future__ import annotations
import os
from pathlib import Path
import click

from .config import Config
from .pipeline import convert_book


def _load_dotenv(path: str = ".env") -> None:
    """Load KEY=VALUE lines from a .env file into os.environ without overriding existing vars."""
    p = Path(path)
    if not p.exists():
        return
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip()
        if key and key not in os.environ:
            os.environ[key] = val


@click.command()
@click.argument("pdf", type=click.Path(exists=True, dir_okay=False))
@click.option("-o", "--out", "out_dir", default="out", show_default=True,
              type=click.Path(file_okay=False), help="Output directory.")
@click.option("--title", default=None, help="Book title (defaults to the PDF stem).")
@click.option("--language", default="en", show_default=True)
@click.option("--font", "font_path", default="assets/fonts/NotoSerif-Regular.ttf",
              show_default=True, type=click.Path())
def main(pdf: str, out_dir: str, title: str, language: str, font_path: str) -> None:
    """Convert a picture-book PDF into a fixed-layout EPUB and a PPTX."""
    _load_dotenv()
    api_key = os.environ.get("MISTRAL_API_KEY", "")
    if not api_key:
        raise click.ClickException("MISTRAL_API_KEY is not set (environment or .env).")
    title = title or Path(pdf).stem
    epub, pptx = convert_book(pdf, Path(out_dir), cfg=Config(), api_key=api_key,
                              title=title, language=language, font_path=font_path)
    click.echo(f"Wrote {epub}")
    click.echo(f"Wrote {pptx}")


if __name__ == "__main__":
    main()
