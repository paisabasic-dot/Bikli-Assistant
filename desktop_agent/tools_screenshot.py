"""
Screenshot & screen-reading: capture, save, OCR, and read on-screen text.

  takeScreenshot    -> capture full screen, return metadata (+ optional small base64)
  saveScreenshot    -> capture & write to a file under the Screenshots folder
  analyzeScreenshot -> capture, run OCR (pytesseract), return extracted text
  readScreen        -> OCR the active window region + name the active window

Capture uses multiple backends so screenshots work even when one API fails.
OCR requires Tesseract + pytesseract when available; otherwise we still save
the image and return a clear message (never a hard crash).
"""

from __future__ import annotations

import base64
import io
import os
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from .registry import ToolError, register

SCREENSHOTS_DIR = Path(os.path.expanduser("~")) / "Pictures" / "BikliScreenshots"


def _capture() -> "Any":
    """
    Capture the full screen as a PIL Image.
    Tries several methods — ImageGrab all_screens, primary screen, then Win32 GDI.
    """
    errors = []

    # 1) Pillow ImageGrab — all monitors
    try:
        from PIL import ImageGrab

        img = ImageGrab.grab(all_screens=True)
        if img is not None and img.size[0] > 0:
            return img
    except TypeError:
        # Older Pillow without all_screens=
        try:
            from PIL import ImageGrab

            img = ImageGrab.grab()
            if img is not None and img.size[0] > 0:
                return img
        except Exception as e:  # noqa: BLE001
            errors.append(f"ImageGrab: {e}")
    except Exception as e:  # noqa: BLE001
        errors.append(f"ImageGrab(all_screens): {e}")
        try:
            from PIL import ImageGrab

            img = ImageGrab.grab()
            if img is not None and img.size[0] > 0:
                return img
        except Exception as e2:  # noqa: BLE001
            errors.append(f"ImageGrab(primary): {e2}")

    # 2) Win32 BitBlt virtual screen
    try:
        img = _capture_win32()
        if img is not None:
            return img
    except Exception as e:  # noqa: BLE001
        errors.append(f"Win32: {e}")

    # 3) PowerShell + System.Drawing (works without Pillow in some envs)
    try:
        img = _capture_powershell()
        if img is not None:
            return img
    except Exception as e:  # noqa: BLE001
        errors.append(f"PowerShell: {e}")

    raise ToolError(
        "Screen capture failed. Tried ImageGrab, Win32, and PowerShell. "
        + "; ".join(errors[:3])
    )


def _capture_win32() -> "Any":
    """Capture virtual screen via win32ui BitBlt."""
    import win32gui
    import win32ui
    import win32con
    from PIL import Image

    hdesktop = win32gui.GetDesktopWindow()
    # Virtual screen (all monitors)
    left = win32gui.GetSystemMetrics(76)  # SM_XVIRTUALSCREEN
    top = win32gui.GetSystemMetrics(77)  # SM_YVIRTUALSCREEN
    width = win32gui.GetSystemMetrics(78)  # SM_CXVIRTUALSCREEN
    height = win32gui.GetSystemMetrics(79)  # SM_CYVIRTUALSCREEN
    if width <= 0 or height <= 0:
        width = win32gui.GetSystemMetrics(0)
        height = win32gui.GetSystemMetrics(1)
        left, top = 0, 0

    desktop_dc = win32gui.GetWindowDC(hdesktop)
    img_dc = win32ui.CreateDCFromHandle(desktop_dc)
    mem_dc = img_dc.CreateCompatibleDC()
    bmp = win32ui.CreateBitmap()
    bmp.CreateCompatibleBitmap(img_dc, width, height)
    mem_dc.SelectObject(bmp)
    mem_dc.BitBlt((0, 0), (width, height), img_dc, (left, top), win32con.SRCCOPY)

    bmpinfo = bmp.GetInfo()
    bmpstr = bmp.GetBitmapBits(True)
    img = Image.frombuffer(
        "RGB",
        (bmpinfo["bmWidth"], bmpinfo["bmHeight"]),
        bmpstr,
        "raw",
        "BGRX",
        0,
        1,
    )

    mem_dc.DeleteDC()
    win32gui.DeleteObject(bmp.GetHandle())
    img_dc.DeleteDC()
    win32gui.ReleaseDC(hdesktop, desktop_dc)
    return img


def _capture_powershell() -> "Any":
    """Capture via PowerShell System.Windows.Forms.Screen + Bitmap."""
    from PIL import Image

    out = Path(tempfile.gettempdir()) / f"bikli-shot-{int(time.time() * 1000)}.png"
    script = f"""
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save('{str(out).replace("'", "''")}')
$g.Dispose()
$bmp.Dispose()
"""
    script_path = Path(tempfile.gettempdir()) / f"bikli-shot-{int(time.time() * 1000)}.ps1"
    script_path.write_text(script, encoding="utf-8")
    try:
        subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(script_path),
            ],
            check=True,
            capture_output=True,
            timeout=20,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if out.exists() and out.stat().st_size > 0:
            return Image.open(out).convert("RGB")
    finally:
        try:
            script_path.unlink(missing_ok=True)
        except Exception:
            pass
        try:
            if out.exists():
                # Keep file briefly for debugging; delete after load
                out.unlink(missing_ok=True)
        except Exception:
            pass
    return None


def _capture_region(bbox) -> "Any":
    try:
        from PIL import ImageGrab

        try:
            return ImageGrab.grab(bbox=bbox, all_screens=True)
        except TypeError:
            return ImageGrab.grab(bbox=bbox)
    except Exception as e:  # noqa: BLE001
        # Fall back to full capture then crop
        img = _capture()
        try:
            return img.crop(bbox)
        except Exception:
            raise ToolError(f"Region capture failed: {e}") from e


def _active_window_bbox():
    """Return (left, top, right, bottom) of the foreground window, or None."""
    try:
        import win32gui

        hwnd = win32gui.GetForegroundWindow()
        if not hwnd:
            return None
        rect = win32gui.GetWindowRect(hwnd)  # (l, t, r, b)
        return rect
    except Exception:
        return None


def _active_window_title() -> str:
    try:
        import win32gui

        hwnd = win32gui.GetForegroundWindow()
        return win32gui.GetWindowText(hwnd) if hwnd else ""
    except Exception:
        return ""


def _image_to_b64(img, fmt="PNG", quality=70) -> str:
    buf = io.BytesIO()
    if fmt.upper() == "JPEG":
        img.convert("RGB").save(buf, format="JPEG", quality=quality)
    else:
        img.save(buf, format=fmt)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _save_image(img, name: Optional[str] = None) -> Path:
    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    fname = f"{name}-{stamp}.png" if name else f"screenshot-{stamp}.png"
    # sanitize filename
    fname = "".join(c if c.isalnum() or c in "-_." else "_" for c in fname)
    out_path = SCREENSHOTS_DIR / fname
    img.save(out_path, format="PNG")
    return out_path


def _run_ocr(img) -> str:
    try:
        import pytesseract
    except ImportError:
        raise ToolError(
            "OCR unavailable: the 'pytesseract' package is not installed."
        )
    exe = os.environ.get("TESSERACT_PATH") or _find_tesseract_exe()
    if exe:
        pytesseract.pytesseract.tesseract_cmd = exe
    try:
        return pytesseract.image_to_string(img)
    except Exception as e:  # noqa: BLE001
        raise ToolError(
            "OCR failed (is the Tesseract engine installed?). Detail: " + str(e)
        )


def _find_tesseract_exe() -> Optional[str]:
    candidates = [
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return None


def _trim_ocr(text: str, max_chars: int = 1500) -> str:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    out = "\n".join(lines)
    if len(out) > max_chars:
        out = out[:max_chars] + "…"
    return out


@register("takeScreenshot")
def take_screenshot(args: Dict[str, Any]) -> Dict[str, Any]:
    img = _capture()
    # Always save a file so the user has proof + a path even without OCR/vision.
    saved = _save_image(img, args.get("name"))
    include_image = bool(args.get("include_image", False))
    result: Dict[str, Any] = {
        "result": f"Screenshot captured ({img.width}x{img.height}) and saved to {saved}.",
        "width": img.width,
        "height": img.height,
        "path": str(saved),
        "ok": True,
    }
    if include_image:
        max_dim = int(args.get("max_dim", 960))
        if max(img.size) > max_dim:
            ratio = max_dim / max(img.size)
            img_small = img.resize(
                (max(1, int(img.width * ratio)), max(1, int(img.height * ratio)))
            )
        else:
            img_small = img
        result["image_base64"] = _image_to_b64(img_small, fmt="JPEG", quality=55)
        result["image_mime"] = "image/jpeg"
    return result


@register("saveScreenshot")
def save_screenshot(args: Dict[str, Any]) -> Dict[str, Any]:
    img = _capture()
    out_path = _save_image(img, args.get("name"))
    return {
        "result": f"Saved screenshot to {out_path}.",
        "path": str(out_path),
        "ok": True,
        "width": img.width,
        "height": img.height,
    }


@register("analyzeScreenshot")
def analyze_screenshot(args: Dict[str, Any]) -> Dict[str, Any]:
    img = _capture()
    saved = _save_image(img, "analyze")
    try:
        text = _run_ocr(img)
        visible = _trim_ocr(text, int(args.get("max_chars", 1500)))
        if not visible:
            return {
                "result": f"Screenshot saved to {saved}. No readable text found via OCR.",
                "path": str(saved),
                "text": "",
                "ok": True,
            }
        return {
            "result": f"Screenshot analyzed. Saved to {saved}. Visible text below.",
            "path": str(saved),
            "text": visible,
            "ok": True,
        }
    except ToolError as e:
        # Still succeed with path — capture worked even if OCR is missing.
        return {
            "result": (
                f"Screenshot captured and saved to {saved}. "
                f"OCR unavailable: {e.message}. "
                "Describe that the image was saved; user can open the path."
            ),
            "path": str(saved),
            "text": "",
            "ok": True,
            "ocr_error": e.message,
        }


@register("readScreen")
def read_screen(args: Dict[str, Any]) -> Dict[str, Any]:
    """OCR the active window and report its title + visible text."""
    title = _active_window_title()
    bbox = _active_window_bbox()
    if bbox:
        try:
            img = _capture_region(bbox)
        except ToolError:
            img = _capture()
    else:
        img = _capture()
    saved = _save_image(img, "readscreen")
    try:
        text = _run_ocr(img)
        visible = _trim_ocr(text, int(args.get("max_chars", 1500))) or "(no readable text)"
    except ToolError as e:
        return {
            "result": (
                f"Active window: {title or 'unknown'}. "
                f"Screenshot saved to {saved}. OCR unavailable: {e.message}"
            ),
            "active_window": title,
            "path": str(saved),
            "ok": True,
            "ocr_error": e.message,
        }
    return {
        "result": f"Active window '{title or 'unknown'}' — text extracted. Saved {saved}.",
        "active_window": title,
        "text": visible,
        "path": str(saved),
        "ok": True,
    }


__all__ = [
    "take_screenshot",
    "save_screenshot",
    "analyze_screenshot",
    "read_screen",
]
