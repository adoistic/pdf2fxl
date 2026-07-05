from click.testing import CliRunner
from unittest import mock
from pathlib import Path
from pdf2fxl.cli import main


def test_cli_reflow_dispatches_to_reflow_pipeline(tmp_path):
    pdf = tmp_path / "in.pdf"; pdf.write_bytes(b"%PDF-1.4\n")
    runner = CliRunner()
    with mock.patch("pdf2fxl.cli.convert_book_reflow") as m:
        m.return_value = [tmp_path / "Book.epub"]
        res = runner.invoke(main, [str(pdf), "-o", str(tmp_path), "--mode", "reflow",
                                   "--title", "Book", "--tables", "image",
                                   "--layout", "two-up"],
                            env={"MISTRAL_API_KEY": "x"})
    assert res.exit_code == 0, res.output
    assert m.called
    cfg = m.call_args.kwargs["cfg"]
    assert cfg.mode == "reflow"
    assert cfg.reflow_tables == "image"
    assert cfg.reflow_layout == "two-up"
