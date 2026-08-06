"""
BIKLI Desktop Control Agent — Central tool registry.

Each tool module registers handlers into a flat dict `TOOLS` mapping
tool_name -> callable(args: dict) -> dict.

Handlers return a plain dict, typically {"result": "<status string>"}.
Errors should raise ToolError(message) so main.py can map them to {error}.
Shared singletons (Playwright browser/page, confirmation store, etc.) live
on the `State` object so handlers stay stateless and easy to test.
"""

from __future__ import annotations

import importlib
import threading
from typing import Any, Callable, Dict


class ToolError(Exception):
    """Raised by a tool handler to signal a clean, user-facing failure."""

    def __init__(self, message: str, *, fatal: bool = False):
        super().__init__(message)
        self.message = message
        self.fatal = fatal


class State:
    """Process-wide shared state for tool handlers."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        # Confirmation tokens for dangerous (power) actions.
        # token -> {"action": <tool_name>, "expires": <epoch>}
        self.confirmations: Dict[str, Dict[str, Any]] = {}
        # Playwright singletons — lazily initialized on first browser tool use.
        self.playwright = None
        self.browser = None
        self.context = None
        self.page = None
        # Full PC control (cursor / keyboard / apps / files) is LOCKED until
        # the user says the control word and enableComputerControl runs.
        self.computer_control_enabled: bool = False
        self.computer_control_since: Any = None
        self.computer_control_reason: str = ""

    def reset_playwright(self) -> None:
        """Tear down any cached Playwright resources (used on errors)."""
        if self.page is not None:
            try:
                self.page.close()
            except Exception:
                pass
            self.page = None
        if self.context is not None:
            try:
                self.context.close()
            except Exception:
                pass
            self.context = None
        if self.browser is not None:
            try:
                self.browser.close()
            except Exception:
                pass
            self.browser = None
        if self.playwright is not None:
            try:
                self.playwright.stop()
            except Exception:
                pass
            self.playwright = None


STATE = State()

# tool_name -> handler(args: dict) -> dict
TOOLS: Dict[str, Callable[[Dict[str, Any]], Dict[str, Any]]] = {}


def register(name: str):
    """Decorator to register a handler under a tool name."""

    def deco(fn: Callable[[Dict[str, Any]], Dict[str, Any]]):
        TOOLS[name] = fn
        return fn

    return deco


# The set of all tool names BIKLI may route to this agent.
# Kept in sync with the functionDeclarations added in server.ts.
DESKTOP_TOOL_NAMES = [
    # applications / websites / search
    "openApplication",
    "closeApplication",
    "openWebsite",
    "searchWeb",
    "searchYouTube",
    "playYouTube",
    "searchGoogle",
    "searchGitHub",
    "openImage",
    # Windows system settings (Bluetooth, Wi‑Fi, theme, settings pages)
    "systemSetting",
    "openWindowsSetting",
    "toggleBluetooth",
    "toggleWifi",
    # files
    "createFile",
    "writeToNotepad",
    "readFile",
    "renameFile",
    "deleteFile",
    "moveFile",
    "openFolder",
    "listFiles",
    "searchFiles",
    "openLocalImage",
    "openFile",
    # Office documents (real .docx / .xlsx / .pptx — not plain text)
    "createWordFile",
    "createExcelFile",
    "createPowerPointFile",
    # pc control (volume + gated power + real-browser media)
    "volumeUp",
    "volumeDown",
    "muteToggle",
    "setVolume",
    "browserMediaControl",  # pause/resume/play YouTube in Chrome/Edge
    "browserScroll",  # scroll real Chrome/Edge / YouTube (not in-app iframe)
    "requestPowerAction",  # first step: issues a confirmation token
    "executePowerAction",  # second step: runs the gated action
    # windows
    "minimizeWindow",
    "maximizeWindow",
    "closeWindow",
    "switchApplication",
    # clipboard
    "copySelected",
    "pasteClipboard",
    "getClipboard",
    "clearClipboard",
    # screenshot / screen reading
    "takeScreenshot",
    "saveScreenshot",
    "analyzeScreenshot",
    "readScreen",
    # browser automation (Playwright — desktop-owned, separate from holographic UI)
    "desktopBrowserOpen",
    "desktopBrowserNavigate",
    "desktopBrowserOpenTab",
    "desktopBrowserCloseTab",
    "desktopBrowserSearch",
    "desktopBrowserClick",
    "desktopBrowserType",
    "desktopBrowserFillForm",
    "desktopBrowserGoBack",
    "desktopBrowserGoForward",
    "desktopBrowserScroll",
    # coding assistance
    "createPythonFile",
    "runPythonScript",
    "createProjectFolder",
    "writeCodeFile",
    # system information
    "systemInfo",
    "gpuInfo",
    "temperatureInfo",
    "batteryInfo",
    "getDateTime",
    # brightness control (V2)
    "brightnessUp",
    "brightnessDown",
    "setBrightness",
    # Windows auto-start management (V2)
    "enableAutoStart",
    "disableAutoStart",
    "getAutoStartStatus",
    # Computer control gate (control word unlocks full PC + cursor)
    "enableComputerControl",
    "disableComputerControl",
    "getComputerControlStatus",
    # Cursor + keyboard (require control mode)
    "getScreenSize",
    "getMousePosition",
    "moveMouse",
    "clickMouse",
    "doubleClick",
    "rightClick",
    "dragMouse",
    "scrollMouse",
    "typeText",
    "pressKey",
    "hotkey",
    "mouseMoveAndClick",
]

# Tools that work even when computer control is LOCKED.
# Everything else in DESKTOP_TOOL_NAMES requires the control word first.
CONTROL_ALWAYS_ALLOWED = frozenset(
    {
        "enableComputerControl",
        "disableComputerControl",
        "getComputerControlStatus",
        # Read-only / safe diagnostics
        "systemInfo",
        "gpuInfo",
        "temperatureInfo",
        "batteryInfo",
        "getDateTime",
        "takeScreenshot",
        "saveScreenshot",
        "analyzeScreenshot",
        "readScreen",
        "getClipboard",
        "getAutoStartStatus",
        # Real-browser media (YouTube in Chrome) — no control word.
        # NOTE: browserScroll is intentionally NOT here — its implementation
        # moves the physical cursor and scrolls whatever window is under it,
        # so it requires the control word like other cursor tools.
        "browserMediaControl",
        "openWebsite",
        "searchYouTube",
        "playYouTube",
        "searchGoogle",
        "searchWeb",
        "searchGitHub",
        "openImage",
        # Write notes/stories + read files without control word (no keyboard typing)
        "createFile",
        "writeToNotepad",
        "readFile",
        "listFiles",
        "searchFiles",
        "openFolder",
        "openLocalImage",
        "openFile",
        "createWordFile",
        "createExcelFile",
        "createPowerPointFile",
        # Quick system toggles — no control word (Bluetooth / Wi‑Fi / volume / brightness)
        "systemSetting",
        "openWindowsSetting",
        "toggleBluetooth",
        "toggleWifi",
        "volumeUp",
        "volumeDown",
        "muteToggle",
        "setVolume",
        "brightnessUp",
        "brightnessDown",
        "setBrightness",
    }
)


# --- Eagerly import all tool modules so their @register decorators run. ---
# Each module is imported defensively: a hard import failure here would make
# the whole agent unstartable, which we want to avoid. The modules themselves
# keep optional-dependency imports lazy/try-except.
_MODULE_NAMES = [
    "tools_control",  # must load early — other tools may call require_control
    "tools_confirmation",
    "tools_applications",
    "tools_websites",
    "tools_search",
    "tools_files",
    "tools_office",
    "tools_pc",
    "tools_windows",
    "tools_clipboard",
    "tools_screenshot",
    "tools_browser",
    "tools_coding",
    "tools_system",
    "tools_system_settings",
    "tools_startup",
    "tools_cursor",
]


def load_all() -> None:
    """Import tool modules; skip a module on failure so the agent still boots."""
    import logging

    log = logging.getLogger("bikli.desktop")
    for mod_name in _MODULE_NAMES:
        try:
            importlib.import_module(f".{mod_name}", package="desktop_agent")
        except Exception as e:  # noqa: BLE001 — one bad module must not kill the agent
            log.warning("Failed to load tool module %s: %s", mod_name, e)


__all__ = [
    "TOOLS",
    "STATE",
    "DESKTOP_TOOL_NAMES",
    "CONTROL_ALWAYS_ALLOWED",
    "ToolError",
    "register",
    "load_all",
]
