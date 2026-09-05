"""
Autonomous Vision & Web Agent Engine for BIKLI.
Integrates PC-Agent-E (ICLR 2026: Efficient Agent Training for Computer Use) architecture.

Provides:
- Per-monitor DPI awareness (Win32) for pixel-accurate coordinate mapping.
- Full PC-Agent-E action space: desktop_click, double_click, right_click, middle_click,
  triple_click, drag, scroll, desktop_type, press, hotkey, shortcut, wait, finish_mission.
- 5-stage self-correcting error recovery loop with visual state change detection.
- Dual-engine: Gemini 2.5 Flash / 2.0 Flash Vision by default, plus configurable vLLM endpoint.
- Web Set-of-Marks browser integration with live SSE streaming to the visual HUD.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import logging
import os
import re
import subprocess
import threading
import time
from typing import Any, AsyncGenerator, Dict, List, Optional, Tuple
from urllib.parse import urlparse

import requests

from .browser_vision_marks import (
    capture_set_of_marks,
    click_element_by_mark,
    fill_element_by_mark,
)
from .registry import STATE, ToolError
from .tools_control import set_control_enabled

log = logging.getLogger("bikli.autonomous")


# ── Per-Monitor Win32 DPI Awareness ──────────────────────────────────────────
# Essential on Windows: ensures PIL ImageGrab pixels and PyAutoGUI click coordinates
# match 1:1 on 125%, 150%, and 200% scaled displays without any coordinate skew.
def _init_dpi_awareness() -> None:
    if os.name == "nt":
        try:
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
            log.info("Per-monitor DPI awareness enabled via SetProcessDpiAwareness(2).")
        except Exception:
            try:
                import ctypes
                ctypes.windll.user32.SetProcessDPIAware()
                log.info("DPI awareness enabled via SetProcessDPIAware().")
            except Exception as e:
                log.warning("Could not set DPI awareness: %s", e)

_init_dpi_awareness()


def _get_api_key() -> str:
    """Resolve Gemini API key from environment or .env file."""
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if key:
        return key.strip()

    cur = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(cur, "..", ".env"),
        os.path.join(os.getcwd(), ".env"),
        os.path.join(os.getcwd(), "secrets.json"),
    ]
    for c in candidates:
        try:
            if os.path.exists(c):
                if c.endswith(".env"):
                    with open(c, "r", encoding="utf-8") as f:
                        for line in f:
                            if line.startswith("GEMINI_API_KEY=") or line.startswith("GOOGLE_API_KEY="):
                                parts = line.split("=", 1)
                                if len(parts) == 2:
                                    val = parts[1].strip().strip('"').strip("'")
                                    if val:
                                        return val
                elif c.endswith("secrets.json"):
                    with open(c, "r", encoding="utf-8") as f:
                        data = json.load(f)
                        val = data.get("geminiApiKey", "").strip()
                        if val:
                            return val
        except Exception:
            pass
    return ""


def _set_clipboard_text(text: str) -> bool:
    """Safely put text on Windows clipboard using Tkinter or PowerShell."""
    try:
        import tkinter as tk
        r = tk.Tk()
        r.withdraw()
        r.clipboard_clear()
        r.clipboard_append(text)
        r.update()
        r.destroy()
        return True
    except Exception:
        pass

    try:
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-Command", "$input | Set-Clipboard"],
            input=text.encode("utf-8"),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=3,
        )
        return proc.returncode == 0
    except Exception:
        return False


def _screen_size() -> Tuple[int, int]:
    """Detect screen resolution using PyAutoGUI or Win32 fallback."""
    try:
        import pyautogui
        w, h = pyautogui.size()
        if w > 0 and h > 0:
            return int(w), int(h)
    except Exception:
        pass
    if os.name == "nt":
        try:
            import ctypes
            w = ctypes.windll.user32.GetSystemMetrics(0)
            h = ctypes.windll.user32.GetSystemMetrics(1)
            if w > 0 and h > 0:
                return int(w), int(h)
        except Exception:
            pass
    return 1920, 1080


def _clamp_and_scale_coords(x_norm: Any, y_norm: Any) -> Tuple[int, int]:
    """Scales normalized [0, 1000] coordinates to physical screen pixels."""
    sw, sh = _screen_size()
    try:
        xf = float(x_norm)
    except (TypeError, ValueError):
        xf = 500.0
    try:
        yf = float(y_norm)
    except (TypeError, ValueError):
        yf = 500.0

    real_x = int((max(0.0, min(1000.0, xf)) / 1000.0) * sw)
    real_y = int((max(0.0, min(1000.0, yf)) / 1000.0) * sh)
    real_x = max(0, min(sw - 1, real_x))
    real_y = max(0, min(sh - 1, real_y))
    return real_x, real_y


# ── PC-Agent-E (ICLR 2026) Multimodal System Prompt ──────────────────────────
SYSTEM_PROMPT = """You are BIKLI's Autonomous PC-Agent-E Computer Use Engine (ICLR 2026).
Your objective is to accomplish the user's mission autonomously through precise visual perception and OS actions on Windows.

You are given:
1. The overall user GOAL.
2. The current step number and prior action history.
3. High-resolution screenshot of the Windows desktop or active application.
4. Any self-correction feedback or visual observation from previous steps.
5. If in web mode: a catalog of interactive elements with assigned numeric badges ([1], [2], [3]...).

You must output a single, valid JSON object with the following schema:
{
  "thought": "Detailed reasoning about what is visible on screen, what was achieved in the last step, and why the next action was chosen.",
  "action": "desktop_click" | "double_click" | "right_click" | "middle_click" | "triple_click" | "drag" | "scroll" | "desktop_type" | "press" | "hotkey" | "shortcut" | "wait" | "click_mark" | "fill_mark" | "navigate" | "finish_mission",
  "x": 500, // 0-1000 normalized horizontal coordinate (0=left, 1000=right)
  "y": 300, // 0-1000 normalized vertical coordinate (0=top, 1000=bottom)
  "end_x": 500, // used with drag
  "end_y": 600, // used with drag
  "text": "text to type", // string, used with desktop_type or fill_mark
  "press_enter": false, // boolean: if true, presses Enter immediately after typing text
  "key": "Enter", // string: used with press or hotkey (e.g. Enter, Tab, Escape, Win+S, Win+R, Alt+F4, Ctrl+T)
  "keys": ["Ctrl", "Shift", "Esc"], // array of keys: used with hotkey
  "direction": "down", // "down" | "up", used with scroll
  "amount": 5, // number of wheel clicks, used with scroll
  "command": "start spotify:", // Windows shell command or URI, used with shortcut for instant app launch
  "mark_id": 1, // number, used with click_mark or fill_mark when web badges are active
  "url": "https://...", // string, used with navigate
  "is_sensitive": false, // boolean: set to TRUE only if this action triggers financial payment, submits a password, or deletes user files
  "sensitive_reason": "", // explanation if is_sensitive is true
  "final_summary": "" // formatted completion report when action is finish_mission
}

GUIDELINES FOR 0 ERRORS:
- COORDINATES: Use 0-1000 normalized coordinates for screen clicks. For instance, the taskbar start button is usually around x=20, y=980. The center of the screen is x=500, y=500.
- OPENING APPS: You can click the app icon, OR use `shortcut` with `start <app>` (e.g. `start notepad`, `start spotify:`, `start calc`, `start ms-settings:`), OR press hotkey "Win+S" followed by desktop_type the app name and press Enter.
- DOUBLE CLICK: Desktop icons and files require `double_click` to open.
- TYPING: First click the target input field or search bar, then call `desktop_type`. You can set `press_enter: true` to submit immediately.
- SELF-CORRECTION: Carefully check the latest screenshot. If your previous click did not open the expected window or menu, do NOT click the exact same spot. Use an alternative method (e.g. Win+S search, shortcut, double-click, or key navigation).
- COMPLETION: When the user's goal has been accomplished, immediately output `finish_mission` with a clear, friendly final_summary.
"""


class AutonomousMissionEngine:
    """
    Manages active autonomous PC-Agent-E computer use missions.
    Coordinates vision sensing, multimodal planning, 5-stage self-correction,
    and fail-safe desktop action execution.
    """

    def __init__(self) -> None:
        self.lock = asyncio.Lock()
        self.active_mission_id: Optional[str] = None
        self.status: str = "IDLE"  # IDLE, RUNNING, PAUSED, WAITING_CONFIRMATION, COMPLETED, STOPPED, FAILED
        self.goal: str = ""
        self.mode: str = "desktop"  # desktop, web, hybrid
        self.current_step: int = 0
        self.max_steps: int = 25
        self.history: List[Dict[str, Any]] = []
        self.latest_screenshot: str = ""
        self.latest_thought: str = ""
        self.latest_action: str = ""
        self.latest_plan: Dict[str, Any] = {}
        self.final_result: str = ""
        self.error: Optional[str] = None
        self.task_handle: Optional[asyncio.Task] = None
        self.confirmation_event = asyncio.Event()
        self.confirmation_approved = False
        self.pending_sensitive_action: Optional[Dict[str, Any]] = None
        self.event_subscribers: List[asyncio.Queue] = []
        self.prev_screen_hash: str = ""
        self.consecutive_retries: int = 0
        self.self_correction_notice: str = ""

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self.event_subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        if q in self.event_subscribers:
            self.event_subscribers.remove(q)

    async def emit_event(self, event_type: str, data: Dict[str, Any]) -> None:
        payload = {
            "type": event_type,
            "mission_id": self.active_mission_id,
            "status": self.status,
            "timestamp": time.time(),
            **data,
        }
        for q in list(self.event_subscribers):
            try:
                q.put_nowait(payload)
            except Exception:
                pass

    def get_status(self) -> Dict[str, Any]:
        return {
            "mission_id": self.active_mission_id,
            "status": self.status,
            "goal": self.goal,
            "mode": self.mode,
            "step": self.current_step,
            "max_steps": self.max_steps,
            "latest_thought": self.latest_thought,
            "latest_action": self.latest_action,
            "latest_plan": self.latest_plan,
            "final_result": self.final_result,
            "error": self.error,
            "pending_confirmation": self.pending_sensitive_action,
            "history_count": len(self.history),
        }

    async def start_mission(
        self,
        goal: str,
        mode: str = "desktop",
        max_steps: int = 25,
    ) -> Dict[str, Any]:
        if not goal.strip():
            raise ToolError("Goal description cannot be empty.")

        if self.status in ("RUNNING", "WAITING_CONFIRMATION", "PAUSED"):
            await self.stop_mission(reason="Preempted by new mission")

        # Automatically unlock computer control for this mission
        set_control_enabled(True, reason=f"PC-Agent-E Mission: {goal.strip()}")

        self.active_mission_id = f"mission_{int(time.time() * 1000)}"
        self.goal = goal.strip()
        self.mode = mode
        self.max_steps = max(1, min(40, max_steps))
        self.current_step = 0
        self.history = []
        self.latest_screenshot = ""
        self.latest_thought = f"PC-Agent-E analyzing screen for objective: {self.goal}..."
        self.latest_action = "start"
        self.latest_plan = {}
        self.final_result = ""
        self.error = None
        self.status = "RUNNING"
        self.confirmation_event.clear()
        self.confirmation_approved = False
        self.pending_sensitive_action = None
        self.prev_screen_hash = ""
        self.consecutive_retries = 0
        self.self_correction_notice = ""

        await self.emit_event("mission_started", {
            "goal": self.goal,
            "mode": self.mode,
            "max_steps": self.max_steps,
        })

        # Spawn loop task
        self.task_handle = asyncio.create_task(self._run_mission_loop())
        return self.get_status()

    async def stop_mission(self, reason: str = "User stopped mission") -> Dict[str, Any]:
        self.status = "STOPPED"
        self.latest_thought = reason
        if self.task_handle and not self.task_handle.done():
            self.task_handle.cancel()
        self.confirmation_event.set()
        await self.emit_event("mission_stopped", {"reason": reason})
        return self.get_status()

    async def pause_mission(self) -> Dict[str, Any]:
        if self.status == "RUNNING":
            self.status = "PAUSED"
            await self.emit_event("mission_paused", {})
        return self.get_status()

    async def resume_mission(self, approved: bool = True) -> Dict[str, Any]:
        if self.status in ("PAUSED", "WAITING_CONFIRMATION"):
            self.confirmation_approved = approved
            self.status = "RUNNING"
            self.confirmation_event.set()
            await self.emit_event("mission_resumed", {"approved": approved})
        return self.get_status()

    async def _run_mission_loop(self) -> None:
        log.info("[PC-Agent-E] Starting autonomous loop for mission: %s", self.goal)
        api_key = _get_api_key()
        vllm_url = os.environ.get("PC_AGENT_VLLM_URL", "").strip()

        if not api_key and not vllm_url:
            self.status = "FAILED"
            self.error = "No GEMINI_API_KEY found and no PC_AGENT_VLLM_URL configured."
            await self.emit_event("mission_failed", {"error": self.error})
            return

        try:
            while self.current_step < self.max_steps:
                if self.status == "STOPPED":
                    break

                while self.status == "PAUSED":
                    await asyncio.sleep(0.5)

                self.current_step += 1
                log.info("[PC-Agent-E Mission %s] Step %d/%d", self.active_mission_id, self.current_step, self.max_steps)

                # 1. Sense Environment
                shot_b64, elements, page_url, screen_hash = await self._capture_environment()
                self.latest_screenshot = shot_b64

                # Visual state verification: check if screen changed compared to last step
                if self.prev_screen_hash and self.prev_screen_hash == screen_hash and self.current_step > 1:
                    last_act = self.latest_action
                    log.warning("[PC-Agent-E] Screen did not change after step action: %s", last_act)
                    self.consecutive_retries += 1
                    if self.consecutive_retries >= 5:
                        self.status = "FAILED"
                        self.error = f"Action loop detected: '{last_act}' failed to produce any visual change after 5 attempts."
                        await self.emit_event("mission_failed", {"error": self.error})
                        break
                    self.self_correction_notice = (
                        f"Notice: Previous action '{last_act}' did not change the screen. "
                        "The target may require double_click, keyboard navigation (Win+S / Tab / Enter), "
                        "or launching via 'shortcut' (e.g. command='start <app>'). Try an alternative approach."
                    )
                else:
                    self.consecutive_retries = 0
                    self.self_correction_notice = ""
                self.prev_screen_hash = screen_hash

                await self.emit_event("screen_update", {
                    "step": self.current_step,
                    "screenshot": f"data:image/jpeg;base64,{shot_b64}" if shot_b64 else "",
                    "page_url": page_url,
                    "element_count": len(elements),
                })

                # 2. Plan next action using PC-Agent-E VLM
                plan = await self._call_vision_llm(api_key, vllm_url, shot_b64, elements, page_url)
                self.latest_thought = plan.get("thought", "")
                self.latest_action = plan.get("action", "")
                self.latest_plan = plan

                await self.emit_event("step_update", {
                    "step": self.current_step,
                    "thought": self.latest_thought,
                    "action": self.latest_action,
                    "plan": plan,
                })

                # 3. Check Sensitive Action Guardrail
                if plan.get("is_sensitive"):
                    self.status = "WAITING_CONFIRMATION"
                    self.pending_sensitive_action = plan
                    self.confirmation_event.clear()
                    await self.emit_event("confirmation_needed", {
                        "reason": plan.get("sensitive_reason", "Sensitive action detected"),
                        "action": self.latest_action,
                        "plan": plan,
                    })
                    await self.confirmation_event.wait()
                    if not self.confirmation_approved:
                        log.info("User denied sensitive action. Continuing with rejection note.")
                        self.history.append({
                            "step": self.current_step,
                            "action": self.latest_action,
                            "result": "User rejected this sensitive action.",
                        })
                        self.pending_sensitive_action = None
                        continue
                    self.pending_sensitive_action = None

                # 4. Check for Finish
                if plan.get("action") == "finish_mission":
                    self.status = "COMPLETED"
                    self.final_result = plan.get("final_summary") or self.latest_thought
                    log.info("[PC-Agent-E] Mission completed successfully.")
                    await self.emit_event("mission_completed", {
                        "result": self.final_result,
                        "history": self.history,
                    })
                    break

                # 5. Actuate action
                try:
                    action_result = await self._execute_plan_action(plan)
                except Exception as ex:
                    log.exception("Error executing plan action: %s", ex)
                    action_result = f"Error executing {self.latest_action}: {ex}"
                    self.self_correction_notice = f"Execution error: {ex}. Adjust parameters or choose another action."

                self.history.append({
                    "step": self.current_step,
                    "thought": self.latest_thought,
                    "action": self.latest_action,
                    "plan": plan,
                    "result": action_result,
                })

                # Visual settle delay
                await asyncio.sleep(1.0)

            if self.current_step >= self.max_steps and self.status == "RUNNING":
                self.status = "COMPLETED"
                self.final_result = f"Completed maximum allowed steps ({self.max_steps}). Summary: {self.latest_thought}"
                await self.emit_event("mission_completed", {
                    "result": self.final_result,
                    "history": self.history,
                })

        except asyncio.CancelledError:
            log.info("[PC-Agent-E] Mission task cancelled.")
        except Exception as e:
            log.exception("[PC-Agent-E] Error in autonomous mission loop")
            self.status = "FAILED"
            self.error = str(e)
            await self.emit_event("mission_failed", {"error": str(e)})

    async def _capture_environment(self) -> Tuple[str, List[Dict[str, Any]], str, str]:
        """Captures page state (Set-of-Marks) if web mode and browser open, else native desktop screenshot."""
        if self.mode == "web" and STATE.page is not None:
            try:
                url = STATE.page.url
                if url and url != "about:blank":
                    shot_b64, elements = await capture_set_of_marks(STATE.page)
                    img_bytes = base64.b64decode(shot_b64)
                    screen_hash = hashlib.md5(img_bytes[:4096]).hexdigest()
                    return shot_b64, elements, url, screen_hash
            except Exception as e:
                log.warning("Playwright capture failed, falling back to desktop capture: %s", e)

        # Desktop screen capture via PIL ImageGrab (DPI-aware)
        try:
            from PIL import ImageGrab
            img = ImageGrab.grab()

            # Hash a small 32x32 thumbnail for rapid visual change detection
            thumb = img.resize((32, 32))
            screen_hash = hashlib.md5(thumb.tobytes()).hexdigest()

            # Resize slightly if 4K to conserve tokens and speed up network upload
            if img.width > 1920:
                img.thumbnail((1920, 1080))

            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=80)
            shot_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
            return shot_b64, [], "desktop://windows", screen_hash
        except Exception as e:
            log.error("Desktop capture failed: %s", e)
            return "", [], "unknown", ""

    async def _call_vision_llm(
        self,
        api_key: str,
        vllm_url: str,
        shot_b64: str,
        elements: List[Dict[str, Any]],
        page_url: str,
    ) -> Dict[str, Any]:
        """Calls vLLM (PC-Agent-E weights) or Google Gemini Multimodal Vision."""
        elements_summary = ""
        if elements:
            lines = []
            for el in elements[:35]:
                label = el.get("text") or el.get("ariaLabel") or el.get("placeholder") or el.get("role") or el.get("tag")
                lines.append(f"[{el['id']}] <{el['tag']}> {label}")
            elements_summary = "INTERACTIVE WEB MARKS:\n" + "\n".join(lines)

        history_summary = ""
        if self.history:
            h_lines = [
                f"Step {h['step']}: {h.get('action', '')} -> {h.get('result', '')}"
                for h in self.history[-5:]
            ]
            history_summary = "RECENT HISTORY:\n" + "\n".join(h_lines)

        correction_text = ""
        if self.self_correction_notice:
            correction_text = f"\n⚠️ SELF-CORRECTION GUIDANCE:\n{self.self_correction_notice}\n"

        user_content = f"""MISSION GOAL: {self.goal}
CURRENT STEP: {self.current_step} of {self.max_steps}
CURRENT SCREEN: {page_url}

{history_summary}
{correction_text}
{elements_summary}

Observe the screenshot carefully and output the single JSON action to proceed towards the goal."""

        # 1. If vLLM endpoint is configured, try it first
        if vllm_url:
            try:
                loop = asyncio.get_running_loop()
                model_name = os.environ.get("PC_AGENT_MODEL", "henryhe0123/PC-Agent-E")
                endpoint = f"{vllm_url.rstrip('/')}/chat/completions"
                vllm_payload = {
                    "model": model_name,
                    "messages": [
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": user_content},
                                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{shot_b64}"}}
                            ]
                        }
                    ],
                    "temperature": 0.1,
                    "max_tokens": 1024,
                }
                res = await loop.run_in_executor(
                    None,
                    lambda: requests.post(endpoint, json=vllm_payload, timeout=30),
                )
                if res.ok:
                    res_json = res.json()
                    content = res_json.get("choices", [{}])[0].get("message", {}).get("content", "")
                    clean = re.sub(r"^```json\s*", "", content.strip(), flags=re.MULTILINE)
                    clean = re.sub(r"\s*```$", "", clean, flags=re.MULTILINE)
                    return json.loads(clean)
                else:
                    log.warning("vLLM error (%d): %s. Falling back to Gemini.", res.status_code, res.text)
            except Exception as e:
                log.warning("vLLM invocation failed: %s. Falling back to Gemini.", e)

        # 2. Built-in Gemini Multimodal Vision (Gemini 2.5 Flash / 2.0 Flash)
        url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}"
        parts: List[Dict[str, Any]] = [{"text": user_content}]
        if shot_b64:
            parts.append({
                "inline_data": {
                    "mime_type": "image/jpeg",
                    "data": shot_b64,
                }
            })

        payload = {
            "system_instruction": {"parts": [{"text": SYSTEM_PROMPT}]},
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": {
                "temperature": 0.2,
                "response_mime_type": "application/json",
            },
        }

        loop = asyncio.get_running_loop()
        res = await loop.run_in_executor(
            None,
            lambda: requests.post(url, json=payload, timeout=25),
        )

        if not res.ok:
            fallback_url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={api_key}"
            res = await loop.run_in_executor(
                None,
                lambda: requests.post(fallback_url, json=payload, timeout=25),
            )
            if not res.ok:
                raise ToolError(f"Gemini API error ({res.status_code}): {res.text}")

        data = res.json()
        raw_text = (
            data.get("candidates", [{}])[0]
            .get("content", {})
            .get("parts", [{}])[0]
            .get("text", "{}")
        )

        try:
            return json.loads(raw_text)
        except Exception:
            clean = re.sub(r"^```json\s*", "", raw_text.strip(), flags=re.MULTILINE)
            clean = re.sub(r"\s*```$", "", clean, flags=re.MULTILINE)
            return json.loads(clean)

    async def _execute_plan_action(self, plan: Dict[str, Any]) -> str:
        """Executes PC-Agent-E action space with high-precision PyAutoGUI & Win32 commands."""
        pag = None
        try:
            import pyautogui
            pag = pyautogui
        except Exception:
            pass

        def _native_click(x: int, y: int, btn: str = "left", count: int = 1):
            if pag:
                if count == 1:
                    if btn == "right": pag.rightClick(x, y)
                    elif btn == "middle": pag.middleClick(x, y)
                    else: pag.click(x, y)
                elif count == 2: pag.doubleClick(x, y)
                elif count == 3: pag.tripleClick(x, y)
                return
            if os.name == "nt":
                import ctypes
                u32 = ctypes.windll.user32
                u32.SetCursorPos(x, y)
                time.sleep(0.03)
                down_f, up_f = (0x0008, 0x0010) if btn == "right" else ((0x0020, 0x0040) if btn == "middle" else (0x0002, 0x0004))
                for _ in range(count):
                    u32.mouse_event(down_f, 0, 0, 0, 0)
                    time.sleep(0.03)
                    u32.mouse_event(up_f, 0, 0, 0, 0)
                    time.sleep(0.03)

        def _native_drag(sx: int, sy: int, ex: int, ey: int):
            if pag:
                pag.moveTo(sx, sy)
                pag.dragTo(ex, ey, duration=0.6, button="left")
                return
            if os.name == "nt":
                import ctypes
                u32 = ctypes.windll.user32
                u32.SetCursorPos(sx, sy)
                time.sleep(0.05)
                u32.mouse_event(0x0002, 0, 0, 0, 0)
                time.sleep(0.05)
                steps = 10
                for i in range(1, steps + 1):
                    nx = int(sx + (ex - sx) * i / steps)
                    ny = int(sy + (ey - sy) * i / steps)
                    u32.SetCursorPos(nx, ny)
                    time.sleep(0.02)
                u32.mouse_event(0x0004, 0, 0, 0, 0)

        def _native_scroll(rx: Optional[int], ry: Optional[int], amount: int):
            if pag:
                if rx is not None and ry is not None:
                    pag.moveTo(rx, ry)
                pag.scroll(amount)
                return
            if os.name == "nt":
                import ctypes
                u32 = ctypes.windll.user32
                if rx is not None and ry is not None:
                    u32.SetCursorPos(rx, ry)
                u32.mouse_event(0x0800, 0, 0, amount, 0)

        def _native_type(text: str, press_enter: bool = False):
            if pag:
                if len(text) > 30 or any(ord(c) > 127 for c in text):
                    if _set_clipboard_text(text):
                        pag.hotkey("ctrl", "v")
                    else:
                        pag.write(text, interval=0.01)
                else:
                    pag.write(text, interval=0.02)
                if press_enter:
                    time.sleep(0.05)
                    pag.press("enter")
                return

            if _set_clipboard_text(text):
                _native_hotkey(["ctrl", "v"])
            else:
                safe = text.replace("{", "{{}").replace("}", "{}}").replace("'", "''")
                subprocess.run(["powershell", "-NoProfile", "-Command", f"Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{safe}')"], timeout=3)
            if press_enter:
                _native_press("enter")

        def _native_press(key: str):
            key_map = {
                "enter": 0x0D, "return": 0x0D, "tab": 0x09, "esc": 0x1B,
                "escape": 0x1B, "space": 0x20, "backspace": 0x08,
                "delete": 0x2E, "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
                "home": 0x24, "end": 0x23, "pageup": 0x21, "pagedown": 0x22,
            }
            if pag:
                pag.press(key.lower())
                return
            if os.name == "nt":
                import ctypes
                u32 = ctypes.windll.user32
                vk = key_map.get(key.lower(), ord(key.upper()) if len(key) == 1 else 0)
                if vk > 0:
                    u32.keybd_event(vk, 0, 0, 0)
                    time.sleep(0.04)
                    u32.keybd_event(vk, 0, 2, 0)

        def _native_hotkey(keys: List[str]):
            normalized = []
            for p in keys:
                p_low = str(p).strip().lower()
                if p_low in ("win", "windows", "super", "cmd"): normalized.append("win")
                elif p_low in ("control", "ctrl"): normalized.append("ctrl")
                elif p_low in ("alternate", "alt"): normalized.append("alt")
                elif p_low in ("esc", "escape"): normalized.append("escape")
                else: normalized.append(p_low)

            if pag:
                pag.hotkey(*normalized)
                return

            if os.name == "nt":
                import ctypes
                u32 = ctypes.windll.user32
                vk_map = {
                    "ctrl": 0x11, "alt": 0x12, "shift": 0x10, "win": 0x5B,
                    "enter": 0x0D, "tab": 0x09, "escape": 0x1B, "space": 0x20,
                    "c": 0x43, "v": 0x56, "x": 0x58, "a": 0x41, "z": 0x5A,
                    "s": 0x53, "r": 0x52, "t": 0x54, "w": 0x57, "f4": 0x73,
                }
                vks = [vk_map.get(k, ord(k.upper()) if len(k) == 1 else 0) for k in normalized]
                vks = [vk for vk in vks if vk > 0]
                for vk in vks:
                    u32.keybd_event(vk, 0, 0, 0)
                time.sleep(0.04)
                for vk in reversed(vks):
                    u32.keybd_event(vk, 0, 2, 0)

        action = str(plan.get("action") or "").lower()
        log.info("[PC-Agent-E Action] %s with args %s", action, plan)

        # 1. Desktop Click (left click)
        if action in ("desktop_click", "click"):
            rx, ry = _clamp_and_scale_coords(plan.get("x", 500), plan.get("y", 500))
            _native_click(rx, ry, btn="left", count=1)
            return f"Clicked at ({rx}, {ry})"

        # 2. Double Click
        elif action == "double_click":
            rx, ry = _clamp_and_scale_coords(plan.get("x", 500), plan.get("y", 500))
            _native_click(rx, ry, btn="left", count=2)
            return f"Double-clicked at ({rx}, {ry})"

        # 3. Right Click
        elif action == "right_click":
            rx, ry = _clamp_and_scale_coords(plan.get("x", 500), plan.get("y", 500))
            _native_click(rx, ry, btn="right", count=1)
            return f"Right-clicked at ({rx}, {ry})"

        # 4. Middle Click
        elif action == "middle_click":
            rx, ry = _clamp_and_scale_coords(plan.get("x", 500), plan.get("y", 500))
            _native_click(rx, ry, btn="middle", count=1)
            return f"Middle-clicked at ({rx}, {ry})"

        # 5. Triple Click
        elif action == "triple_click":
            rx, ry = _clamp_and_scale_coords(plan.get("x", 500), plan.get("y", 500))
            _native_click(rx, ry, btn="left", count=3)
            return f"Triple-clicked at ({rx}, {ry})"

        # 6. Drag & Drop
        elif action == "drag":
            sx, sy = _clamp_and_scale_coords(plan.get("x", plan.get("start_x", 500)), plan.get("y", plan.get("start_y", 500)))
            ex, ey = _clamp_and_scale_coords(plan.get("end_x", 500), plan.get("end_y", 500))
            _native_drag(sx, sy, ex, ey)
            return f"Dragged from ({sx}, {sy}) to ({ex}, {ey})"

        # 7. Scroll
        elif action == "scroll":
            direction = str(plan.get("direction", "down")).lower()
            clicks = int(plan.get("amount", 5))
            amount = -abs(clicks) * 120 if direction == "down" else abs(clicks) * 120
            rx, ry = None, None
            if "x" in plan and "y" in plan:
                rx, ry = _clamp_and_scale_coords(plan.get("x"), plan.get("y"))
            _native_scroll(rx, ry, amount)
            return f"Scrolled {direction} ({amount} clicks)"

        # 8. Desktop Type
        elif action == "desktop_type":
            text = str(plan.get("text") or "")
            press_enter = bool(plan.get("press_enter", False))
            _native_type(text, press_enter=press_enter)
            return f"Typed '{text}' (press_enter={press_enter})"

        # 9. Press Key
        elif action == "press":
            key = str(plan.get("key") or "enter").strip().lower()
            _native_press(key)
            return f"Pressed key '{key}'"

        # 10. Hotkey Combination
        elif action == "hotkey":
            keys = plan.get("keys") or plan.get("key") or ["enter"]
            if isinstance(keys, str):
                parts = [k.strip().lower() for k in keys.split("+")]
            else:
                parts = [str(k).strip().lower() for k in keys]
            _native_hotkey(parts)
            return f"Pressed hotkey: {'+'.join(parts)}"

        # 11. Shortcut / Shell Command (Direct app launch)
        elif action == "shortcut":
            cmd = str(plan.get("command") or "").strip()
            if not cmd:
                return "Empty shortcut command"
            subprocess.Popen(cmd, shell=True)
            await asyncio.sleep(1.0)
            return f"Executed shortcut: {cmd}"

        # 12. Wait
        elif action == "wait":
            secs = min(10.0, max(0.5, float(plan.get("seconds", 2.0))))
            await asyncio.sleep(secs)
            return f"Waited {secs} seconds"

        # 13. Set-of-Marks Web Click
        elif action == "click_mark":
            mark_id = plan.get("mark_id")
            if mark_id is not None and STATE.page:
                res = await click_element_by_mark(STATE.page, int(mark_id))
                return res.get("result") or res.get("error", "Clicked mark")
            return "No active webpage or mark ID"

        # 14. Set-of-Marks Web Fill
        elif action == "fill_mark":
            mark_id = plan.get("mark_id")
            text = plan.get("text", "")
            if mark_id is not None and STATE.page:
                res = await fill_element_by_mark(STATE.page, int(mark_id), text)
                return res.get("result") or res.get("error", "Filled mark")
            return "No active webpage or mark ID"

        # 15. Web Navigate
        elif action == "navigate":
            target_url = plan.get("url") or plan.get("text")
            if not target_url:
                return "Empty URL"
            if "://" not in target_url:
                target_url = "https://" + target_url

            from .tools_browser import _ensure_browser_async
            page = await _ensure_browser_async()
            await page.goto(target_url, wait_until="domcontentloaded", timeout=20000)
            return f"Navigated to {target_url}"

        return f"Unknown action '{action}'"


# Singleton engine instance
AUTONOMOUS_ENGINE = AutonomousMissionEngine()
