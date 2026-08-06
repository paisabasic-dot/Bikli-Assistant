"""
Windows system settings control: Bluetooth, Wi‑Fi, airplane mode, and
quick Settings page openers (ms-settings: URIs).

Uses:
  - WinRT Radio API (via PowerShell) for Bluetooth / Wi‑Fi radios
  - netsh as Wi‑Fi fallback
  - ms-settings: URIs for opening Settings pages
"""

from __future__ import annotations

import re
import subprocess
import time
from typing import Any, Dict, List, Optional, Tuple

from .registry import ToolError, register

# Friendly name -> ms-settings URI
SETTINGS_PAGES: Dict[str, str] = {
    "settings": "ms-settings:",
    "home": "ms-settings:",
    "bluetooth": "ms-settings:bluetooth",
    "wifi": "ms-settings:network-wifi",
    "wi-fi": "ms-settings:network-wifi",
    "network": "ms-settings:network",
    "ethernet": "ms-settings:network-ethernet",
    "airplane": "ms-settings:network-airplanemode",
    "airplane mode": "ms-settings:network-airplanemode",
    "display": "ms-settings:display",
    "sound": "ms-settings:sound",
    "audio": "ms-settings:sound",
    "notifications": "ms-settings:notifications",
    "power": "ms-settings:powersleep",
    "battery": "ms-settings:batterysaver",
    "privacy": "ms-settings:privacy",
    "apps": "ms-settings:appsfeatures",
    "applications": "ms-settings:appsfeatures",
    "storage": "ms-settings:storagesense",
    "time": "ms-settings:dateandtime",
    "date": "ms-settings:dateandtime",
    "language": "ms-settings:regionlanguage",
    "region": "ms-settings:regionformatting",
    "update": "ms-settings:windowsupdate",
    "windows update": "ms-settings:windowsupdate",
    "about": "ms-settings:about",
    "system": "ms-settings:about",
    "personalization": "ms-settings:personalization",
    "theme": "ms-settings:personalization-colors",
    "colors": "ms-settings:personalization-colors",
    "background": "ms-settings:personalization-background",
    "lock screen": "ms-settings:lockscreen",
    "accounts": "ms-settings:yourinfo",
    "signin": "ms-settings:signinoptions",
    "sign-in": "ms-settings:signinoptions",
    "mouse": "ms-settings:mousetouchpad",
    "keyboard": "ms-settings:typing",
    "touchpad": "ms-settings:devices-touchpad",
    "printers": "ms-settings:printers",
    "camera": "ms-settings:privacy-webcam",
    "microphone": "ms-settings:privacy-microphone",
    "location": "ms-settings:privacy-location",
    "night light": "ms-settings:nightlight",
    "nightlight": "ms-settings:nightlight",
    "focus assist": "ms-settings:quiethours",
    "do not disturb": "ms-settings:quiethours",
    "gaming": "ms-settings:gaming-gamebar",
    "game bar": "ms-settings:gaming-gamebar",
    "default apps": "ms-settings:defaultapps",
    "startup apps": "ms-settings:startupapps",
}


def _no_window_flags() -> int:
    return int(getattr(subprocess, "CREATE_NO_WINDOW", 0))


def _run_ps(script: str, timeout: int = 8) -> str:
    """Run a PowerShell script body; return stdout text. Keep timeout tight for voice latency."""
    completed = subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ],
        capture_output=True,
        text=True,
        timeout=timeout,
        creationflags=_no_window_flags(),
    )
    out = (completed.stdout or "").strip()
    err = (completed.stderr or "").strip()
    if completed.returncode != 0 and not out:
        raise ToolError(err or f"PowerShell failed (code {completed.returncode}).")
    return out


def _open_uri(uri: str) -> None:
    subprocess.Popen(
        f'start "" "{uri}"',
        shell=True,
        close_fds=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=_no_window_flags()
        | getattr(subprocess, "DETACHED_PROCESS", 0)
        | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
    )


# ---------------------------------------------------------------------------
# WinRT Radio helpers (Bluetooth / Wi‑Fi)
# ---------------------------------------------------------------------------

# Compact WinRT preamble (single launch does access + list — used for status/set/toggle).
_RADIO_PS_PREAMBLE = r"""
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction SilentlyContinue | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  if (-not $netTask.Wait(6000)) { throw 'WinRT timeout' }
  return $netTask.Result
}
[Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null
[Windows.Devices.Radios.RadioAccessStatus,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null
$null = Await ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus])
$radios = Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
"""


def _radio_state(kind: str) -> Optional[str]:
    """Return 'On' / 'Off' / None for radio kind ('Bluetooth' or 'WiFi')."""
    ps = (
        _RADIO_PS_PREAMBLE
        + f"$r = $radios | Where-Object {{ $_.Kind -eq '{kind}' }} | Select-Object -First 1; "
        + "if ($r) { Write-Output $r.State.ToString() } else { Write-Output 'MISSING' }"
    )
    try:
        out = _run_ps(ps, timeout=8)
        if out.upper() == "MISSING" or not out:
            return None
        return out  # On / Off
    except Exception:
        return None


def _set_radio(kind: str, turn_on: bool) -> str:
    """Set radio on/off in ONE PowerShell process (fast path for voice tools)."""
    state = "On" if turn_on else "Off"
    ps = (
        _RADIO_PS_PREAMBLE
        + f"$r = $radios | Where-Object {{ $_.Kind -eq '{kind}' }} | Select-Object -First 1; "
        + "if (-not $r) { Write-Output 'MISSING'; exit 1 }; "
        + f"$null = Await ($r.SetStateAsync('{state}')) ([Windows.Devices.Radios.RadioAccessStatus]); "
        + "Write-Output $r.State.ToString()"
    )
    out = _run_ps(ps, timeout=10)
    if out.upper() == "MISSING":
        raise ToolError(f"No {kind} radio found on this device.")
    return out


def _toggle_or_set_radio(kind: str, want: Optional[bool]) -> str:
    """
    On/off/toggle in a single PowerShell launch.
    Avoids double PS cold-start (status + set) that made Bluetooth feel frozen.
    """
    if want is True:
        target_expr = "'On'"
    elif want is False:
        target_expr = "'Off'"
    else:
        target_expr = "if ($r.State.ToString() -eq 'On') { 'Off' } else { 'On' }"
    ps = (
        _RADIO_PS_PREAMBLE
        + f"$r = $radios | Where-Object {{ $_.Kind -eq '{kind}' }} | Select-Object -First 1; "
        + "if (-not $r) { Write-Output 'MISSING'; exit 1 }; "
        + f"$target = {target_expr}; "
        + "$null = Await ($r.SetStateAsync($target)) ([Windows.Devices.Radios.RadioAccessStatus]); "
        + "Write-Output $r.State.ToString()"
    )
    out = _run_ps(ps, timeout=10)
    if out.upper() == "MISSING":
        raise ToolError(f"No {kind} radio found on this device.")
    return out


def _wifi_interfaces() -> List[str]:
    try:
        out = subprocess.check_output(
            ["netsh", "interface", "show", "interface"],
            text=True,
            timeout=10,
            creationflags=_no_window_flags(),
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return []
    names: List[str] = []
    for line in out.splitlines():
        # Columns: Admin State  State  Type  Interface Name
        if re.search(r"\b(Dedicated|Wireless)\b", line, re.I) or "Wi-Fi" in line or "WiFi" in line:
            parts = line.split()
            if len(parts) >= 4:
                # Interface name is last token(s) — take everything after type column heuristically
                # Typical: Enabled  Connected  Dedicated  Wi-Fi
                name = parts[-1] if parts[-1].lower() not in ("connected", "disconnected") else " ".join(parts[3:])
                # Better: last field after 3 fixed columns — re-parse
                m = re.match(
                    r"^\s*(\S+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$",
                    line,
                )
                if m:
                    name = m.group(4).strip()
                    if name and name.lower() not in ("interface name", "name"):
                        names.append(name)
    # Prefer wireless-looking names first
    names = list(dict.fromkeys(names))  # unique preserve order
    names.sort(key=lambda n: (0 if re.search(r"wi-?fi|wireless", n, re.I) else 1, n.lower()))
    return names


def _set_wifi_netsh(turn_on: bool) -> str:
    admin = "ENABLED" if turn_on else "DISABLED"
    ifaces = _wifi_interfaces()
    # Always try common names
    candidates = ifaces + ["Wi-Fi", "WiFi", "Wireless Network Connection", "WLAN"]
    seen = set()
    last_err = ""
    for name in candidates:
        if not name or name in seen:
            continue
        seen.add(name)
        try:
            completed = subprocess.run(
                ["netsh", "interface", "set", "interface", f"name={name}", f"admin={admin}"],
                capture_output=True,
                text=True,
                timeout=12,
                creationflags=_no_window_flags(),
            )
            if completed.returncode == 0:
                return name
            last_err = (completed.stderr or completed.stdout or "").strip()
        except Exception as e:  # noqa: BLE001
            last_err = str(e)
    raise ToolError(last_err or "Could not change Wi‑Fi via netsh (try running BIKLI as admin).")


def _parse_state(state: Any) -> Optional[bool]:
    """Normalize on/off/true/false/1/0/enable/disable to bool. None = toggle."""
    if state is None:
        return None
    s = str(state).strip().lower()
    if s in ("", "toggle", "switch", "flip"):
        return None
    if s in ("on", "true", "1", "enable", "enabled", "yes"):
        return True
    if s in ("off", "false", "0", "disable", "disabled", "no"):
        return False
    raise ToolError(f"Unknown state '{state}'. Use on, off, or toggle.")


def _normalize_setting(name: str) -> str:
    n = re.sub(r"\s+", " ", (name or "").strip().lower())
    aliases = {
        "bt": "bluetooth",
        "blue tooth": "bluetooth",
        "wi fi": "wifi",
        "wi-fi": "wifi",
        "wireless": "wifi",
        "wlan": "wifi",
        "airplane-mode": "airplane",
        "flight mode": "airplane",
        "flightmode": "airplane",
        "airplanemode": "airplane",
        "dark mode": "darkmode",
        "light mode": "lightmode",
        "night mode": "night light",
    }
    return aliases.get(n, n)


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


@register("systemSetting")
def system_setting(args: Dict[str, Any]) -> Dict[str, Any]:
    """
    Control or open Windows system settings.

    args:
      setting: bluetooth | wifi | airplane | darkmode | lightmode | night light | <settings page>
      action:  on | off | toggle | status | open   (default: on/off from state, else toggle)
      state:   on | off | true | false (optional alias for action)
    """
    setting = _normalize_setting(
        str(args.get("setting") or args.get("name") or args.get("target") or "")
    )
    if not setting:
        raise ToolError(
            "Parameter 'setting' is required "
            "(e.g. bluetooth, wifi, airplane, display, sound)."
        )

    action = str(args.get("action") or "").strip().lower()
    state_arg = args.get("state") if "state" in args else args.get("value")
    # Allow action=on/off as well as state=on/off
    if action in ("on", "off", "enable", "disable", "enabled", "disabled"):
        state_arg = action
        action = "set"
    if not action:
        action = "set" if state_arg is not None else "toggle"
    if action in ("enable", "enabled"):
        action = "set"
        state_arg = "on"
    if action in ("disable", "disabled"):
        action = "set"
        state_arg = "off"

    # --- Bluetooth ---
    if setting == "bluetooth":
        if action == "open":
            _open_uri("ms-settings:bluetooth")
            return {"result": "Opened Bluetooth settings."}
        if action == "status":
            st = _radio_state("Bluetooth")
            if st is None:
                _open_uri("ms-settings:bluetooth")
                return {
                    "result": "Could not read Bluetooth radio state; opened Bluetooth settings.",
                    "state": "unknown",
                }
            return {"result": f"Bluetooth is {st}.", "state": st.lower()}
        want = _parse_state(state_arg)
        try:
            # Single PowerShell launch for on/off/toggle (no double cold-start)
            new_st = _toggle_or_set_radio("Bluetooth", want)
        except ToolError:
            # Fallback: open settings page so user can flip it
            _open_uri("ms-settings:bluetooth")
            raise ToolError(
                "Could not toggle Bluetooth automatically "
                "(radio API unavailable). Opened Bluetooth settings for you."
            )
        return {
            "result": f"Bluetooth is now {new_st}.",
            "state": new_st.lower(),
            "setting": "bluetooth",
        }

    # --- Wi‑Fi ---
    if setting in ("wifi", "wi-fi"):
        if action == "open":
            _open_uri("ms-settings:network-wifi")
            return {"result": "Opened Wi‑Fi settings."}
        if action == "status":
            st = _radio_state("WiFi")
            if st:
                return {"result": f"Wi‑Fi is {st}.", "state": st.lower()}
            return {"result": "Wi‑Fi status unknown (radio API unavailable).", "state": "unknown"}
        want = _parse_state(state_arg)
        # Prefer radio API (one PS launch); fall back to netsh
        try:
            new_st = _toggle_or_set_radio("WiFi", want)
            return {
                "result": f"Wi‑Fi is now {new_st}.",
                "state": new_st.lower(),
                "setting": "wifi",
            }
        except Exception:
            try:
                # For netsh fallback, resolve toggle to a concrete want
                if want is None:
                    cur = _radio_state("WiFi")
                    want = False if (cur or "").lower() == "on" else True
                iface = _set_wifi_netsh(bool(want))
                verb = "on" if want else "off"
                return {
                    "result": f"Wi‑Fi interface '{iface}' turned {verb}.",
                    "state": "on" if want else "off",
                    "setting": "wifi",
                }
            except ToolError as e:
                _open_uri("ms-settings:network-wifi")
                raise ToolError(
                    f"Could not change Wi‑Fi automatically ({e.message}). "
                    "Opened Wi‑Fi settings."
                ) from e

    # --- Airplane mode (best-effort via radio off / settings page) ---
    if setting in ("airplane", "airplane mode"):
        if action in ("open", "status") or _parse_state(state_arg) is None and action != "set":
            if action == "status":
                _open_uri("ms-settings:network-airplanemode")
                return {
                    "result": "Opened Airplane mode settings (status is UI-only on this Windows build).",
                }
            _open_uri("ms-settings:network-airplanemode")
            return {"result": "Opened Airplane mode settings."}
        want = _parse_state(state_arg)
        if want is True:
            # Turning airplane on ≈ radios off
            msgs = []
            for kind in ("Bluetooth", "WiFi"):
                try:
                    _set_radio(kind, False)
                    msgs.append(f"{kind} off")
                except Exception:
                    pass
            _open_uri("ms-settings:network-airplanemode")
            return {
                "result": "Airplane mode: radios disabled where possible; opened Airplane settings. "
                + (f"({', '.join(msgs)})" if msgs else ""),
            }
        if want is False:
            for kind in ("WiFi", "Bluetooth"):
                try:
                    _set_radio(kind, True)
                except Exception:
                    pass
            _open_uri("ms-settings:network-airplanemode")
            return {
                "result": "Tried to restore radios; opened Airplane mode settings to confirm it's off.",
            }
        _open_uri("ms-settings:network-airplanemode")
        return {"result": "Opened Airplane mode settings."}

    # --- Dark / light mode (apps + system theme) ---
    if setting in ("darkmode", "dark", "lightmode", "light", "theme"):
        if action == "open":
            _open_uri("ms-settings:personalization-colors")
            return {"result": "Opened color / theme settings."}

        def _is_light_theme() -> bool:
            try:
                cur = _run_ps(
                    "(Get-ItemProperty -Path "
                    "'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize' "
                    "-Name AppsUseLightTheme).AppsUseLightTheme"
                )
                return str(cur).strip() == "1"
            except Exception:
                return True

        want_dark: bool
        if setting in ("darkmode", "dark"):
            if action == "toggle":
                want_dark = _is_light_theme()  # currently light -> switch to dark
            elif action == "set":
                parsed = _parse_state(state_arg)
                want_dark = True if parsed is None else bool(parsed)
            else:
                want_dark = True
        elif setting in ("lightmode", "light"):
            if action == "toggle":
                want_dark = not _is_light_theme()
            elif action == "set":
                parsed = _parse_state(state_arg)
                # lightmode state=on means light (dark=False)
                want_dark = False if parsed is not False else True
            else:
                want_dark = False
        else:  # theme
            s = str(state_arg or "").lower()
            if action == "toggle":
                want_dark = _is_light_theme()
            elif "light" in s:
                want_dark = False
            elif "dark" in s:
                want_dark = True
            else:
                want_dark = True

        value = 0 if want_dark else 1
        ps = (
            "Set-ItemProperty -Path "
            "'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize' "
            f"-Name AppsUseLightTheme -Value {value}; "
            "Set-ItemProperty -Path "
            "'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize' "
            f"-Name SystemUsesLightTheme -Value {value}; "
            "Write-Output 'OK'"
        )
        _run_ps(ps)
        mode = "dark" if want_dark else "light"
        return {"result": f"Windows theme set to {mode} mode.", "state": mode}

    # --- Night light: open settings (API is undocumented / fragile) ---
    if setting in ("night light", "nightlight"):
        _open_uri("ms-settings:nightlight")
        verb = action if action in ("on", "off", "toggle", "open", "status") else "open"
        return {
            "result": f"Opened Night light settings ({verb}). "
            "Toggle Night light from that page if it did not switch automatically.",
        }

    # --- Generic settings page open ---
    if setting in SETTINGS_PAGES or action == "open":
        uri = SETTINGS_PAGES.get(setting)
        if not uri:
            # fuzzy page match
            for key, u in SETTINGS_PAGES.items():
                if key in setting or setting in key:
                    uri = u
                    break
        if not uri:
            # Try ms-settings:<name>
            slug = re.sub(r"[^a-z0-9\-]+", "-", setting).strip("-")
            uri = f"ms-settings:{slug}" if slug else "ms-settings:"
        _open_uri(uri)
        return {"result": f"Opened Windows settings: {setting}.", "uri": uri}

    raise ToolError(
        f"Unknown setting '{setting}'. "
        "Try: bluetooth, wifi, airplane, darkmode, lightmode, night light, "
        "display, sound, network, privacy, update."
    )


@register("openWindowsSetting")
def open_windows_setting(args: Dict[str, Any]) -> Dict[str, Any]:
    """Open a Windows Settings page by name (alias of systemSetting action=open)."""
    name = args.get("name") or args.get("setting") or args.get("page") or "settings"
    return system_setting({"setting": name, "action": "open"})


@register("toggleBluetooth")
def toggle_bluetooth(args: Dict[str, Any]) -> Dict[str, Any]:
    """Convenience: on/off/toggle Bluetooth."""
    state = args.get("state") or args.get("action") or "toggle"
    if str(state).lower() in ("toggle", "switch"):
        return system_setting({"setting": "bluetooth", "action": "toggle"})
    return system_setting({"setting": "bluetooth", "action": "set", "state": state})


@register("toggleWifi")
def toggle_wifi(args: Dict[str, Any]) -> Dict[str, Any]:
    """Convenience: on/off/toggle Wi‑Fi."""
    state = args.get("state") or args.get("action") or "toggle"
    if str(state).lower() in ("toggle", "switch"):
        return system_setting({"setting": "wifi", "action": "toggle"})
    return system_setting({"setting": "wifi", "action": "set", "state": state})


__all__ = [
    "system_setting",
    "open_windows_setting",
    "toggle_bluetooth",
    "toggle_wifi",
    "SETTINGS_PAGES",
]
