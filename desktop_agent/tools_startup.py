"""
Windows auto-start management for BIKLI (V2).

Manages a single registry entry under
    HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\Bikli
which points at start-bikli-silent.bat in the project root. HKCU is used
(no admin rights required) and the change is per-user.

Tools:
  - enableAutoStart   : write the Run key + ensure the .bat exists
  - disableAutoStart  : remove the Run key
  - getAutoStartStatus: report whether the entry exists + its target

Gracefully degrades on non-Windows platforms (returns a clear message instead
of raising).
"""

from __future__ import annotations

import os
import sys
from typing import Any, Dict, Optional

from .registry import ToolError, register

# Single backslashes — winreg expects normal registry path separators.
RUN_KEY_PATH = r"Software\Microsoft\Windows\CurrentVersion\Run"
VALUE_NAME = "Bikli"
SILENT_LAUNCHER = "start-bikli-silent.bat"


def _project_root() -> str:
    """Return the app/project root (not the PyInstaller extract dir)."""
    env_root = os.environ.get("BIKLI_APP_ROOT")
    if env_root and os.path.isdir(env_root):
        return env_root

    # Frozen agent: bikli-agent.exe lives in agent_dist/bikli-agent or resources/agent
    if getattr(sys, "frozen", False):
        exe_dir = os.path.dirname(os.path.abspath(sys.executable))
        for candidate in (
            os.path.dirname(exe_dir),  # …/agent_dist or …/resources
            os.path.dirname(os.path.dirname(exe_dir)),  # project / install root
        ):
            if os.path.isfile(os.path.join(candidate, "package.json")) or os.path.isfile(
                os.path.join(candidate, SILENT_LAUNCHER)
            ):
                return candidate
            # Packaged Electron: resources/app is the app root
            app_dir = os.path.join(candidate, "app")
            if os.path.isdir(app_dir) and (
                os.path.isfile(os.path.join(app_dir, "package.json"))
                or os.path.isfile(os.path.join(app_dir, "dist", "server.cjs"))
            ):
                return app_dir
        return os.path.dirname(exe_dir)

    # Source: desktop_agent/tools_startup.py → parent of package = project root
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _launcher_path() -> str:
    return os.path.join(_project_root(), SILENT_LAUNCHER)


def _resolve_agent_exe() -> Optional[str]:
    """Locate frozen bikli-agent.exe if present."""
    root = _project_root()
    candidates = [
        os.environ.get("BIKLI_AGENT_EXE") or "",
        os.path.join(root, "agent_dist", "bikli-agent", "bikli-agent.exe"),
        os.path.join(root, "agent_dist", "bikli-agent.exe"),
        # Packaged: sibling of app root under resources/agent
        os.path.join(os.path.dirname(root), "agent", "bikli-agent.exe"),
    ]
    if getattr(sys, "frozen", False):
        candidates.insert(0, sys.executable)
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    return None


def _resolve_python() -> str:
    """Best-effort local Python for source-mode launch (no machine-specific paths)."""
    local = os.environ.get("LOCALAPPDATA") or ""
    candidates = [
        os.environ.get("BIKLI_PYTHON") or "",
        os.path.join(local, "Programs", "Python", "Python312", "python.exe") if local else "",
        os.path.join(local, "Programs", "Python", "Python311", "python.exe") if local else "",
        "python",
        "python3",
        "py",
    ]
    for p in candidates:
        if not p:
            continue
        if os.path.isabs(p) or (len(p) > 2 and p[1] == ":"):
            if os.path.isfile(p):
                return p
            continue
        if _which(p):
            return p
    return "python"


def _ensure_launcher_exists() -> str:
    """
    Make sure start-bikli-silent.bat exists in the project root.
    If missing, write a minimal silent launcher so auto-start never breaks.
    """
    path = _launcher_path()
    if os.path.isfile(path):
        return path

    root = _project_root()
    agent_exe = _resolve_agent_exe()
    lines = [
        "@echo off",
        "chcp 65001 >nul",
        f'set "PROJECT_DIR={root}"',
        'cd /d "%PROJECT_DIR%"',
    ]
    if agent_exe:
        lines += [
            f'set "AGENT_EXE={agent_exe}"',
            'start "" /B "%AGENT_EXE%"',
        ]
    else:
        py = _resolve_python()
        lines += [
            f'set "PYTHON_EXE={py}"',
            (
                'start "" /B "%PYTHON_EXE%" -m uvicorn desktop_agent.main:app '
                "--host 127.0.0.1 --port 8765"
            ),
        ]
    lines += [
        "timeout /t 3 /nobreak >nul",
        # Prefer packaged Electron / built server when present
        'if exist "%PROJECT_DIR%\\release\\win-unpacked\\BIKLI.exe" (',
        '  start "" "%PROJECT_DIR%\\release\\win-unpacked\\BIKLI.exe"',
        ") else if exist \"%PROJECT_DIR%\\dist\\server.cjs\" (",
        '  start "" /B cmd /c "cd /d "%PROJECT_DIR%" && node dist\\server.cjs"',
        "  timeout /t 6 /nobreak >nul",
        '  start "" "http://localhost:3000"',
        ") else (",
        '  start "" /B cmd /c "cd /d "%PROJECT_DIR%" && npm run dev"',
        "  timeout /t 6 /nobreak >nul",
        '  start "" "http://localhost:3000"',
        ")",
        "",
    ]
    body = "\r\n".join(lines)
    try:
        with open(path, "w", encoding="utf-8", newline="\r\n") as fh:
            fh.write(body)
    except OSError as e:  # pragma: no cover - filesystem error
        raise ToolError(f"Could not create silent launcher: {e}") from e
    return path


def _which(cmd: str) -> bool:
    """True if a command resolves on PATH (very small shim, no shutil import)."""
    from shutil import which

    return which(cmd) is not None


def _is_windows() -> bool:
    return sys.platform.startswith("win") or os.name == "nt"


# --- Registry helpers --------------------------------------------------------

def _open_run_key():
    """Open HKCU Run key for read/write. Returns the handle (caller closes)."""
    if not _is_windows():
        raise ToolError("Auto-start is only supported on Windows.")
    import winreg  # type: ignore[import-not-found]

    return winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, RUN_KEY_PATH, 0, winreg.KEY_SET_VALUE | winreg.KEY_READ)


def _read_run_value() -> str | None:
    if not _is_windows():
        return None
    try:
        import winreg  # type: ignore[import-not-found]

        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER, RUN_KEY_PATH, 0, winreg.KEY_READ
        ) as key:
            value, _ = winreg.QueryValueEx(key, VALUE_NAME)
            return str(value)
    except FileNotFoundError:
        return None
    except OSError:
        return None
    except ImportError:
        return None


# --- Tools -------------------------------------------------------------------

@register("enableAutoStart")
def enable_auto_start(args: Dict[str, Any]) -> Dict[str, Any]:
    """Create the Windows startup entry pointing at the silent launcher."""
    if not _is_windows():
        raise ToolError("Auto-start is only supported on Windows.")
    launcher = _ensure_launcher_exists()
    import winreg  # type: ignore[import-not-found]

    # Quote the path so spaces in the project dir don't break the command.
    command = f'cmd /c "{launcher}"'
    try:
        with _open_run_key() as key:
            winreg.SetValueEx(key, VALUE_NAME, 0, winreg.REG_SZ, command)
    except OSError as e:
        raise ToolError(f"Could not write startup registry entry: {e}") from e

    return {
        "result": "Auto-start enabled. Bikli will launch silently on next Windows login.",
        "enabled": True,
        "launcher": launcher,
        "registry_key": f"HKCU\\{RUN_KEY_PATH}\\{VALUE_NAME}",
    }


@register("disableAutoStart")
def disable_auto_start(args: Dict[str, Any]) -> Dict[str, Any]:
    """Remove the Windows startup entry."""
    if not _is_windows():
        raise ToolError("Auto-start is only supported on Windows.")
    existing = _read_run_value()
    if existing is None:
        return {"result": "Auto-start was already disabled.", "enabled": False}
    import winreg  # type: ignore[import-not-found]

    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER, RUN_KEY_PATH, 0, winreg.KEY_SET_VALUE
        ) as key:
            winreg.DeleteValue(key, VALUE_NAME)
    except FileNotFoundError:
        return {"result": "Auto-start was already disabled.", "enabled": False}
    except OSError as e:
        raise ToolError(f"Could not remove startup registry entry: {e}") from e

    return {
        "result": "Auto-start disabled. Bikli will no longer launch on login.",
        "enabled": False,
    }


@register("getAutoStartStatus")
def get_auto_start_status(args: Dict[str, Any]) -> Dict[str, Any]:
    """Report whether auto-start is currently enabled."""
    if not _is_windows():
        return {"result": "Auto-start is only supported on Windows.", "enabled": False, "platform": sys.platform}
    value = _read_run_value()
    enabled = value is not None
    return {
        "result": (
            "Auto-start is ENABLED. Bikli launches on Windows login."
            if enabled
            else "Auto-start is DISABLED."
        ),
        "enabled": enabled,
        "launcher": value,
        "platform": sys.platform,
    }
