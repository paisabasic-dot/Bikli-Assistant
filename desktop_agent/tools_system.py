"""
System information: CPU, RAM, disk usage, GPU (best-effort), temperature,
battery percentage, and local date/time.

All read-only. psutil powers the core metrics; GPU stats come from
nvidia-ml-py3 (pynvml) when an NVIDIA GPU is present, and degrade gracefully
otherwise. Temperature is best-effort via psutil.sensors_temperatures (Linux)
or WMI on Windows when available.
"""

from __future__ import annotations

import platform
import subprocess
from typing import Any, Dict, Optional

from .registry import register


def _bytes_human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB", "PB"):
        if n < 1024.0:
            return f"{n:.1f}{unit}"
        n /= 1024.0
    return f"{n:.1f}EB"


def _no_window_flags() -> int:
    return int(getattr(subprocess, "CREATE_NO_WINDOW", 0))


def _battery_via_wmi() -> Optional[Dict[str, Any]]:
    """Windows fallback when psutil has no battery sensor."""
    if platform.system() != "Windows":
        return None
    try:
        out = subprocess.check_output(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                (
                    "$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1; "
                    "if (-not $b) { '' } else { "
                    "\"$($b.EstimatedChargeRemaining)|$($b.BatteryStatus)|$($b.EstimatedRunTime)\""
                    " }"
                ),
            ],
            text=True,
            timeout=6,
            stderr=subprocess.DEVNULL,
            creationflags=_no_window_flags(),
        ).strip()
        if not out or "|" not in out:
            return None
        parts = out.split("|")
        percent = int(float(parts[0])) if parts[0] not in ("", "None") else None
        if percent is None:
            return None
        status_code = int(parts[1]) if len(parts) > 1 and parts[1] not in ("", "None") else 0
        # Win32_BatteryStatus: 1=Discharging, 2=AC, 3=Fully Charged, 4=Low, 5=Critical, 6=Charging, ...
        plugging = status_code in (2, 3, 6, 7, 8, 9)
        charging = status_code in (6, 7, 8, 9)
        secs_left = None
        if len(parts) > 2 and parts[2] not in ("", "None", "71582788", "4294967295"):
            try:
                mins = int(float(parts[2]))
                if 0 < mins < 100000:
                    secs_left = mins * 60
            except ValueError:
                pass
        return {
            "percent": max(0, min(100, percent)),
            "plugged_in": plugging,
            "charging": charging,
            "secsleft": secs_left,
        }
    except Exception:
        return None


@register("systemInfo")
def system_info(args: Dict[str, Any]) -> Dict[str, Any]:
    import psutil

    cpu_percent = psutil.cpu_percent(interval=0.3)
    cpu_count_logical = psutil.cpu_count(logical=True)
    cpu_count_physical = psutil.cpu_count(logical=False) or cpu_count_logical

    vm = psutil.virtual_memory()
    ram_total = vm.total
    ram_used = vm.used
    ram_percent = vm.percent

    # Disk usage on the system drive (and project drive if different).
    disks: Dict[str, Dict[str, Any]] = {}
    seen = set()
    try:
        for part in psutil.disk_partitions(all=False):
            mp = part.mountpoint
            if mp in seen:
                continue
            seen.add(mp)
            try:
                du = psutil.disk_usage(mp)
                disks[mp] = {
                    "total": _bytes_human(du.total),
                    "used": _bytes_human(du.used),
                    "free": _bytes_human(du.free),
                    "percent": du.percent,
                }
            except Exception:
                continue
    except Exception:
        pass

    boot = psutil.boot_time()
    import datetime as _dt

    uptime = _dt.datetime.now() - _dt.datetime.fromtimestamp(boot)

    return {
        "result": (
            f"CPU {cpu_percent}% ({cpu_count_physical} cores / {cpu_count_logical} threads). "
            f"RAM {ram_percent}% ({_bytes_human(ram_used)}/{_bytes_human(ram_total)}). "
            f"{len(disks)} disk(s) monitored. Uptime {uptime}."
        ),
        "cpu": {"percent": cpu_percent, "physical_cores": cpu_count_physical, "logical_cores": cpu_count_logical},
        "ram": {"percent": ram_percent, "used": _bytes_human(ram_used), "total": _bytes_human(ram_total)},
        "disks": disks,
        "uptime_seconds": int(uptime.total_seconds()),
        "os": platform.platform(),
    }


def _gpu_stats() -> list:
    try:
        import pynvml  # type: ignore
        from pynvml import (  # type: ignore
            NVML_TEMPERATURE_GPU,
            NVML_CLOCK_GRAPHICS,
            NVML_CLOCK_MEM,
            nvmlInit,
            nvmlDeviceGetCount,
            nvmlDeviceGetHandleByIndex,
            nvmlDeviceGetName,
            nvmlDeviceGetUtilizationRates,
            nvmlDeviceGetMemoryInfo,
            nvmlDeviceGetTemperature,
            nvmlDeviceGetClockInfo,
        )
    except Exception:
        return []

    gpus = []
    try:
        nvmlInit()
        count = nvmlDeviceGetCount()
        for i in range(count):
            h = nvmlDeviceGetHandleByIndex(i)
            util = nvmlDeviceGetUtilizationRates(h)
            mem = nvmlDeviceGetMemoryInfo(h)
            gpus.append(
                {
                    "index": i,
                    "name": nvmlDeviceGetName(h).decode() if isinstance(nvmlDeviceGetName(h), bytes) else str(nvmlDeviceGetName(h)),
                    "gpu_utilization_percent": util.gpu,
                    "memory_utilization_percent": util.memory,
                    "memory_total": _bytes_human(mem.total),
                    "memory_used": _bytes_human(mem.used),
                    "memory_free": _bytes_human(mem.free),
                    "temperature_c": nvmlDeviceGetTemperature(h, NVML_TEMPERATURE_GPU),
                }
            )
    except Exception:
        return []
    return gpus


@register("gpuInfo")
def gpu_info(args: Dict[str, Any]) -> Dict[str, Any]:
    gpus = _gpu_stats()
    if not gpus:
        return {
            "result": (
                "No NVIDIA GPU stats available via pynvml (no NVIDIA GPU, "
                "driver missing, or nvidia-ml-py3 not installed)."
            ),
            "gpus": [],
        }
    summary = "; ".join(
        f"{g['name']}: {g['gpu_utilization_percent']}% GPU, "
        f"{g['memory_used']}/{g['memory_total']} VRAM, {g['temperature_c']}°C"
        for g in gpus
    )
    return {"result": summary, "gpus": gpus}


@register("temperatureInfo")
def temperature_info(args: Dict[str, Any]) -> Dict[str, Any]:
    # Prefer GPU temp if available (NVIDIA), then psutil sensors.
    gpus = _gpu_stats()
    temps: Dict[str, Any] = {}
    for g in gpus:
        temps[f"gpu{g['index']}"] = g["temperature_c"]

    try:
        import psutil

        sensors = psutil.sensors_temperatures() if hasattr(psutil, "sensors_temperatures") else {}
        for name, entries in (sensors or {}).items():
            for entry in entries[:1]:
                temps[name] = entry.current
    except Exception:
        pass

    # Windows CPU temps generally require admin + OpenHardwareMonitor/LibreHardwareMonitor.
    if not temps:
        return {
            "result": (
                "Temperature reading unavailable. On Windows, CPU temps need "
                "LibreHardwareMonitor or admin access; GPU temps need an NVIDIA GPU."
            ),
            "temperatures": {},
        }
    summary = ", ".join(f"{k}={v}°C" for k, v in temps.items())
    return {"result": f"Temperatures: {summary}.", "temperatures": temps}


@register("batteryInfo")
def battery_info(args: Dict[str, Any]) -> Dict[str, Any]:
    """Read real laptop/UPS battery percentage from this PC. Do not open Settings."""
    data: Optional[Dict[str, Any]] = None

    try:
        import psutil

        bat = psutil.sensors_battery() if hasattr(psutil, "sensors_battery") else None
        if bat is not None and bat.percent is not None:
            secs = bat.secsleft
            # psutil uses special sentinel values for unknown time remaining.
            if secs is not None and secs < 0:
                secs = None
            data = {
                "percent": int(round(bat.percent)),
                "plugged_in": bool(bat.power_plugged),
                "charging": bool(bat.power_plugged) and bat.percent < 100,
                "secsleft": secs,
            }
    except Exception:
        data = None

    if data is None:
        data = _battery_via_wmi()

    if data is None:
        return {
            "result": (
                "No battery detected on this computer. This looks like a desktop "
                "PC (or a laptop with no battery reported), so there is no battery percentage to read."
            ),
            "percent": None,
            "plugged_in": None,
            "has_battery": False,
        }

    percent = int(data["percent"])
    plugged = bool(data.get("plugged_in"))
    secs = data.get("secsleft")

    if plugged and percent >= 100:
        power = "plugged in and fully charged"
    elif plugged:
        power = "plugged in and charging"
    else:
        power = "on battery (not plugged in)"

    time_part = ""
    if secs and isinstance(secs, (int, float)) and secs > 0:
        mins = int(secs // 60)
        hours, mins = divmod(mins, 60)
        if hours > 0:
            time_part = f" About {hours}h {mins}m remaining."
        else:
            time_part = f" About {mins} minutes remaining."

    return {
        "result": f"Battery is at {percent}% — {power}.{time_part}",
        "percent": percent,
        "plugged_in": plugged,
        "charging": bool(data.get("charging")),
        "secsleft": secs,
        "has_battery": True,
    }


@register("getDateTime")
def get_date_time(args: Dict[str, Any]) -> Dict[str, Any]:
    """Read the real local date and time from this computer's clock."""
    import datetime as _dt

    now = _dt.datetime.now().astimezone()
    # Example: Monday, July 20, 2026 at 10:29 AM
    spoken = now.strftime("%A, %B %d, %Y at %I:%M %p").replace(" 0", " ")
    iso = now.isoformat(timespec="seconds")
    timezone = now.tzname() or ""
    date_only = now.strftime("%A, %B %d, %Y")
    time_only = now.strftime("%I:%M %p").lstrip("0")

    return {
        "result": f"The computer's local time is {spoken}" + (f" ({timezone})" if timezone else "") + ".",
        "datetime": iso,
        "date": date_only,
        "time": time_only,
        "timezone": timezone,
        "weekday": now.strftime("%A"),
        "hour_24": now.hour,
        "minute": now.minute,
    }


__all__ = [
    "system_info",
    "gpu_info",
    "temperature_info",
    "battery_info",
    "get_date_time",
]
