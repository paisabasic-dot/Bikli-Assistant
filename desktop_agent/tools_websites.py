"""
Website control: open named sites or arbitrary URLs in the default browser.

Default behaviour reuses the existing browser tab (focus + address bar navigate)
so "search YouTube Motu Patlu" does not open a second tab when YouTube is already
open. Only new_window/new_tab opens a fresh tab/window.
"""

from __future__ import annotations

import os
import platform
import re
import subprocess
import time
import webbrowser
from typing import Any, Dict, Optional
from urllib.parse import quote

from .registry import ToolError, register

# Named shortcuts the model can request by friendly name.
SITE_URLS: Dict[str, str] = {
    "youtube": "https://www.youtube.com",
    "gmail": "https://mail.google.com",
    "chatgpt": "https://chatgpt.com",
    "openai": "https://chat.openai.com",
    "google": "https://www.google.com",
    "github": "https://github.com",
    "wikipedia": "https://www.wikipedia.org",
    "reddit": "https://www.reddit.com",
    "twitter": "https://twitter.com",
    "x": "https://x.com",
    "instagram": "https://www.instagram.com",
    "facebook": "https://www.facebook.com",
    "linkedin": "https://www.linkedin.com",
    "maps": "https://maps.google.com",
    "translate": "https://translate.google.com",
    "drive": "https://drive.google.com",
    "calendar": "https://calendar.google.com",
    "amazon": "https://www.amazon.com",
    "netflix": "https://www.netflix.com",
    "spotify": "https://open.spotify.com",
    "stack overflow": "https://stackoverflow.com",
    "stackoverflow": "https://stackoverflow.com",
    "huggingface": "https://huggingface.co",
}

_BROWSER_IMAGES = (
    "chrome.exe",
    "msedge.exe",
    "firefox.exe",
    "brave.exe",
    "opera.exe",
)


def _normalize_url(raw: str) -> str:
    url = raw.strip()
    if not url:
        raise ToolError("Empty URL.")
    if "://" not in url:
        # Treat bare "youtube.com" as https://youtube.com
        url = "https://" + url
    return url


# Debounce only exact same URL (not all YouTube pages — that blocked new searches).
# Longer window so Gemini double-fires of "open youtube" do not open many tabs.
_last_open_url: str = ""
_last_open_at: float = 0.0
_OPEN_DEBOUNCE_SEC = 10.0


def _want_new_browser(args: Optional[Dict[str, Any]]) -> bool:
    if not args:
        return False
    if args.get("new_window") is True or args.get("new") is True or args.get("new_tab") is True:
        return True
    for key in ("new_window", "new", "mode", "window", "open_mode", "target"):
        v = str(args.get(key) or "").strip().lower().replace("-", " ").replace("_", " ")
        if v in (
            "new",
            "new window",
            "newwindow",
            "new tab",
            "newtab",
            "true",
            "1",
            "yes",
            "open in new",
            "open new",
        ):
            return True
    return False


def _browser_is_running() -> bool:
    if platform.system() != "Windows":
        return False
    try:
        import psutil  # type: ignore[import-not-found]

        names = {img.lower().replace(".exe", "") for img in _BROWSER_IMAGES}
        for p in psutil.process_iter(["name"]):
            n = (p.info.get("name") or "").lower().replace(".exe", "")
            if n in names:
                return True
    except Exception:
        pass
    return False


def _focus_browser_for_url(url: str) -> bool:
    """Focus best browser window: prefer YouTube/title match, else any browser."""
    if platform.system() != "Windows":
        return _focus_default_browser()

    prefer_titles: list[str] = []
    low = url.lower()
    if "youtube.com" in low or "youtu.be" in low:
        prefer_titles.append("youtube")
    if "google.com" in low:
        prefer_titles.append("google")
    if "github.com" in low:
        prefer_titles.append("github")

    # Title-based focus first (YouTube tab already open)
    try:
        import win32con  # type: ignore[import-not-found]
        import win32gui  # type: ignore[import-not-found]

        matches: list[tuple[int, str]] = []

        def _enum(hwnd, _):  # type: ignore[no-untyped-def]
            try:
                if win32gui.IsWindowVisible(hwnd):
                    title = win32gui.GetWindowText(hwnd) or ""
                    if title.strip():
                        matches.append((hwnd, title))
            except Exception:
                pass
            return True

        win32gui.EnumWindows(_enum, None)

        def _try_focus(hwnd: int) -> bool:
            try:
                # Only restore when minimized — never ShowWindow on maximized/fullscreen
                # (SW_RESTORE/SW_SHOW can shrink Chrome/YouTube).
                if win32gui.IsIconic(hwnd):
                    win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
                try:
                    win32gui.SetForegroundWindow(hwnd)
                except Exception:
                    try:
                        import ctypes

                        user32 = ctypes.windll.user32
                        user32.keybd_event(0x12, 0, 0, 0)
                        user32.keybd_event(0x12, 0, 2, 0)
                        win32gui.SetForegroundWindow(hwnd)
                    except Exception:
                        return False
                return True
            except Exception:
                return False

        for pref in prefer_titles:
            for hwnd, title in matches:
                if pref in title.lower():
                    if _try_focus(hwnd):
                        return True

        # Any browser window by title keywords
        for kw in ("chrome", "edge", "firefox", "brave", "opera", "chromium"):
            for hwnd, title in matches:
                if kw in title.lower():
                    if _try_focus(hwnd):
                        return True
    except Exception:
        pass

    return _focus_default_browser()


def _focus_default_browser() -> bool:
    """Bring an already-open Chrome/Edge/Firefox window to the front if present."""
    try:
        from .tools_applications import _focus_running_by_image

        for image in _BROWSER_IMAGES:
            if _focus_running_by_image(image):
                return True
    except Exception:
        pass
    return False


def _set_clipboard_text(text: str) -> bool:
    try:
        import pyperclip  # type: ignore[import-not-found]

        pyperclip.copy(text)
        return True
    except Exception:
        pass
    if platform.system() == "Windows":
        try:
            # PowerShell Set-Clipboard is reliable without extra deps
            safe = text.replace("'", "''")
            subprocess.run(
                [
                    "powershell",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    f"Set-Clipboard -Value '{safe}'",
                ],
                capture_output=True,
                timeout=8,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            return True
        except Exception:
            return False
    return False


def _hotkey(*keys: str) -> bool:
    try:
        import pyautogui

        pyautogui.FAILSAFE = False
        pyautogui.hotkey(*keys)
        return True
    except Exception:
        pass
    if platform.system() == "Windows" and set(keys) <= {"ctrl", "l", "v", "t", "a"}:
        # Minimal ctypes fallback for Ctrl+L / Ctrl+V / Enter
        try:
            import ctypes

            user32 = ctypes.windll.user32
            KEYEVENTF_KEYUP = 0x0002
            vk_map = {
                "ctrl": 0x11,
                "l": 0x4C,
                "v": 0x56,
                "t": 0x54,
                "a": 0x41,
            }
            codes = [vk_map[k] for k in keys if k in vk_map]
            if not codes:
                return False
            for c in codes:
                user32.keybd_event(c, 0, 0, 0)
            time.sleep(0.03)
            for c in reversed(codes):
                user32.keybd_event(c, 0, KEYEVENTF_KEYUP, 0)
            return True
        except Exception:
            return False
    return False


def _press_enter() -> None:
    try:
        import pyautogui

        pyautogui.FAILSAFE = False
        pyautogui.press("enter")
        return
    except Exception:
        pass
    try:
        import ctypes

        VK_RETURN = 0x0D
        KEYEVENTF_KEYUP = 0x0002
        ctypes.windll.user32.keybd_event(VK_RETURN, 0, 0, 0)
        time.sleep(0.03)
        ctypes.windll.user32.keybd_event(VK_RETURN, 0, KEYEVENTF_KEYUP, 0)
    except Exception:
        pass


def _navigate_existing_browser_tab(url: str) -> bool:
    """Focus the open browser and load URL in the *current* tab (Ctrl+L → paste → Enter).

    This is how "search Motu Patlu on YouTube" reuses the YouTube tab instead of
    spawning a second one via webbrowser.open / start.
    """
    if platform.system() != "Windows":
        return False
    if not _browser_is_running():
        return False
    if not _focus_browser_for_url(url):
        return False
    time.sleep(0.28)
    if not _set_clipboard_text(url):
        return False
    time.sleep(0.08)
    # Address bar focus (Chrome/Edge/Firefox)
    if not _hotkey("ctrl", "l"):
        return False
    time.sleep(0.12)
    if not _hotkey("ctrl", "v"):
        return False
    time.sleep(0.08)
    _press_enter()
    time.sleep(0.15)
    return True


def _open_new_browser_tab(url: str) -> bool:
    """Open URL in a new tab of the existing browser (Ctrl+T then navigate)."""
    if platform.system() != "Windows" or not _browser_is_running():
        return False
    if not _focus_browser_for_url(url):
        return False
    time.sleep(0.25)
    if not _hotkey("ctrl", "t"):
        return False
    time.sleep(0.2)
    if not _set_clipboard_text(url):
        return False
    time.sleep(0.08)
    _hotkey("ctrl", "l")
    time.sleep(0.1)
    _hotkey("ctrl", "v")
    time.sleep(0.08)
    _press_enter()
    return True


def _open_url_via_os(url: str, *, new: int = 0) -> None:
    """Reliable OS open of the exact URL (never uses clipboard paste)."""
    if platform.system() == "Windows":
        # os.startfile hands the URL straight to the registered handler without
        # cmd.exe parsing, so metacharacters in the URL (& | " etc.) can never
        # become command injection. (The previous `start "" "{url}"` with
        # shell=True let a crafted URL break out of the quotes and run commands.)
        try:
            os.startfile(url)  # type: ignore[attr-defined]
            return
        except Exception as e:
            raise ToolError(f"Failed to open default browser for {url}: {e}") from e
    ok = webbrowser.open(url, new=new)
    if not ok:
        raise ToolError(f"Failed to open default browser for {url}.")


def open_url(url: str, *, new_window: bool = False, new_tab: bool = False) -> str:
    """Open a URL in the default browser; returns the resolved URL.

    Prefer reliable OS open of the exact URL so search never pastes a wrong link.
    Same-tab keyboard navigate is best-effort only (can race on clipboard/focus).
    new_tab=True / new_window=True open a fresh tab/window.
    """
    global _last_open_url, _last_open_at
    url = _normalize_url(url)
    now = time.time()
    # Exact-URL debounce only (allows new YouTube searches in the same tab)
    full_norm = url.lower().rstrip("/")
    last_full = (_last_open_url or "").lower().rstrip("/")
    if (
        not new_window
        and not new_tab
        and last_full
        and full_norm == last_full
        and (now - _last_open_at) < _OPEN_DEBOUNCE_SEC
    ):
        _focus_browser_for_url(url)
        return url

    _last_open_url = full_norm
    _last_open_at = now

    if new_window:
        _open_url_via_os(url, new=1)
        return url

    if new_tab:
        if _open_new_browser_tab(url):
            return url
        _open_url_via_os(url, new=0)
        return url

    # ALWAYS hand the OS the exact URL. Clipboard Ctrl+L → Ctrl+V races
    # frequently paste the wrong/old link ("error links" user report).
    # Same-tab keyboard navigate is intentionally disabled for reliability.
    _open_url_via_os(url, new=0)
    # Bring the browser to the foreground: opening into an already-running
    # browser adds a tab WITHOUT focusing the window, so "open YouTube" used to
    # leave the window hidden ("window not found"). Retry a few times in case
    # the browser was just launched and its window is still appearing.
    if platform.system() == "Windows":
        for _ in range(3):
            if _focus_browser_for_url(url):
                break
            time.sleep(0.45)
    return url


@register("openWebsite")
def open_website(args: Dict[str, Any]) -> Dict[str, Any]:
    name = args.get("name")
    url = args.get("url")
    new_window = _want_new_browser(args)
    new_tab = bool(args.get("new_tab") is True) or str(args.get("mode") or "").lower() in (
        "new tab",
        "newtab",
        "tab",
    )
    if name and not url:
        key = str(name).strip().lower()
        if key in SITE_URLS:
            url = SITE_URLS[key]
        else:
            # Treat the name itself as a domain if it looks like one.
            url = str(name)
    if not url and not name:
        raise ToolError("Provide 'name' (e.g. 'youtube') or 'url'.")
    resolved = open_url(url or str(name), new_window=new_window, new_tab=new_tab and not new_window)
    if new_window:
        msg = f"Opened {resolved} in a new browser window."
        mode = "new_window"
    elif new_tab:
        msg = f"Opened {resolved} in a new browser tab."
        mode = "new_tab"
    else:
        msg = f"Opened {resolved} in the existing browser tab (same tab when browser was already open)."
        mode = "same_tab"
    return {"result": msg, "url": resolved, "mode": mode}


# Expose for sibling modules (tools_search).
def _build_search_url(engine: str, query: str) -> str:
    q = quote(query)
    base = {
        "google": f"https://www.google.com/search?q={q}",
        "youtube": f"https://www.youtube.com/results?search_query={q}",
        "github": f"https://github.com/search?q={q}&type=repositories",
        "chatgpt": f"https://www.google.com/search?q={q}",  # no search API
        "duckduckgo": f"https://duckduckgo.com/?q={q}",
        "bing": f"https://www.bing.com/search?q={q}",
        "amazon": f"https://www.amazon.com/s?k={q}",
        "wikipedia": f"https://en.wikipedia.org/w/index.php?search={q}",
    }
    if engine not in base:
        raise ToolError(
            f"Unsupported search engine '{engine}'. Choose from "
            f"{', '.join(sorted(base))}."
        )
    return base[engine]


__all__ = ["open_website", "open_url", "SITE_URLS", "_build_search_url"]
