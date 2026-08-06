"""
Computer control mode gate.

Full PC control (cursor, keyboard, apps, files, windows, power, etc.) is
LOCKED by default. The user must speak the control word (default: "control")
so Bikli can call enableComputerControl. Until then, privileged tools refuse.

Safe tools (screenshots, system info, enable/disable control) always work.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List

from .registry import STATE, ToolError, register

# Default phrases that unlock full computer control.
DEFAULT_CONTROL_PHRASES: List[str] = [
    "control",
    "take control",
    "computer control",
    "full control",
    "you have control",
    "start control",
    "enable control",
    "bikli control",
]

# Phrases that lock control again.
DEFAULT_RELEASE_PHRASES: List[str] = [
    "stop control",
    "release control",
    "end control",
    "disable control",
    "cancel control",
    "lock control",
    "give me control",
    "stop controlling",
]


def is_control_enabled() -> bool:
    return bool(getattr(STATE, "computer_control_enabled", False))


def set_control_enabled(enabled: bool, reason: str = "") -> Dict[str, Any]:
    STATE.computer_control_enabled = bool(enabled)
    STATE.computer_control_since = time.time() if enabled else None
    STATE.computer_control_reason = reason or ("enabled" if enabled else "disabled")
    status = "ENABLED" if enabled else "DISABLED"
    msg = (
        f"Full computer control is now {status}."
        + (
            " I can move the cursor, click, type, and run desktop tasks."
            if enabled
            else " Cursor and desktop automation are locked until you say the control word again."
        )
    )
    return {
        "result": msg,
        "enabled": enabled,
        "reason": STATE.computer_control_reason,
        "since": STATE.computer_control_since,
    }


def require_control(tool_name: str) -> None:
    """Raise ToolError if computer control is locked."""
    if is_control_enabled():
        return
    raise ToolError(
        f"Computer control is LOCKED. Tool '{tool_name}' requires the control word. "
        "Ask the user to say 'control' (or 'take control'), then call enableComputerControl. "
        "Do not claim you controlled the PC until control mode is enabled."
    )


@register("enableComputerControl")
def enable_computer_control(args: Dict[str, Any]) -> Dict[str, Any]:
    """
    Unlock full PC + cursor control after the user says the control word.
    Only call this when the user explicitly grants control.
    """
    reason = str(args.get("reason") or args.get("phrase") or "user said control word").strip()
    return set_control_enabled(True, reason=reason)


@register("disableComputerControl")
def disable_computer_control(args: Dict[str, Any]) -> Dict[str, Any]:
    """Lock full PC + cursor control again."""
    reason = str(args.get("reason") or "user released control").strip()
    return set_control_enabled(False, reason=reason)


@register("getComputerControlStatus")
def get_computer_control_status(args: Dict[str, Any]) -> Dict[str, Any]:
    enabled = is_control_enabled()
    return {
        "result": (
            "Full computer control is ACTIVE — cursor and desktop tools are unlocked."
            if enabled
            else "Full computer control is LOCKED — say 'control' to unlock."
        ),
        "enabled": enabled,
        "reason": getattr(STATE, "computer_control_reason", None),
        "since": getattr(STATE, "computer_control_since", None),
        "control_phrases": DEFAULT_CONTROL_PHRASES,
        "release_phrases": DEFAULT_RELEASE_PHRASES,
    }


__all__ = [
    "is_control_enabled",
    "set_control_enabled",
    "require_control",
    "DEFAULT_CONTROL_PHRASES",
    "DEFAULT_RELEASE_PHRASES",
    "enable_computer_control",
    "disable_computer_control",
    "get_computer_control_status",
]
