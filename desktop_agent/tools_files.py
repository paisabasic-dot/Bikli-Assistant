"""
File management: create / read / rename / delete / move / open / search.

Safety model:
  * All paths are resolved with expanduser and normalized to absolute.
  * Friendly aliases like Desktop/, Documents/, Downloads/ always map to the
    REAL Windows user folders (never the agent's working directory).
  * Deletion sends files/folders to the Recycle Bin via `send2trash` when
    available (preferred), and otherwise refuses to delete rather than
    permanently removing data.
  * Operations are confined to a set of SAFE_ROOTS by default; paths that
    escape these roots (e.g. C:\\Windows) are rejected unless explicitly
    marked `allow_anywhere` by the caller.
"""

from __future__ import annotations

import fnmatch
import os
import platform
import re
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .registry import ToolError, register

HOME = Path(os.path.expanduser("~"))


def _is_true(value: Any) -> bool:
    """Parse a boolean that may arrive as a bool, int, or STRING.

    `bool("false")` is True in Python, which made deleteFile(permanent="false")
    permanently delete files the model meant to recycle. Treat string forms of
    false/0/no/off as False.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value).strip().lower() not in ("", "0", "false", "no", "off", "none", "null")


def _windows_known_folder(folder_id: str) -> Optional[Path]:
    """Resolve a Windows Known Folder GUID via SHGetKnownFolderPath.

    Returns None on non-Windows or if the call fails. This correctly finds
    OneDrive-redirected Desktop/Documents when the shell has moved them.
    """
    if platform.system() != "Windows":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class GUID(ctypes.Structure):
            _fields_ = [
                ("Data1", wintypes.DWORD),
                ("Data2", wintypes.WORD),
                ("Data3", wintypes.WORD),
                ("Data4", wintypes.BYTE * 8),
            ]

            def __init__(self, guid_str: str) -> None:
                super().__init__()
                # "{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}"
                g = guid_str.strip("{}")
                parts = g.split("-")
                self.Data1 = int(parts[0], 16)
                self.Data2 = int(parts[1], 16)
                self.Data3 = int(parts[2], 16)
                tail = parts[3] + parts[4]
                for i in range(8):
                    self.Data4[i] = int(tail[i * 2 : i * 2 + 2], 16)

        # https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid
        FOLDERIDS = {
            "Desktop": "{B4BFCC3A-DB2C-424C-B029-7FE99A87C641}",
            "Documents": "{FDD39AD0-238F-46AF-ADB4-6C85480369C7}",
            "Downloads": "{374DE290-123F-4565-9164-39C4925E467B}",
            "Pictures": "{33E28130-4E1E-4676-835A-98395C3BC3BB}",
            "Music": "{4BD8D571-6D19-48D3-BE97-422220080E43}",
            "Videos": "{18989B1D-99B5-455B-841C-AB7C74E4DDFC}",
            "Profile": "{5E6C858F-0E22-4760-9AFE-EA3317B67173}",
        }
        guid_str = FOLDERIDS.get(folder_id)
        if not guid_str:
            return None

        shell32 = ctypes.windll.shell32  # type: ignore[attr-defined]
        ole32 = ctypes.windll.ole32  # type: ignore[attr-defined]
        shell32.SHGetKnownFolderPath.argtypes = [
            ctypes.POINTER(GUID),
            wintypes.DWORD,
            wintypes.HANDLE,
            ctypes.POINTER(ctypes.c_wchar_p),
        ]
        shell32.SHGetKnownFolderPath.restype = ctypes.HRESULT

        fid = GUID(guid_str)
        path_ptr = ctypes.c_wchar_p()
        hr = shell32.SHGetKnownFolderPath(ctypes.byref(fid), 0, 0, ctypes.byref(path_ptr))
        if hr != 0 or not path_ptr.value:
            return None
        result = Path(path_ptr.value)
        ole32.CoTaskMemFree(path_ptr)
        return result
    except Exception:
        return None


def _user_folder(name: str, *fallback_parts: str) -> Path:
    """Real user folder path (Desktop, Documents, …), never the agent cwd."""
    known = _windows_known_folder(name)
    if known is not None:
        return known
    # Fallback chain: ~/Name, then OneDrive variants for Desktop/Documents.
    candidates = [HOME.joinpath(*fallback_parts)]
    onedrive = os.environ.get("OneDrive") or os.environ.get("OneDriveConsumer")
    if onedrive and name in ("Desktop", "Documents", "Pictures", "Music", "Videos"):
        candidates.append(Path(onedrive) / name)
    for c in candidates:
        if c.exists():
            return c
    return candidates[0]


# Real Windows shell folders (resolved once at import).
REAL_DESKTOP = _user_folder("Desktop", "Desktop")
REAL_DOCUMENTS = _user_folder("Documents", "Documents")
REAL_DOWNLOADS = _user_folder("Downloads", "Downloads")
REAL_PICTURES = _user_folder("Pictures", "Pictures")
REAL_MUSIC = _user_folder("Music", "Music")
REAL_VIDEOS = _user_folder("Videos", "Videos")
REAL_HOME = _windows_known_folder("Profile") or HOME

# Roots under which file operations are freely permitted.
SAFE_ROOTS: List[Path] = [
    REAL_HOME,
    REAL_DESKTOP,
    REAL_DOCUMENTS,
    REAL_DOWNLOADS,
    REAL_PICTURES,
    REAL_MUSIC,
    REAL_VIDEOS,
    Path(os.getcwd()),  # project / agent root (coding tools may write here)
]

# Friendly folder aliases -> resolved path.
# Keys must be lowercase single path segments (first component of a path).
FOLDER_ALIASES: Dict[str, Path] = {
    "desktop": REAL_DESKTOP,
    "documents": REAL_DOCUMENTS,
    "docs": REAL_DOCUMENTS,
    "downloads": REAL_DOWNLOADS,
    "download": REAL_DOWNLOADS,
    "pictures": REAL_PICTURES,
    "photos": REAL_PICTURES,
    "music": REAL_MUSIC,
    "videos": REAL_VIDEOS,
    "home": REAL_HOME,
    "~": REAL_HOME,
    "this pc": Path("C:\\") if platform.system() == "Windows" else Path("/"),
    "c drive": Path("C:\\") if platform.system() == "Windows" else Path("/"),
}

# Multi-word aliases only used by openFolder / listFiles exact-name lookup.
_MULTIWORD_ALIASES: Dict[str, Path] = {
    "this pc": Path("C:\\") if platform.system() == "Windows" else Path("/"),
    "c drive": Path("C:\\") if platform.system() == "Windows" else Path("/"),
    "my documents": REAL_DOCUMENTS,
    "my pictures": REAL_PICTURES,
}


def _normalize_raw(path: str) -> str:
    """Expand ~ / env vars and normalize separators; strip quotes."""
    raw = str(path).strip().strip('"').strip("'")
    raw = os.path.expanduser(raw)  # ~ only, NOT expandvars — prevents env-var leakage
    # Unify separators so "Desktop/foo" and "Desktop\\foo" both work.
    raw = raw.replace("/", os.sep).replace("\\", os.sep)
    # Collapse accidental leading ".\" / "./"
    while raw.startswith("." + os.sep):
        raw = raw[2:]
    return raw


def _split_drive_aware(raw: str) -> Tuple[Optional[str], List[str]]:
    """Split into (drive_or_None, parts) without resolving against cwd."""
    p = Path(raw)
    if p.is_absolute() or (len(raw) >= 2 and raw[1] == ":"):
        # Absolute (incl. Windows drive letter). Keep Path's parts.
        parts = list(p.parts)
        return (p.drive or None, parts)
    parts = [x for x in raw.split(os.sep) if x and x != "."]
    return (None, parts)


def resolve_user_path(path: Optional[str], *, must_exist: bool = False) -> Path:
    """Resolve a user-facing path to a real absolute filesystem path.

    Critical behaviour (the bug this fixes):
      * "Desktop/notes.txt"  ->  %USERPROFILE%\\Desktop\\notes.txt  (REAL Desktop)
      * "Documents/a.txt"    ->  real Documents folder
      * "~/foo.txt"          ->  home/foo.txt
      * "C:\\Users\\...\\x"  ->  absolute, unchanged
      * bare "notes.txt"     ->  real Desktop/notes.txt  (user-visible default)

    Never resolves relative user paths against the agent process cwd, which is
    the install/project folder and is NOT the user's Desktop.
    """
    if not path:
        raise ToolError("Parameter 'path' is required.")

    raw = _normalize_raw(str(path))
    if not raw:
        raise ToolError("Parameter 'path' is required.")

    # Exact multi-word alias (e.g. "this pc") — whole string is the folder.
    key_full = raw.strip().lower()
    if key_full in _MULTIWORD_ALIASES:
        resolved = _MULTIWORD_ALIASES[key_full]
        if must_exist and not resolved.exists():
            raise ToolError(f"Path does not exist: {resolved}")
        return resolved
    if key_full in FOLDER_ALIASES:
        resolved = FOLDER_ALIASES[key_full]
        if must_exist and not resolved.exists():
            raise ToolError(f"Path does not exist: {resolved}")
        return resolved

    drive, parts = _split_drive_aware(raw)

    # Absolute path (drive letter, UNC, or rooted).
    if drive is not None or (parts and parts[0] in ("/", "\\")) or raw.startswith(os.sep):
        resolved = Path(raw).resolve()
    elif parts:
        first = parts[0].lower()
        if first in FOLDER_ALIASES:
            base = FOLDER_ALIASES[first]
            rest = parts[1:]
            resolved = (base.joinpath(*rest) if rest else base).resolve()
        else:
            # Bare relative path with no known-folder prefix:
            # put it on the REAL Desktop so the user can see it in File Explorer.
            resolved = (REAL_DESKTOP.joinpath(*parts)).resolve()
    else:
        raise ToolError(f"Could not resolve path: {path}")

    if must_exist and not resolved.exists():
        raise ToolError(f"File does not exist: {resolved}")
    return resolved


def _resolve_folder(name_or_path: Optional[str]) -> Path:
    if not name_or_path:
        raise ToolError("Parameter 'name' or 'path' is required.")
    return resolve_user_path(name_or_path)


def _resolve_file(path: Optional[str], *, must_exist: bool = False) -> Path:
    return resolve_user_path(path, must_exist=must_exist)


def _ensure_safe(p: Path, allow_anywhere: bool = False) -> None:
    if allow_anywhere:
        return
    try:
        real = str(p.resolve())
    except Exception:
        real = str(p)
    for root in SAFE_ROOTS:
        try:
            root_real = str(root.resolve())
        except Exception:
            continue
        if real == root_real or real.startswith(root_real + os.sep):
            return
    raise ToolError(
        f"Path '{p}' is outside BIKLI's safe folders (Desktop, Documents, "
        f"Downloads, Pictures, Music, Videos, home, and the project folder). "
        f"Pass allow_anywhere=true only if you really mean it."
    )


# Real Office formats need dedicated tools (createFile only writes plain text).
_OFFICE_EXT_HINTS = {
    ".docx": "createWordFile",
    ".doc": "createWordFile",
    ".xlsx": "createExcelFile",
    ".xls": "createExcelFile",
    ".pptx": "createPowerPointFile",
    ".ppt": "createPowerPointFile",
}


@register("createFile")
def create_file(args: Dict[str, Any]) -> Dict[str, Any]:
    path = args.get("path")
    content = args.get("content", "")
    overwrite = bool(args.get("overwrite", False))
    p = _resolve_file(path)
    _ensure_safe(p)

    # Block fake Office files: writing text to .docx/.xlsx/.pptx produces
    # corrupt documents that Word/Excel/PowerPoint cannot open.
    office_tool = _OFFICE_EXT_HINTS.get(p.suffix.lower())
    if office_tool:
        raise ToolError(
            f"Cannot create real Office file with createFile (that only writes plain text). "
            f"Use '{office_tool}' instead for '{p.suffix}' files. "
            f"Example: {office_tool}(path='{p.name}', ...)."
        )

    if p.exists() and not overwrite:
        raise ToolError(
            f"File already exists: {p}. Pass overwrite=true to replace it."
        )
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(str(content), encoding="utf-8")
    return {
        "result": f"Created file on your PC: {p}",
        "path": str(p),
        "folder": str(p.parent),
    }


def _open_path_with_notepad(file_path: Path) -> None:
    """Open a file in Notepad without keyboard typing (silent file open)."""
    target = str(file_path)
    if platform.system() == "Windows":
        # notepad.exe <file> writes/shows content already on disk — no typeText.
        try:
            subprocess.Popen(
                ["notepad.exe", target],
                close_fds=True,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=int(
                    getattr(subprocess, "DETACHED_PROCESS", 0)
                    | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                ),
            )
            return
        except Exception:
            pass
        try:
            os.startfile(target)  # type: ignore[attr-defined]
            return
        except Exception as e:  # noqa: BLE001
            raise ToolError(f"Could not open Notepad for {target}: {e}") from e
    # Non-Windows best effort
    opener = "open" if platform.system() == "Darwin" else "xdg-open"
    try:
        subprocess.Popen([opener, target], close_fds=True)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Could not open {target}: {e}") from e


@register("writeToNotepad")
def write_to_notepad(args: Dict[str, Any]) -> Dict[str, Any]:
    """Write full content to a .txt file then open it in Notepad.

    Background-safe: never types keystroke-by-keystroke into Notepad.
    Use for 'write a story in notepad', 'make a note', etc.
    """
    content = args.get("content")
    if content is None:
        content = args.get("text") or args.get("story") or ""
    content = str(content)
    if not content.strip():
        raise ToolError(
            "Parameter 'content' is required (the full story/note text to write)."
        )

    raw_path = args.get("path") or args.get("filename")
    if raw_path:
        p = _resolve_file(str(raw_path))
    else:
        # Optional title-like name → Desktop/<safe>.txt (not expanded as a folder alias)
        title = str(args.get("name") or args.get("title") or "").strip()
        if title:
            safe = re.sub(r'[<>:"/\\|?*]+', "", title).strip() or "BikliNote"
            if not safe.lower().endswith(".txt"):
                safe = f"{safe}.txt"
            p = resolve_user_path(f"Desktop/{safe}")
        else:
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            p = resolve_user_path(f"Desktop/BikliNote-{stamp}.txt")

    # Force .txt for notepad notes unless user gave another text-like ext
    if not p.suffix:
        p = p.with_suffix(".txt")
    elif p.suffix.lower() in (".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt"):
        raise ToolError(
            f"writeToNotepad is for plain text only. Use createWordFile/createExcelFile "
            f"for '{p.suffix}' files."
        )

    _ensure_safe(p)
    overwrite = bool(args.get("overwrite", True))  # stories usually replace
    if p.exists() and not overwrite:
        raise ToolError(f"File already exists: {p}. Pass overwrite=true to replace.")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")

    open_it = args.get("open", True)
    if open_it is False or str(open_it).lower() in ("0", "false", "no"):
        return {
            "result": f"Wrote note (Notepad not opened): {p}",
            "path": str(p),
            "folder": str(p.parent),
            "opened": False,
        }

    _open_path_with_notepad(p)
    return {
        "result": f"Wrote story/note and opened in Notepad: {p}",
        "path": str(p),
        "folder": str(p.parent),
        "opened": True,
        "method": "file_write",  # not typeText
    }


@register("readFile")
def read_file(args: Dict[str, Any]) -> Dict[str, Any]:
    path = args.get("path")
    max_chars = int(args.get("max_chars", 8000))
    p = _resolve_file(path, must_exist=True)
    _ensure_safe(p)
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except UnicodeDecodeError:
        return {"result": f"(Binary file, {p.stat().st_size} bytes): {p}"}
    if len(text) > max_chars:
        text = text[:max_chars] + f"\n…[truncated, {len(text) - max_chars} more chars]"
    return {"result": text, "path": str(p)}


@register("renameFile")
def rename_file(args: Dict[str, Any]) -> Dict[str, Any]:
    path = args.get("path")
    new_name = args.get("new_name")
    if not new_name:
        raise ToolError("Parameter 'new_name' is required.")
    p = _resolve_file(path, must_exist=True)
    _ensure_safe(p)
    target = (p.parent / str(new_name)).resolve()
    _ensure_safe(target)
    if target.exists():
        raise ToolError(f"A file already exists at the target name: {target}")
    p.rename(target)
    return {"result": f"Renamed {p.name} -> {target.name}", "path": str(target)}


@register("deleteFile")
def delete_file(args: Dict[str, Any]) -> Dict[str, Any]:
    path = args.get("path")
    permanent = _is_true(args.get("permanent", False))
    p = _resolve_file(path, must_exist=True)
    _ensure_safe(p)

    if permanent:
        if p.is_dir():
            import shutil

            shutil.rmtree(p)
        else:
            p.unlink()
        return {"result": f"Permanently deleted: {p}"}

    # Prefer recycle bin.
    try:
        import send2trash  # type: ignore

        send2trash.send2trash(str(p))
        return {"result": f"Moved to Recycle Bin: {p}"}
    except ImportError:
        raise ToolError(
            "Safe deletion requires the 'send2trash' package. Install it or pass "
            "permanent=true (use with care)."
        )
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Could not move to Recycle Bin: {e}")


@register("moveFile")
def move_file(args: Dict[str, Any]) -> Dict[str, Any]:
    path = args.get("path")
    destination = args.get("destination")
    p = _resolve_file(path, must_exist=True)
    _ensure_safe(p)
    dest = resolve_user_path(str(destination))
    # If destination is an existing directory, keep the filename.
    if dest.is_dir():
        dest = dest / p.name
    _ensure_safe(dest)
    if dest.exists():
        raise ToolError(f"Destination already exists: {dest}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    p.rename(dest)
    return {"result": f"Moved {p.name} -> {dest}", "path": str(dest)}


def _want_new_explorer_window(args: Dict[str, Any]) -> bool:
    """True only when the user/model explicitly asked for a NEW Explorer window."""
    if args.get("new_window") is True or args.get("new") is True:
        return True
    for key in ("new_window", "new", "mode", "window", "open_mode"):
        v = str(args.get(key) or "").strip().lower().replace("-", " ").replace("_", " ")
        if v in (
            "new",
            "new window",
            "newwindow",
            "true",
            "1",
            "yes",
            "force new",
            "open in new",
            "open new",
        ):
            return True
    # Phrase stuck on the folder name: "downloads in new window"
    for key in ("name", "path", "folder"):
        v = str(args.get(key) or "").strip().lower()
        if re.search(r"\b(in\s+a?\s*new(\s+window)?|new\s+window|open\s+new)\b", v):
            return True
    return False


def navigate_or_open_explorer(
    folder: Optional[Path] = None,
    *,
    new_window: bool = False,
    focus_only: bool = False,
) -> Dict[str, Any]:
    """Reuse an existing File Explorer window when possible.

    Default behaviour (new_window=False):
      * If any explorer.exe window is open → Navigate it to ``folder`` (or just
        focus it when focus_only / no folder) and bring it to the front.
      * If none is open → open one window for that folder (or default Explorer).

    Only when new_window=True do we always spawn a brand-new Explorer window.
    """
    target = str(folder) if folder is not None else ""

    if platform.system() != "Windows":
        if folder is None:
            raise ToolError("Folder path is required on this platform.")
        if platform.system() == "Darwin":
            subprocess.Popen(["open", target], close_fds=True)
        else:
            subprocess.Popen(["xdg-open", target], close_fds=True)
        return {
            "result": f"Opened folder: {target}",
            "path": target or None,
            "mode": "opened",
        }

    # Prefer Shell.Application COM (pywin32) — reliable Navigate + focus.
    try:
        import win32com.client  # type: ignore[import-not-found]
        import win32gui  # type: ignore[import-not-found]
        import win32con  # type: ignore[import-not-found]

        shell = win32com.client.Dispatch("Shell.Application")

        def _explorer_windows() -> List[Any]:
            found: List[Any] = []
            try:
                for w in shell.Windows():
                    try:
                        full = str(getattr(w, "FullName", "") or "").lower()
                        if full.endswith("explorer.exe"):
                            found.append(w)
                    except Exception:
                        continue
            except Exception:
                pass
            return found

        def _focus(w: Any) -> None:
            try:
                hwnd = int(w.HWND)
                if win32gui.IsIconic(hwnd):
                    win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
                win32gui.SetForegroundWindow(hwnd)
            except Exception:
                try:
                    w.Visible = True
                except Exception:
                    pass

        if new_window:
            if target:
                shell.Explore(target)
            else:
                subprocess.Popen(
                    ["explorer.exe"],
                    close_fds=True,
                    creationflags=getattr(subprocess, "DETACHED_PROCESS", 0),
                )
            return {
                "result": (
                    f"Opened a new File Explorer window"
                    + (f" at {target}" if target else "")
                    + "."
                ),
                "path": target or None,
                "mode": "new",
            }

        wins = _explorer_windows()
        if wins:
            w = wins[-1]  # most recently opened explorer window
            if target and not focus_only:
                try:
                    w.Navigate(target)
                except Exception:
                    # Some shell views reject Navigate — fall back to Explore (new).
                    shell.Explore(target)
                    return {
                        "result": f"Opened folder in File Explorer: {target}",
                        "path": target,
                        "mode": "opened",
                    }
            _focus(w)
            if focus_only or not target:
                return {
                    "result": "Brought the existing File Explorer window to the front.",
                    "path": target or None,
                    "mode": "focused",
                }
            return {
                "result": f"Navigated the open File Explorer to {target} (same window).",
                "path": target,
                "mode": "reused",
            }

        # No explorer window yet — open one.
        if target:
            shell.Explore(target)
        else:
            subprocess.Popen(
                ["explorer.exe"],
                close_fds=True,
                creationflags=getattr(subprocess, "DETACHED_PROCESS", 0),
            )
        return {
            "result": (
                f"Opened File Explorer"
                + (f" at {target}" if target else "")
                + "."
            ),
            "path": target or None,
            "mode": "opened",
        }
    except Exception:
        pass

    # PowerShell COM fallback (works even without pywin32 import quirks).
    ps_path = target.replace("'", "''")
    ps = f"""
$ErrorActionPreference = 'SilentlyContinue'
$shell = New-Object -ComObject Shell.Application
$newWindow = ${str(bool(new_window)).lower()}
$focusOnly = ${str(bool(focus_only)).lower()}
$target = '{ps_path}'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BikliExplorerFocus {{
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}}
"@

function Get-ExplorerWins {{
  $list = New-Object System.Collections.ArrayList
  foreach ($w in @($shell.Windows())) {{
    try {{
      $fn = [string]$w.FullName
      if ($fn -and ($fn -match 'explorer\\.exe$')) {{ [void]$list.Add($w) }}
    }} catch {{}}
  }}
  return ,$list.ToArray()
}}

function Focus-Win($w) {{
  try {{
    $hwnd = [IntPtr]([int64]$w.HWND)
    if ([BikliExplorerFocus]::IsIconic($hwnd)) {{ [void][BikliExplorerFocus]::ShowWindow($hwnd, 9) }}
    [void][BikliExplorerFocus]::SetForegroundWindow($hwnd)
  }} catch {{}}
}}

if ($newWindow) {{
  if ($target) {{ Start-Process explorer.exe -ArgumentList "`"$target`"" }}
  else {{ Start-Process explorer.exe }}
  Write-Output 'new'
  exit 0
}}

$wins = @(Get-ExplorerWins)
if ($wins.Count -gt 0) {{
  $w = $wins[$wins.Count - 1]
  if ($target -and -not $focusOnly) {{
    try {{ $w.Navigate($target) }} catch {{
      Start-Process explorer.exe -ArgumentList "`"$target`""
      Write-Output 'opened'
      exit 0
    }}
  }}
  Focus-Win $w
  if ($focusOnly -or -not $target) {{ Write-Output 'focused' }} else {{ Write-Output 'reused' }}
  exit 0
}}

if ($target) {{ Start-Process explorer.exe -ArgumentList "`"$target`"" }}
else {{ Start-Process explorer.exe }}
Write-Output 'opened'
"""
    try:
        proc = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                ps,
            ],
            capture_output=True,
            text=True,
            timeout=15,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        mode = (proc.stdout or "").strip().splitlines()[-1].strip().lower() if proc.stdout else "opened"
        if mode not in ("new", "reused", "focused", "opened"):
            mode = "opened"
        messages = {
            "new": f"Opened a new File Explorer window" + (f" at {target}" if target else "") + ".",
            "reused": f"Navigated the open File Explorer to {target} (same window).",
            "focused": "Brought the existing File Explorer window to the front.",
            "opened": f"Opened File Explorer" + (f" at {target}" if target else "") + ".",
        }
        return {"result": messages[mode], "path": target or None, "mode": mode}
    except Exception as e:  # noqa: BLE001
        # Last resort: classic explorer launch (always a new window).
        if target:
            subprocess.Popen(f'explorer "{target}"', shell=True, close_fds=True)
        else:
            subprocess.Popen("explorer", shell=True, close_fds=True)
        return {
            "result": f"Opened File Explorer" + (f" at {target}" if target else "") + f" ({e}).",
            "path": target or None,
            "mode": "opened",
        }


@register("openFolder")
def open_folder(args: Dict[str, Any]) -> Dict[str, Any]:
    # Allow "open File Explorer" with no folder → focus/open Explorer only.
    raw_name = args.get("name") or args.get("path") or args.get("folder")
    raw_str = str(raw_name or "").strip().lower()
    explorer_only = raw_str in (
        "",
        "explorer",
        "file explorer",
        "windows explorer",
        "this pc",
        "computer",
        "my computer",
    )

    new_window = _want_new_explorer_window(args)
    # Strip "in new window" phrases from the folder name if present.
    cleaned = str(raw_name or "").strip()
    if cleaned:
        cleaned = re.sub(
            r"\s*(in\s+a?\s*new(\s+window)?|new\s+window)\s*$",
            "",
            cleaned,
            flags=re.IGNORECASE,
        ).strip()

    if explorer_only or not cleaned:
        return navigate_or_open_explorer(None, new_window=new_window, focus_only=True)

    folder = _resolve_folder(cleaned)
    if not folder.exists():
        raise ToolError(f"Folder does not exist: {folder}")
    return navigate_or_open_explorer(folder, new_window=new_window)


@register("listFiles")
def list_files(args: Dict[str, Any]) -> Dict[str, Any]:
    folder = _resolve_folder(args.get("name") or args.get("path"))
    if not folder.exists():
        raise ToolError(f"Folder does not exist: {folder}")
    pattern = args.get("pattern") or "*"
    try:
        names = sorted(
            [p.name + ("/" if p.is_dir() else "") for p in folder.glob(pattern)]
        )
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Could not list folder: {e}")
    return {
        "result": f"{len(names)} item(s) in {folder}",
        "items": names[:500],
        "count": len(names),
        "path": str(folder),
    }


@register("searchFiles")
def search_files(args: Dict[str, Any]) -> Dict[str, Any]:
    """Find files by name glob or extension under a folder.

    Examples:
      name="*.py" under "Documents"          -> all python files
      extension="py"                          -> same as name="*.py"
      name="report*" under "Desktop"
    """
    folder = _resolve_folder(args.get("folder") or args.get("under") or "home")
    name = args.get("name") or args.get("pattern")
    extension = args.get("extension")
    limit = int(args.get("limit", 100))

    if extension:
        if not str(extension).startswith("."):
            extension = "." + str(extension)
        pattern = "*" + str(extension)
    elif name:
        pattern = str(name)
    else:
        raise ToolError("Provide 'name' glob or 'extension'.")

    if not folder.exists():
        raise ToolError(f"Folder does not exist: {folder}")

    matches: List[str] = []
    for root, _dirs, files in os.walk(folder):
        for fname in files:
            if fnmatch.fnmatch(fname.lower(), pattern.lower()):
                matches.append(os.path.join(root, fname))
                if len(matches) >= limit:
                    break
        if len(matches) >= limit:
            break

    return {
        "result": f"Found {len(matches)} file(s) matching '{pattern}' under {folder}",
        "matches": matches,
        "count": len(matches),
    }


# Image / media extensions for openLocalImage / openFile
_IMAGE_EXTS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".bmp",
    ".heic",
    ".heif",
    ".tif",
    ".tiff",
    ".jfif",
    ".ico",
}


def _open_path_with_default_app(file_path: Path) -> None:
    """Open a local file with the OS default app (Photos, etc.) — no Explorer search."""
    target = str(file_path)
    if platform.system() == "Windows":
        try:
            os.startfile(target)  # type: ignore[attr-defined]
            return
        except Exception:
            pass
        try:
            subprocess.Popen(
                f'start "" "{target}"',
                shell=True,
                close_fds=True,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=int(
                    getattr(subprocess, "DETACHED_PROCESS", 0)
                    | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                ),
            )
            return
        except Exception as e:  # noqa: BLE001
            raise ToolError(f"Could not open file: {e}") from e
    opener = "open" if platform.system() == "Darwin" else "xdg-open"
    try:
        subprocess.Popen([opener, target], close_fds=True)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Could not open file: {e}") from e


def _screenshot_roots() -> List[Path]:
    """Common Windows screenshot / picture folders."""
    roots: List[Path] = []
    candidates = [
        REAL_DESKTOP,
        REAL_PICTURES,
        REAL_PICTURES / "Screenshots",
        REAL_PICTURES / "BikliScreenshots",
        REAL_DOWNLOADS,
        REAL_HOME / "OneDrive" / "Pictures" / "Screenshots",
        REAL_HOME / "OneDrive" / "Desktop",
    ]
    # Env override some installs use
    user_profile = os.environ.get("USERPROFILE") or str(REAL_HOME)
    candidates.append(Path(user_profile) / "Pictures" / "Screenshots")
    seen: set[str] = set()
    for c in candidates:
        try:
            key = str(c.resolve()) if c.exists() else str(c)
        except Exception:
            key = str(c)
        if key.lower() in seen:
            continue
        seen.add(key.lower())
        if c.is_dir():
            roots.append(c)
    return roots


def _collect_images(
    folders: List[Path],
    *,
    name_filter: str = "",
    recursive: bool = True,
    limit: int = 200,
) -> List[Path]:
    """Collect image files, newest first (natural for screenshots)."""
    needle = (name_filter or "").strip().lower()
    # Strip filler words from voice: "the first screenshot" → still filter screenshot
    for junk in (
        "open",
        "the",
        "a",
        "an",
        "my",
        "first",
        "second",
        "third",
        "1st",
        "2nd",
        "3rd",
        "image",
        "photo",
        "picture",
        "file",
        "please",
    ):
        if needle == junk:
            needle = ""
    found: List[Tuple[float, Path]] = []
    seen: set[str] = set()

    def _consider(p: Path) -> None:
        if not p.is_file():
            return
        if p.suffix.lower() not in _IMAGE_EXTS:
            return
        try:
            key = str(p.resolve())
        except Exception:
            key = str(p)
        if key.lower() in seen:
            return
        if needle and needle not in p.name.lower() and needle not in key.lower():
            return
        try:
            mtime = p.stat().st_mtime
        except Exception:
            mtime = 0.0
        seen.add(key.lower())
        found.append((mtime, p))

    for folder in folders:
        if not folder.is_dir():
            continue
        try:
            if recursive:
                for root, _dirs, files in os.walk(folder):
                    # Don't walk huge trees forever
                    depth = Path(root).relative_to(folder).parts
                    if len(depth) > 3:
                        continue
                    for fname in files:
                        _consider(Path(root) / fname)
                        if len(found) >= limit * 3:
                            break
                    if len(found) >= limit * 3:
                        break
            else:
                for p in folder.iterdir():
                    _consider(p)
        except Exception:
            continue

    found.sort(key=lambda t: t[0], reverse=True)  # newest first
    return [p for _m, p in found[:limit]]


@register("openLocalImage")
def open_local_image(args: Dict[str, Any]) -> Dict[str, Any]:
    """Open a local image/screenshot DIRECTLY (default Photos app).

    Use for: 'open first screenshot', 'open second image on desktop',
    'open ScreenShot_TechGPT.png' — never web search / Explorer search box.
    """
    try:
        index = max(1, int(args.get("index") or args.get("n") or args.get("position") or 1))
    except (TypeError, ValueError):
        index = 1

    name = str(
        args.get("name")
        or args.get("filename")
        or args.get("query")
        or args.get("q")
        or ""
    ).strip()
    folder_hint = str(
        args.get("folder") or args.get("path") or args.get("under") or ""
    ).strip()

    # Voice shortcuts: "screenshot" → Pictures/Screenshots + Desktop
    name_l = name.lower()
    wants_screenshot = bool(
        re.search(r"screenshot|screen\s*shot|snipping|snip", name_l)
        or re.search(r"screenshot|screen\s*shot", folder_hint.lower())
    )
    # Clean name filter for matching
    name_filter = name
    if wants_screenshot:
        name_filter = re.sub(
            r"\b(screenshot|screen\s*shot|snipping|snip|image|photo|picture)s?\b",
            " ",
            name,
            flags=re.I,
        )
        name_filter = re.sub(r"\s+", " ", name_filter).strip()

    folders: List[Path] = []
    if folder_hint:
        fl = folder_hint.lower().replace("\\", "/")
        if "screenshot" in fl or fl in ("screenshots", "snips"):
            folders = _screenshot_roots()
        else:
            try:
                folders = [_resolve_folder(folder_hint)]
            except Exception:
                folders = _screenshot_roots() if wants_screenshot else [REAL_DESKTOP, REAL_PICTURES]
    elif wants_screenshot:
        folders = _screenshot_roots()
    else:
        # Default: Desktop + Pictures (+ screenshots) — where users keep photos
        folders = _screenshot_roots()

    images = _collect_images(folders, name_filter=name_filter, recursive=True, limit=150)
    if not images and name_filter:
        # Retry without name filter in same folders
        images = _collect_images(folders, name_filter="", recursive=True, limit=150)
    if not images:
        raise ToolError(
            f"No image files found"
            + (f" matching '{name}'" if name else "")
            + f" under {[str(f) for f in folders[:4]]}. "
            "Try folder='Desktop' or folder='Pictures'."
        )

    if index > len(images):
        raise ToolError(
            f"Only found {len(images)} image(s)"
            + (f" matching '{name}'" if name else "")
            + f"; cannot open #{index}."
        )

    hit = images[index - 1]
    _ensure_safe(hit)
    _open_path_with_default_app(hit)
    return {
        "result": f"Opened image #{index} directly: {hit.name} ({hit})",
        "path": str(hit),
        "name": hit.name,
        "index": index,
        "total": len(images),
        "method": "direct_file",
        "folder": str(hit.parent),
    }


@register("openFile")
def open_file(args: Dict[str, Any]) -> Dict[str, Any]:
    """Open any local file by path or by name search under Desktop/Downloads/etc."""
    raw_path = args.get("path")
    if raw_path:
        p = _resolve_file(str(raw_path), must_exist=True)
        _ensure_safe(p)
        _open_path_with_default_app(p)
        return {
            "result": f"Opened file: {p}",
            "path": str(p),
            "method": "direct_file",
        }

    name = str(args.get("name") or args.get("filename") or args.get("query") or "").strip()
    if not name:
        raise ToolError("Provide 'path' or 'name' of the file to open.")

    # If it looks like an image request, use openLocalImage
    if any(name.lower().endswith(ext) for ext in _IMAGE_EXTS) or re.search(
        r"\b(image|photo|picture|screenshot|png|jpg|jpeg)\b", name, re.I
    ):
        return open_local_image(args)

    try:
        index = max(1, int(args.get("index") or args.get("n") or 1))
    except (TypeError, ValueError):
        index = 1

    folder_hint = str(args.get("folder") or args.get("under") or "Desktop").strip()
    try:
        folder = _resolve_folder(folder_hint)
    except Exception:
        folder = REAL_DESKTOP

    needle = name.lower()
    matches: List[Tuple[float, Path]] = []
    for root, _dirs, files in os.walk(folder):
        depth = Path(root).relative_to(folder).parts if Path(root) != folder else ()
        if len(depth) > 3:
            continue
        for fname in files:
            if needle in fname.lower() or fnmatch.fnmatch(fname.lower(), f"*{needle}*"):
                p = Path(root) / fname
                try:
                    matches.append((p.stat().st_mtime, p))
                except Exception:
                    matches.append((0.0, p))
        if len(matches) >= 80:
            break
    matches.sort(key=lambda t: t[0], reverse=True)
    files_only = [p for _m, p in matches]
    if not files_only:
        raise ToolError(f"No file matching '{name}' under {folder}.")
    if index > len(files_only):
        raise ToolError(f"Only found {len(files_only)} match(es); cannot open #{index}.")
    hit = files_only[index - 1]
    _ensure_safe(hit)
    _open_path_with_default_app(hit)
    return {
        "result": f"Opened file #{index}: {hit.name} ({hit})",
        "path": str(hit),
        "name": hit.name,
        "index": index,
        "method": "direct_file",
    }


__all__ = [
    "create_file",
    "write_to_notepad",
    "read_file",
    "rename_file",
    "delete_file",
    "move_file",
    "open_folder",
    "list_files",
    "search_files",
    "open_local_image",
    "open_file",
    "resolve_user_path",
    "REAL_DESKTOP",
    "REAL_DOCUMENTS",
    "REAL_DOWNLOADS",
    "REAL_HOME",
]
