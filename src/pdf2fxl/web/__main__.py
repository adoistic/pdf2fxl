from __future__ import annotations
import os


def main() -> None:
    import uvicorn
    host = os.environ.get("REFLOW_HOST", "127.0.0.1")
    port = int(os.environ.get("REFLOW_PORT", "8028"))
    uvicorn.run("pdf2fxl.web.app:app", host=host, port=port, reload=False)


if __name__ == "__main__":
    main()
