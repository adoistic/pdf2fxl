from click.testing import CliRunner
from unittest.mock import patch
from pathlib import Path
import pytest
from pdf2fxl.cli import main

def test_cli_invokes_convert_book(tmp_path):
    pdf = tmp_path / "book.pdf"; pdf.write_bytes(b"%PDF-1.4\n")
    with patch("pdf2fxl.cli.convert_book") as m:
        m.return_value = (tmp_path / "book.epub", tmp_path / "book.pptx")
        r = CliRunner().invoke(main, [str(pdf), "-o", str(tmp_path / "out"),
                                      "--title", "Book"],
                               env={"MISTRAL_API_KEY": "test-key"})
    assert r.exit_code == 0, r.output
    assert m.call_count == 1
    kwargs = m.call_args.kwargs
    assert kwargs["api_key"] == "test-key"
    assert kwargs["title"] == "Book"

def test_cli_errors_without_api_key(tmp_path, monkeypatch):
    pdf = tmp_path / "book.pdf"; pdf.write_bytes(b"%PDF-1.4\n")
    monkeypatch.chdir(tmp_path)   # no .env here, so the loader finds nothing
    r = CliRunner().invoke(main, [str(pdf)], env={"MISTRAL_API_KEY": ""})
    assert r.exit_code != 0
    assert "MISTRAL_API_KEY" in r.output

def test_cli_loads_env_file(tmp_path, monkeypatch):
    pdf = tmp_path / "book.pdf"; pdf.write_bytes(b"%PDF-1.4\n")
    (tmp_path / ".env").write_text("MISTRAL_API_KEY=from-dotenv\n")
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("MISTRAL_API_KEY", raising=False)
    with patch("pdf2fxl.cli.convert_book") as m:
        m.return_value = (tmp_path / "b.epub", tmp_path / "b.pptx")
        r = CliRunner().invoke(main, [str(pdf), "-o", str(tmp_path / "out")])
    assert r.exit_code == 0, r.output
    assert m.call_args.kwargs["api_key"] == "from-dotenv"


def test_cli_dpi_option(tmp_path):
    """--dpi 150 results in convert_book called with cfg.zoom == 150/72."""
    pdf = tmp_path / "book.pdf"; pdf.write_bytes(b"%PDF-1.4\n")
    with patch("pdf2fxl.cli.convert_book") as m:
        m.return_value = (tmp_path / "book.epub", tmp_path / "book.pptx")
        r = CliRunner().invoke(main, [str(pdf), "-o", str(tmp_path / "out"),
                                      "--title", "Book", "--dpi", "150"],
                               env={"MISTRAL_API_KEY": "test-key"})
    assert r.exit_code == 0, r.output
    cfg = m.call_args.kwargs["cfg"]
    assert pytest.approx(cfg.zoom) == 150 / 72


def test_cli_default_dpi(tmp_path):
    """Default dpi=200 results in cfg.zoom == 200/72."""
    pdf = tmp_path / "book.pdf"; pdf.write_bytes(b"%PDF-1.4\n")
    with patch("pdf2fxl.cli.convert_book") as m:
        m.return_value = (tmp_path / "book.epub", tmp_path / "book.pptx")
        r = CliRunner().invoke(main, [str(pdf), "-o", str(tmp_path / "out"),
                                      "--title", "Book"],
                               env={"MISTRAL_API_KEY": "test-key"})
    assert r.exit_code == 0, r.output
    cfg = m.call_args.kwargs["cfg"]
    assert pytest.approx(cfg.zoom) == 200 / 72
