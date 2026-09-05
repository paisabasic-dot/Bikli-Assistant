"""
BIKLI Desktop Control Agent — frozen entrypoint.

This is the script PyInstaller freezes into `bikli-agent.exe`. It runs the
FastAPI agent with uvicorn using the app *object* (not an import string), which
is the reliable way to launch inside a PyInstaller bundle. Logs are written to
the per-user data directory so failures are never silent, even with no console.

Run (frozen):   bikli-agent.exe
Run (dev):      python run_agent.py
Environment:
    BIKLI_AGENT_HOST   default 127.0.0.1
    BIKLI_AGENT_PORT   default 8765
    BIKLI_DATA_DIR     where logs/ is written (default: cwd)
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path


def _resolve_data_dir() -> Path:
    data = os.environ.get("BIKLI_DATA_DIR") or os.getcwd()
    logs = Path(data) / "logs"
    try:
        logs.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    return Path(data)


def _configure_logging(data_dir: Path) -> None:
    handlers: list[logging.Handler] = []
    try:
        handlers.append(logging.FileHandler(data_dir / "logs" / "agent.log", encoding="utf-8"))
    except Exception:
        pass
    # When frozen with console=False there is no real stdout, so guard against None.
    if sys.stdout is not None:
        try:
            handlers.append(logging.StreamHandler(sys.stdout))
        except Exception:
            pass
    logging.basicConfig(
        level=logging.INFO,
        format="[%(asctime)s] [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        handlers=handlers,
        force=True,
    )


def main() -> None:
    data_dir = _resolve_data_dir()
    _configure_logging(data_dir)
    log = logging.getLogger("bikli.agent.boot")

    host = os.environ.get("BIKLI_AGENT_HOST", "127.0.0.1")
    port = int(os.environ.get("BIKLI_AGENT_PORT", "8765"))
    frozen = getattr(sys, "frozen", False)
    log.info("Starting BIKLI agent (frozen=%s) on %s:%d", frozen, host, port)

    try:
        from desktop_agent.main import app
        import uvicorn
    except Exception:
        log.exception("Fatal: could not import agent application.")
        raise

    try:
        if sys.stdout is None:
            import io
            sys.stdout = io.StringIO()
        if sys.stderr is None:
            import io
            sys.stderr = io.StringIO()
        uvicorn.run(app, host=host, port=port, log_level="info")
    except Exception:
        log.exception("Fatal: uvicorn exited with an error.")
        raise


if __name__ == "__main__":
    main()
