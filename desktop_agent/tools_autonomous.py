"""
Tool handlers for Autonomous Vision & Web Agent missions.
Registered into the desktop agent registry.
"""

from __future__ import annotations

from typing import Any, Dict

from .autonomous_engine import AUTONOMOUS_ENGINE
from .registry import register


@register("startAutonomousMission")
async def start_autonomous_mission(args: Dict[str, Any]) -> Dict[str, Any]:
    goal = str(args.get("goal") or "").strip()
    mode = str(args.get("mode") or "hybrid").lower()
    max_steps = int(args.get("max_steps") or 20)
    status = await AUTONOMOUS_ENGINE.start_mission(goal=goal, mode=mode, max_steps=max_steps)
    return {
        "ok": True,
        "result": f"Autonomous mission started for objective: '{goal}'. Real-time visual tracking active.",
        "mission": status,
    }


@register("stopAutonomousMission")
async def stop_autonomous_mission(args: Dict[str, Any]) -> Dict[str, Any]:
    reason = str(args.get("reason") or "Stopped by user")
    status = await AUTONOMOUS_ENGINE.stop_mission(reason=reason)
    return {"ok": True, "result": f"Autonomous mission stopped: {reason}", "mission": status}


@register("pauseAutonomousMission")
async def pause_autonomous_mission(args: Dict[str, Any]) -> Dict[str, Any]:
    status = await AUTONOMOUS_ENGINE.pause_mission()
    return {"ok": True, "result": "Mission paused.", "mission": status}


@register("resumeAutonomousMission")
async def resume_autonomous_mission(args: Dict[str, Any]) -> Dict[str, Any]:
    approved = bool(args.get("approved", True))
    status = await AUTONOMOUS_ENGINE.resume_mission(approved=approved)
    return {"ok": True, "result": "Mission resumed.", "mission": status}


@register("getAutonomousMissionStatus")
async def get_autonomous_mission_status(args: Dict[str, Any]) -> Dict[str, Any]:
    status = AUTONOMOUS_ENGINE.get_status()
    return {"ok": True, "mission": status}
