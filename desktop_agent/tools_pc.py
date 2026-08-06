"""
PC control: system volume and (gated) power actions.

Volume:
  Uses pycaw + comtypes for precise scalar control on Windows when available,
  with a graceful media-key fallback (VK_VOLUME_UP/DOWN/MUTE via keybd_event)
  through pyautogui.

Power:
  shutdown / restart / sleep / lock are DANGEROUS and require the two-step
  confirmation flow (tools_confirmation). `executePowerAction` consumes the
  token before running anything destructive.
"""

from __future__ import annotations

import ctypes
import os
import platform
import subprocess
import time
from typing import Any, Dict, Optional

from .registry import ToolError, register
from .tools_confirmation import ACTION_LABEL, consume_token


# --- Volume backend (lazy) ----------------------------------------------------

_vol_backend = None  # one of "pycaw" | "media_keys" | None


def _init_pycaw():
    try:
        from ctypes import cast, POINTER

        import comtypes  # noqa: F401
        from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume

        devices = AudioUtilities.GetSpeakers()
        interface = devices.Activate(IAudioEndpointVolume._iid_, comtypes.CLSCTX_ALL, None)
        volume = cast(interface, POINTER(IAudioEndpointVolume))
        return volume
    except Exception:
        return None


def _get_volume_interface():
    global _vol_backend
    if _vol_backend is None:
        if platform.system() != "Windows":
            _vol_backend = "media_keys"
        else:
            iface = _init_pycaw()
            _vol_backend = "pycaw" if iface is not None else "media_keys"
            if _vol_backend == "pycaw":
                _VOL_CACHE["iface"] = iface
    return _vol_backend


_VOL_CACHE: Dict[str, Any] = {}


def _current_volume() -> float:
    """Returns current master volume in 0.0..1.0 (best effort)."""
    backend = _get_volume_interface()
    if backend == "pycaw":
        iface = _VOL_CACHE.get("iface") or _init_pycaw()
        if iface is not None:
            _VOL_CACHE["iface"] = iface
            try:
                return float(iface.GetMasterVolumeLevelScalar())
            except Exception:
                pass
    return 0.5  # unknown


def _set_volume_scalar(value: float) -> None:
    value = max(0.0, min(1.0, float(value)))
    backend = _get_volume_interface()
    if backend == "pycaw":
        iface = _VOL_CACHE.get("iface") or _init_pycaw()
        if iface is not None:
            _VOL_CACHE["iface"] = iface
            try:
                iface.SetMasterVolumeLevelScalar(value, None)
                return
            except Exception:
                pass  # fall through to media keys
    _set_volume_via_keys(value)


# VK codes for media keys
VK_VOLUME_MUTE = 0xAD
VK_VOLUME_UP = 0xAF
VK_VOLUME_DOWN = 0xAE
VK_MEDIA_NEXT_TRACK = 0xB0
VK_MEDIA_PREV_TRACK = 0xB1
VK_MEDIA_STOP = 0xB2
VK_MEDIA_PLAY_PAUSE = 0xB3
KEYEVENTF_KEYUP = 0x0002

# pyautogui key names for media / YouTube shortcuts
_VK_TO_PYAUTOGUI = {
    VK_VOLUME_UP: "volumeup",
    VK_VOLUME_DOWN: "volumedown",
    VK_VOLUME_MUTE: "volumemute",
    VK_MEDIA_PLAY_PAUSE: "playpause",
    VK_MEDIA_NEXT_TRACK: "nexttrack",
    VK_MEDIA_PREV_TRACK: "prevtrack",
    VK_MEDIA_STOP: "stop",
}


def _press_vk(vk: int) -> None:
    try:
        ctypes.windll.user32.keybd_event(vk, 0, 0, 0)
        time.sleep(0.03)
        ctypes.windll.user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)
    except Exception:
        # pyautogui fallback
        try:
            import pyautogui

            name = _VK_TO_PYAUTOGUI.get(vk)
            if name:
                pyautogui.press(name)
        except Exception:
            pass


def _press_char_key(key: str) -> None:
    """Press a character / named key (YouTube shortcuts: k, m, f, l, j, esc)."""
    # Normalize aliases pyautogui understands
    aliases = {
        "escape": "esc",
        "return": "enter",
    }
    key = aliases.get(key.lower(), key)
    try:
        import pyautogui

        pyautogui.press(key)
    except Exception:
        # Minimal Win32 fallback for single ASCII letters / common keys
        try:
            vk = None
            if len(key) == 1:
                vk = ctypes.windll.user32.VkKeyScanW(ord(key)) & 0xFF
            elif key in ("space",):
                vk = 0x20
            elif key in ("right",):
                vk = 0x27
            elif key in ("left",):
                vk = 0x25
            elif key in ("esc", "escape"):
                vk = 0x1B
            if vk:
                _press_vk(vk)
        except Exception:
            pass


def _focus_media_window() -> bool:
    """
    Bring a YouTube / browser window to the foreground so keyboard shortcuts
    (k/m/f/space) reach the player. Best-effort — media keys still work without it.
    """
    if platform.system() != "Windows":
        return False
    try:
        import win32gui
        import win32con
    except Exception:
        return False

    # Prefer YouTube title first, then common browsers.
    preferences = (
        "youtube",
        "chrome",
        "edge",
        "brave",
        "firefox",
        "opera",
        "msedge",
    )
    matches: list = []

    def _enum(hwnd, _):
        if win32gui.IsWindowVisible(hwnd):
            title = win32gui.GetWindowText(hwnd) or ""
            if title:
                matches.append((hwnd, title))
        return True

    try:
        win32gui.EnumWindows(_enum, None)
    except Exception:
        return False

    hwnd = None
    for pref in preferences:
        for h, title in matches:
            if pref in title.lower():
                hwnd = h
                break
        if hwnd:
            break

    if not hwnd:
        return False

    try:
        # CRITICAL: Never SW_RESTORE / SW_SHOW on a non-minimized window.
        # ShowWindow(SW_RESTORE) on maximized/fullscreen Chrome/YouTube shrinks
        # the window (user-reported "scroll makes browser smaller" bug).
        # ShowWindow(SW_SHOW) can also exit true fullscreen on some systems.
        # Only restore when actually minimized; otherwise only SetForegroundWindow.
        if win32gui.IsIconic(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
            time.sleep(0.08)
        try:
            win32gui.SetForegroundWindow(hwnd)
        except Exception:
            # Alt-key trick to allow SetForegroundWindow when Windows blocks it
            try:
                import ctypes

                user32 = ctypes.windll.user32
                user32.keybd_event(0x12, 0, 0, 0)  # ALT down
                user32.keybd_event(0x12, 0, 2, 0)  # ALT up
                win32gui.SetForegroundWindow(hwnd)
            except Exception:
                pass
        time.sleep(0.10)
        return True
    except Exception:
        return False


def _set_volume_via_keys(target: float) -> None:
    """Approximate target volume by stepping media keys. Coarse but reliable."""
    current = _current_volume()
    diff = target - current
    # ~2% per keypress is a reasonable Windows approximation.
    steps = int(abs(diff) / 0.02) + 1
    vk = VK_VOLUME_UP if diff > 0 else VK_VOLUME_DOWN
    for _ in range(min(steps, 50)):
        _press_vk(vk)
        time.sleep(0.01)


def _toggle_mute_pycaw() -> bool:
    iface = _VOL_CACHE.get("iface")
    if iface is None:
        iface = _init_pycaw()
    if iface is not None:
        _VOL_CACHE["iface"] = iface
        try:
            iface.SetMute(1 if not bool(iface.GetMute()) else 0, None)
            return bool(iface.GetMute())
        except Exception:
            pass
    _press_vk(VK_VOLUME_MUTE)
    time.sleep(0.05)
    return False


# --- Tool handlers -----------------------------------------------------------


@register("volumeUp")
def volume_up(args: Dict[str, Any]) -> Dict[str, Any]:
    step = float(args.get("amount", 0.10))
    new = min(1.0, _current_volume() + step)
    _set_volume_scalar(new)
    return {"result": f"Volume increased to {int(new * 100)}%."}


@register("volumeDown")
def volume_down(args: Dict[str, Any]) -> Dict[str, Any]:
    step = float(args.get("amount", 0.10))
    new = max(0.0, _current_volume() - step)
    _set_volume_scalar(new)
    return {"result": f"Volume decreased to {int(new * 100)}%."}


@register("setVolume")
def set_volume(args: Dict[str, Any]) -> Dict[str, Any]:
    if "percent" in args:
        pct = float(args["percent"])
    elif "level" in args:
        pct = float(args["level"])
    else:
        raise ToolError("Parameter 'percent' (0-100) is required.")
    pct = max(0.0, min(100.0, pct))
    _set_volume_scalar(pct / 100.0)
    return {"result": f"Volume set to {int(pct)}%."}


@register("muteToggle")
def mute_toggle(args: Dict[str, Any]) -> Dict[str, Any]:
    muted = _toggle_mute_pycaw()
    return {"result": "Muted." if muted else "Unmuted."}


# --- Browser / YouTube media control (real system browser) -------------------
# Videos opened via playYouTube/openWebsite land in Chrome/Edge, NOT the
# in-built iframe. Pause/resume/play must use OS media keys + YouTube shortcuts.


@register("browserMediaControl")
def browser_media_control(args: Dict[str, Any]) -> Dict[str, Any]:
    """
    Control media in the user's real browser (YouTube in Chrome/Edge).

    Uses Windows Media Session keys (works without focus for play/pause) and
    focuses the YouTube/browser window for YouTube keyboard shortcuts when needed.
    """
    raw = str(args.get("action") or "").strip().lower()
    # Common voice aliases
    aliases = {
        "resume": "play",
        "unpause": "play",
        "continue": "play",
        "start": "play",
        "stop": "pause",
        "halt": "pause",
        "vol": "volume",
        "set_volume": "volume",
        "setvolume": "volume",
        "full_screen": "fullscreen",
        "full-screen": "fullscreen",
        "fs": "fullscreen",
        "exitfullscreen": "exit_fullscreen",
        "exit-fullscreen": "exit_fullscreen",
        "unfullscreen": "exit_fullscreen",
        "skip_forward": "skip",
        "forward": "skip",
        "seek": "skip",
        "next": "next",
        "previous": "previous",
        "prev": "previous",
        "back": "previous",
    }
    action = aliases.get(raw, raw)
    value = args.get("value")

    if not action:
        raise ToolError(
            "Parameter 'action' is required. "
            "Use: play, pause, resume, mute, unmute, volume, skip, next, previous, fullscreen."
        )

    # Play uses PLAY_PAUSE toggle; pause/stop uses MEDIA_STOP so we do NOT
    # accidentally resume a video the user already paused (toggle would restart it).
    if action == "play":
        _press_vk(VK_MEDIA_PLAY_PAUSE)
        return {
            "result": "Video play/resume key sent. Do not call play again unless the user asks.",
            "action": action,
        }

    if action in ("pause", "stop"):
        # STOP is not a toggle — safer than PLAY_PAUSE for "pause" after manual stop.
        _press_vk(VK_MEDIA_STOP)
        return {
            "result": "Video stop/pause key sent. Do NOT auto-resume or call play unless the user asks.",
            "action": "pause",
        }

    if action == "next":
        _press_vk(VK_MEDIA_NEXT_TRACK)
        return {"result": "Next track / next video.", "action": action}

    if action == "volume":
        if value is None:
            raise ToolError("Volume action requires 'value' (0-100).")
        pct = max(0.0, min(100.0, float(value)))
        _set_volume_scalar(pct / 100.0)
        return {"result": f"System volume set to {int(pct)}%.", "action": action}

    # Actions that benefit from focusing the YouTube/browser window
    focused = _focus_media_window()

    if action == "mute":
        if focused:
            _press_char_key("m")  # YouTube mute toggle
            return {"result": "Toggled mute on the YouTube player.", "action": action}
        _press_vk(VK_VOLUME_MUTE)
        return {"result": "Toggled system mute (browser window not found).", "action": action}

    if action == "unmute":
        if focused:
            # YouTube 'm' toggles; if already unmuted this may mute — best available.
            _press_char_key("m")
            return {"result": "Toggled mute on the YouTube player (unmute request).", "action": action}
        _press_vk(VK_VOLUME_MUTE)
        return {"result": "Toggled system mute (unmute request).", "action": action}

    if action == "skip":
        if focused:
            _press_char_key("l")  # YouTube +10s
            return {"result": "Skipped forward about 10 seconds on YouTube.", "action": action}
        _press_vk(VK_MEDIA_NEXT_TRACK)
        return {"result": "Sent next-track media key (skip).", "action": action}

    if action == "previous":
        if focused:
            _press_char_key("j")  # YouTube -10s
            return {"result": "Rewound about 10 seconds on YouTube.", "action": action}
        _press_vk(VK_MEDIA_PREV_TRACK)
        return {"result": "Previous track media key sent.", "action": action}

    if action == "fullscreen":
        if focused:
            _press_char_key("f")
            return {"result": "Toggled fullscreen on YouTube.", "action": action}
        raise ToolError("Could not find a YouTube/browser window to fullscreen.")

    if action == "exit_fullscreen":
        if focused:
            _press_char_key("esc")
            return {"result": "Exited fullscreen.", "action": action}
        raise ToolError("Could not find a browser window to exit fullscreen.")

    raise ToolError(
        f"Unknown media action '{raw}'. "
        "Valid: play, pause, resume, mute, unmute, volume, skip, next, previous, fullscreen, exit_fullscreen."
    )


@register("browserScroll")
def browser_scroll_real(args: Dict[str, Any]) -> Dict[str, Any]:
    """
    Scroll the user's REAL browser (Chrome/Edge YouTube, etc.).

    Mouse-wheel style only — same feel as rolling the wheel a few notches.
    Does NOT PageDown/PageUp the whole viewport (that felt like "full page jump").
    Works without the control word (same as browserMediaControl).
    """
    direction = str(args.get("direction") or args.get("dir") or "down").strip().lower()
    # amount = wheel notches (default 3 ≈ one short mouse-wheel flick)
    raw_amount = args.get("amount", args.get("clicks", args.get("distance", 3)))
    try:
        amount = int(raw_amount)
    except (TypeError, ValueError):
        amount = 3
    # If caller passed pixels (e.g. 300), map gently to wheel notches
    if amount >= 50:
        amount = max(2, min(8, amount // 120))
    # Cap low so voice "scroll" never flies past the whole page
    amount = max(1, min(8, abs(amount)))

    aliases_down = ("down", "south", "bottom", "next", "forward", "more")
    aliases_up = ("up", "north", "top", "back", "previous", "prev")
    if direction in aliases_up:
        direction = "up"
    elif direction in aliases_down or direction in ("", "scroll"):
        direction = "down"
    elif direction not in ("left", "right"):
        direction = "down"

    # Focus without resizing (see _focus_media_window — no SW_RESTORE on max/fs).
    focused = _focus_media_window()
    time.sleep(0.08)

    try:
        import pyautogui

        pyautogui.FAILSAFE = False
        # Put cursor over the browser content so the wheel hits YouTube, not Bikli.
        # Use setpos (instant) — animated moveTo can feel like a window resize.
        try:
            sw, sh = pyautogui.size()
            pyautogui.moveTo(int(sw * 0.55), int(sh * 0.55), duration=0)
            time.sleep(0.03)
        except Exception:
            pass

        # Real mouse-wheel feel: several small notches with a tiny gap
        # (one big pyautogui.scroll(N) can jump too hard on some systems)
        step = 1 if direction == "up" else -1
        if direction in ("up", "down"):
            for i in range(amount):
                pyautogui.scroll(step)
                if i < amount - 1:
                    time.sleep(0.035)
        elif direction == "left":
            try:
                for i in range(amount):
                    pyautogui.hscroll(-1)
                    if i < amount - 1:
                        time.sleep(0.035)
            except Exception:
                pyautogui.keyDown("shift")
                try:
                    for i in range(amount):
                        pyautogui.scroll(-1)
                        if i < amount - 1:
                            time.sleep(0.035)
                finally:
                    pyautogui.keyUp("shift")
        else:  # right
            try:
                for i in range(amount):
                    pyautogui.hscroll(1)
                    if i < amount - 1:
                        time.sleep(0.035)
            except Exception:
                pyautogui.keyDown("shift")
                try:
                    for i in range(amount):
                        pyautogui.scroll(1)
                        if i < amount - 1:
                            time.sleep(0.035)
                finally:
                    pyautogui.keyUp("shift")
    except Exception as e:
        # Soft keyboard nudge only if wheel completely fails — Arrow keys, not PageDown
        try:
            import pyautogui as pag

            pag.FAILSAFE = False
            if direction == "up":
                key = "up"
            elif direction == "down":
                key = "down"
            elif direction == "left":
                key = "left"
            else:
                key = "right"
            # ~3 arrow presses ≈ one small wheel flick, not a full page
            for _ in range(max(2, min(6, amount * 2))):
                pag.press(key)
                time.sleep(0.03)
        except Exception as e2:
            raise ToolError(f"Could not scroll browser: {e}; fallback also failed: {e2}") from e2

    where = "YouTube/browser window" if focused else "active window (browser not found by title)"
    return {
        "result": f"Scrolled {direction} a little (mouse wheel ×{amount}) on {where}.",
        "direction": direction,
        "amount": amount,
        "focused": focused,
        "style": "mouse-wheel",
    }


# --- Gated power actions -----------------------------------------------------


def _run_power(action: str) -> str:
    """Execute the actual OS power command. Caller must have confirmed first."""
    system = platform.system()
    if action == "lock":
        if system == "Windows":
            ctypes.windll.user32.LockWorkStation()
            return "Computer locked."
        return "Lock is only configured for Windows."
    if action == "sleep":
        if system == "Windows":
            # suspend: standby
            os.system("rundll32.exe powrprof.dll,SetSuspendState 0,1,0")
            return "Computer going to sleep."
        subprocess.run(["systemctl", "suspend"], check=False)
        return "Computer going to sleep."
    if action == "restart":
        if system == "Windows":
            subprocess.run(["shutdown", "/r", "/t", "5"], check=False)
            return "Computer restarting in 5 seconds."
        subprocess.run(["shutdown", "-r", "now"], check=False)
        return "Computer restarting."
    if action == "shutdown":
        if system == "Windows":
            subprocess.run(["shutdown", "/s", "/t", "10"], check=False)
            return "Computer shutting down in 10 seconds."
        subprocess.run(["shutdown", "-h", "now"], check=False)
        return "Computer shutting down."
    raise ToolError(f"Unknown power action '{action}'.")


@register("executePowerAction")
def execute_power_action(args: Dict[str, Any]) -> Dict[str, Any]:
    action = (args.get("action") or "").strip().lower()
    token: Optional[str] = args.get("execute_token")

    # Locking is comparatively safe but still gated per the user's spec
    # (all four dangerous actions require confirmation).
    from .tools_confirmation import DANGEROUS_ACTIONS

    if action not in DANGEROUS_ACTIONS:
        raise ToolError(
            f"Unknown power action '{action}'. Valid: {', '.join(sorted(DANGEROUS_ACTIONS))}."
        )

    consume_token(action, token)  # raises if invalid/missing/expired
    msg = _run_power(action)
    return {"result": msg, "action": action}


# Helper for shell-level abort of a pending Windows shutdown/restart timer.
@register("_cancelPowerTimer")
def _cancel(args: Dict[str, Any]) -> Dict[str, Any]:  # pragma: no cover
    subprocess.run(["shutdown", "/a"], check=False)
    return {"result": "Cancelled pending shutdown/restart timer."}


# --- Brightness control ------------------------------------------------------
# Uses screen_brightness_control when available (Windows/macOS). Degrades to a
# WMI / powershell fallback on Windows, and to a clear "unsupported" message
# otherwise. Lazy import so the agent still boots if the optional dep is missing.

_sbc = None  # cached module handle

def _brightness_backend():
    """Return the screen_brightness_control module, or None if unavailable."""
    global _sbc
    if _sbc is not None:
        return _sbc if _sbc is not False else None
    try:
        import screen_brightness_control as sbc  # type: ignore[import-not-found]

        _sbc = sbc
        return sbc
    except Exception:  # noqa: BLE001 - optional dependency
        _sbc = False
        return None


def _current_brightness() -> int:
    sbc = _brightness_backend()
    if sbc is not None:
        try:
            vals = sbc.get_brightness()
            if vals:
                return int(round(sum(vals) / len(vals)))
        except Exception:  # noqa: BLE001
            pass
    # Windows WMI fallback via PowerShell (does not need extra deps).
    if platform.system() == "Windows":
        try:
            out = subprocess.check_output(
                [
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    "(Get-WmiObject -Namespace root/WMI "
                    "-Class WmiMonitorBrightness).WmiCurrentBrightness",
                ],
                text=True,
                timeout=8,
            ).strip()
            if out:
                return int(out.splitlines()[-1].strip())
        except Exception:  # noqa: BLE001
            pass
    raise ToolError("Brightness control is not supported on this device.")


def _set_brightness(pct: float) -> int:
    pct = max(0.0, min(100.0, pct))
    sbc = _brightness_backend()
    if sbc is not None:
        try:
            sbc.set_brightness(int(pct))
            return int(pct)
        except Exception:  # noqa: BLE001
            pass
    if platform.system() == "Windows":
        # WMI setter requires a method call; shell out to PowerShell.
        try:
            subprocess.run(
                [
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    (
                        "$m = Get-WmiObject -Namespace root/WMI "
                        "-Class WmiMonitorBrightnessMethods; "
                        f"$m.WmiSetBrightness(1,{int(pct)})"
                    ),
                ],
                check=False,
                timeout=8,
            )
            return int(pct)
        except Exception as e:  # noqa: BLE001
            raise ToolError(f"Could not set brightness: {e}") from e
    raise ToolError("Brightness control is not supported on this device.")


@register("brightnessUp")
def brightness_up(args: Dict[str, Any]) -> Dict[str, Any]:
    step = float(args.get("amount", 10))
    current = _current_brightness()
    new = _set_brightness(current + step)
    return {"result": f"Brightness increased to {new}%.", "brightness": new}


@register("brightnessDown")
def brightness_down(args: Dict[str, Any]) -> Dict[str, Any]:
    step = float(args.get("amount", 10))
    current = _current_brightness()
    new = _set_brightness(current - step)
    return {"result": f"Brightness decreased to {new}%.", "brightness": new}


@register("setBrightness")
def set_brightness(args: Dict[str, Any]) -> Dict[str, Any]:
    if "percent" in args:
        pct = float(args["percent"])
    elif "level" in args:
        pct = float(args["level"])
    else:
        raise ToolError("Parameter 'percent' (0-100) is required.")
    new = _set_brightness(pct)
    return {"result": f"Brightness set to {new}%.", "brightness": new}


__all__ = [
    "volume_up",
    "volume_down",
    "set_volume",
    "mute_toggle",
    "browser_media_control",
    "execute_power_action",
    "ACTION_LABEL",
    "brightness_up",
    "brightness_down",
    "set_brightness",
]
