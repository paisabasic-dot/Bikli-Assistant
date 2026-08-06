"""
Full desktop cursor + keyboard control (pyautogui / Win32).

These tools move the real mouse, click, drag, scroll, and type on the user's
PC. They are gated by computer-control mode (tools_control.require_control).
Say "control" to unlock; "stop control" to lock again.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional, Tuple

from .registry import ToolError, register
from .tools_control import require_control

# Fail-safe: moving mouse to a corner will NOT abort (we control the mouse ourselves).
_PYAUTO_READY = False


def _pag():
    """Lazy-import pyautogui with safe defaults."""
    global _PYAUTO_READY
    try:
        import pyautogui
    except ImportError as e:
        raise ToolError(
            "pyautogui is not installed. Install desktop agent requirements to use cursor control."
        ) from e
    if not _PYAUTO_READY:
        pyautogui.FAILSAFE = False
        pyautogui.PAUSE = 0.03
        _PYAUTO_READY = True
    return pyautogui


def _screen_size() -> Tuple[int, int]:
    pag = _pag()
    w, h = pag.size()
    return int(w), int(h)


def _clamp_xy(x: float, y: float) -> Tuple[int, int]:
    w, h = _screen_size()
    xi = max(0, min(w - 1, int(round(x))))
    yi = max(0, min(h - 1, int(round(y))))
    return xi, yi


def _parse_button(raw: Any) -> str:
    b = str(raw or "left").strip().lower()
    aliases = {
        "l": "left",
        "left": "left",
        "primary": "left",
        "r": "right",
        "right": "right",
        "secondary": "right",
        "m": "middle",
        "middle": "middle",
        "wheel": "middle",
    }
    if b not in aliases:
        raise ToolError(f"Unknown mouse button '{raw}'. Use left, right, or middle.")
    return aliases[b]


@register("getScreenSize")
def get_screen_size(args: Dict[str, Any]) -> Dict[str, Any]:
    require_control("getScreenSize")
    w, h = _screen_size()
    return {
        "result": f"Screen size is {w}x{h} pixels.",
        "width": w,
        "height": h,
    }


@register("getMousePosition")
def get_mouse_position(args: Dict[str, Any]) -> Dict[str, Any]:
    require_control("getMousePosition")
    pag = _pag()
    x, y = pag.position()
    return {
        "result": f"Mouse is at ({int(x)}, {int(y)}).",
        "x": int(x),
        "y": int(y),
    }


@register("moveMouse")
def move_mouse(args: Dict[str, Any]) -> Dict[str, Any]:
    """
    Move the system cursor.
    Absolute: x, y
    Relative: dx, dy  (or relative=true with x,y as deltas)
    Optional duration seconds for smooth move.
    """
    require_control("moveMouse")
    pag = _pag()
    duration = float(args.get("duration", 0.2) or 0)
    duration = max(0.0, min(5.0, duration))

    relative = bool(args.get("relative", False))
    if "dx" in args or "dy" in args:
        relative = True
        dx = float(args.get("dx", 0) or 0)
        dy = float(args.get("dy", 0) or 0)
        cx, cy = pag.position()
        x, y = _clamp_xy(cx + dx, cy + dy)
    elif relative:
        dx = float(args.get("x", 0) or 0)
        dy = float(args.get("y", 0) or 0)
        cx, cy = pag.position()
        x, y = _clamp_xy(cx + dx, cy + dy)
    else:
        if "x" not in args or "y" not in args:
            raise ToolError("moveMouse requires x and y (or dx/dy for relative move).")
        x, y = _clamp_xy(float(args["x"]), float(args["y"]))

    pag.moveTo(x, y, duration=duration)
    return {
        "result": f"Moved mouse to ({x}, {y}).",
        "x": x,
        "y": y,
    }


@register("clickMouse")
def click_mouse(args: Dict[str, Any]) -> Dict[str, Any]:
    """
    Click at current position, or at x,y if provided.
    button: left|right|middle, clicks: 1|2, optional move duration.
    """
    require_control("clickMouse")
    pag = _pag()
    button = _parse_button(args.get("button", "left"))
    clicks = int(args.get("clicks", 1) or 1)
    clicks = max(1, min(5, clicks))
    duration = float(args.get("duration", 0.15) or 0)
    duration = max(0.0, min(3.0, duration))

    if "x" in args and "y" in args:
        x, y = _clamp_xy(float(args["x"]), float(args["y"]))
        pag.click(x=x, y=y, clicks=clicks, button=button, duration=duration)
        where = f"at ({x}, {y})"
    else:
        x, y = pag.position()
        pag.click(clicks=clicks, button=button)
        where = f"at current position ({int(x)}, {int(y)})"

    label = "double-clicked" if clicks == 2 else ("clicked" if clicks == 1 else f"{clicks}-clicked")
    return {
        "result": f"{button.capitalize()} {label} {where}.",
        "x": int(x),
        "y": int(y),
        "button": button,
        "clicks": clicks,
    }


@register("doubleClick")
def double_click(args: Dict[str, Any]) -> Dict[str, Any]:
    args = dict(args or {})
    args["clicks"] = 2
    args.setdefault("button", "left")
    require_control("doubleClick")
    return click_mouse(args)


@register("rightClick")
def right_click(args: Dict[str, Any]) -> Dict[str, Any]:
    args = dict(args or {})
    args["button"] = "right"
    args.setdefault("clicks", 1)
    require_control("rightClick")
    return click_mouse(args)


@register("dragMouse")
def drag_mouse(args: Dict[str, Any]) -> Dict[str, Any]:
    """
    Drag from (x,y) or current position to (to_x, to_y) / (dx, dy).
    """
    require_control("dragMouse")
    pag = _pag()
    duration = float(args.get("duration", 0.35) or 0.35)
    duration = max(0.05, min(5.0, duration))
    button = _parse_button(args.get("button", "left"))

    if "x" in args and "y" in args:
        sx, sy = _clamp_xy(float(args["x"]), float(args["y"]))
        pag.moveTo(sx, sy, duration=0.1)
    else:
        sx, sy = pag.position()
        sx, sy = int(sx), int(sy)

    if "to_x" in args and "to_y" in args:
        ex, ey = _clamp_xy(float(args["to_x"]), float(args["to_y"]))
    elif "dx" in args or "dy" in args:
        ex, ey = _clamp_xy(sx + float(args.get("dx", 0) or 0), sy + float(args.get("dy", 0) or 0))
    else:
        raise ToolError("dragMouse requires to_x/to_y or dx/dy.")

    pag.dragTo(ex, ey, duration=duration, button=button)
    return {
        "result": f"Dragged from ({sx}, {sy}) to ({ex}, {ey}) with {button} button.",
        "from": {"x": sx, "y": sy},
        "to": {"x": ex, "y": ey},
        "button": button,
    }


@register("scrollMouse")
def scroll_mouse(args: Dict[str, Any]) -> Dict[str, Any]:
    """
    Scroll vertically (positive = up, negative = down) and/or horizontally.
    amount: clicks (default 3). direction: up|down|left|right.
    """
    require_control("scrollMouse")
    pag = _pag()

    if "x" in args and "y" in args:
        x, y = _clamp_xy(float(args["x"]), float(args["y"]))
        pag.moveTo(x, y, duration=0.1)

    amount = int(args.get("amount", args.get("clicks", 3)) or 3)
    amount = max(1, min(50, abs(amount)))
    direction = str(args.get("direction", "down") or "down").strip().lower()

    # pyautogui.scroll: positive = up
    if direction in ("up", "north"):
        pag.scroll(amount)
        label = f"up by {amount}"
    elif direction in ("down", "south"):
        pag.scroll(-amount)
        label = f"down by {amount}"
    elif direction in ("left", "west"):
        try:
            pag.hscroll(-amount)
        except Exception:
            # Fallback: shift+scroll on some systems
            pag.keyDown("shift")
            pag.scroll(-amount)
            pag.keyUp("shift")
        label = f"left by {amount}"
    elif direction in ("right", "east"):
        try:
            pag.hscroll(amount)
        except Exception:
            pag.keyDown("shift")
            pag.scroll(amount)
            pag.keyUp("shift")
        label = f"right by {amount}"
    else:
        # Treat amount as signed vertical scroll if no valid direction
        signed = int(args.get("amount", -3) or -3)
        pag.scroll(signed)
        label = f"by {signed} (signed)"

    return {"result": f"Scrolled {label}.", "direction": direction, "amount": amount}


@register("typeText")
def type_text(args: Dict[str, Any]) -> Dict[str, Any]:
    """
    Type text with the keyboard at the current focus.
    Prefer clipboard paste for long/unicode text (more reliable on Windows).
    """
    require_control("typeText")
    text = args.get("text")
    if text is None:
        raise ToolError("Parameter 'text' is required.")
    text = str(text)
    if not text:
        raise ToolError("Parameter 'text' cannot be empty.")

    interval = float(args.get("interval", 0.02) or 0.02)
    interval = max(0.0, min(0.2, interval))
    use_paste = bool(args.get("paste", len(text) > 40 or any(ord(c) > 127 for c in text)))

    pag = _pag()
    if use_paste:
        try:
            import pyperclip

            old = None
            try:
                old = pyperclip.paste()
            except Exception:
                old = None
            pyperclip.copy(text)
            time.sleep(0.05)
            pag.hotkey("ctrl", "v")
            time.sleep(0.05)
            if old is not None:
                try:
                    pyperclip.copy(old)
                except Exception:
                    pass
            return {
                "result": f"Pasted {len(text)} character(s) via clipboard.",
                "length": len(text),
                "method": "paste",
            }
        except Exception:
            pass  # fall through to typewrite

    # typewrite only handles basic ASCII reliably
    try:
        pag.typewrite(text, interval=interval)
    except Exception as e:
        raise ToolError(f"Could not type text: {e}") from e
    return {
        "result": f"Typed {len(text)} character(s).",
        "length": len(text),
        "method": "typewrite",
    }


@register("pressKey")
def press_key(args: Dict[str, Any]) -> Dict[str, Any]:
    """Press a single key or a sequence of keys (enter, tab, esc, a, f5, …)."""
    require_control("pressKey")
    pag = _pag()
    key = args.get("key") or args.get("keys")
    if not key:
        raise ToolError("Parameter 'key' is required (e.g. 'enter', 'tab', 'esc', 'f5').")

    presses = int(args.get("presses", 1) or 1)
    presses = max(1, min(20, presses))
    interval = float(args.get("interval", 0.05) or 0.05)

    if isinstance(key, list):
        keys = [str(k).lower() for k in key]
        for _ in range(presses):
            for k in keys:
                pag.press(k)
                time.sleep(interval)
        return {"result": f"Pressed keys: {', '.join(keys)} (x{presses}).", "keys": keys}

    key_s = str(key).strip().lower()
    # Allow "ctrl+s" style as pressKey convenience → hotkey
    if "+" in key_s and not key_s.startswith("+"):
        parts = [p.strip() for p in key_s.split("+") if p.strip()]
        for _ in range(presses):
            pag.hotkey(*parts)
            time.sleep(interval)
        return {"result": f"Hotkey pressed: {'+'.join(parts)} (x{presses}).", "keys": parts}

    pag.press(key_s, presses=presses, interval=interval)
    return {"result": f"Pressed key '{key_s}' x{presses}.", "key": key_s, "presses": presses}


@register("hotkey")
def hotkey(args: Dict[str, Any]) -> Dict[str, Any]:
    """
    Press a keyboard shortcut, e.g. keys=['ctrl','c'] or keys='ctrl+v'.
    """
    require_control("hotkey")
    pag = _pag()
    raw = args.get("keys") or args.get("key") or args.get("combo")
    if not raw:
        raise ToolError("Parameter 'keys' is required (e.g. ['ctrl','c'] or 'ctrl+s').")

    if isinstance(raw, str):
        parts = [p.strip().lower() for p in raw.replace("-", "+").split("+") if p.strip()]
    elif isinstance(raw, list):
        parts = [str(p).strip().lower() for p in raw if str(p).strip()]
    else:
        raise ToolError("keys must be a string like 'ctrl+s' or a list like ['ctrl','s'].")

    if not parts:
        raise ToolError("No keys provided.")

    presses = int(args.get("presses", 1) or 1)
    presses = max(1, min(10, presses))
    for _ in range(presses):
        pag.hotkey(*parts)
        time.sleep(0.05)

    combo = "+".join(parts)
    return {"result": f"Hotkey {combo} pressed" + (f" x{presses}." if presses > 1 else "."), "keys": parts}


@register("mouseMoveAndClick")
def mouse_move_and_click(args: Dict[str, Any]) -> Dict[str, Any]:
    """Convenience: move to x,y then click (default left single click)."""
    require_control("mouseMoveAndClick")
    if "x" not in args or "y" not in args:
        raise ToolError("mouseMoveAndClick requires x and y.")
    move_mouse(
        {
            "x": args["x"],
            "y": args["y"],
            "duration": args.get("duration", 0.2),
        }
    )
    return click_mouse(
        {
            "button": args.get("button", "left"),
            "clicks": args.get("clicks", 1),
        }
    )


__all__ = [
    "get_screen_size",
    "get_mouse_position",
    "move_mouse",
    "click_mouse",
    "double_click",
    "right_click",
    "drag_mouse",
    "scroll_mouse",
    "type_text",
    "press_key",
    "hotkey",
    "mouse_move_and_click",
]
