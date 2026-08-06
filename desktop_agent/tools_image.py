"""
Image Generation & PC Saver tool.

Generates AI images from text prompts, saves them to the real user profile
folders (Pictures/Bikli_Images or Desktop), and opens them in Windows Photo Viewer.
"""

from __future__ import annotations

import os
import random
import re
import subprocess
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict

from .registry import ToolError, register

HOME = Path(os.path.expanduser("~"))

def _resolve_user_picture_folder(folder_name: str = "Pictures") -> Path:
    """Find real user Pictures, Desktop, or Downloads directory."""
    fn_lower = (folder_name or "Pictures").strip().lower()
    
    if "desktop" in fn_lower:
        candidates = [HOME / "Desktop", Path(os.environ.get("OneDrive", "")) / "Desktop"]
    elif "download" in fn_lower:
        candidates = [HOME / "Downloads"]
    elif "document" in fn_lower:
        candidates = [HOME / "Documents", Path(os.environ.get("OneDrive", "")) / "Documents"]
    else:
        candidates = [HOME / "Pictures", Path(os.environ.get("OneDrive", "")) / "Pictures"]
    
    for c in candidates:
        if c.is_dir():
            out_dir = c / "Bikli_Images" if "picture" in fn_lower or "desktop" in fn_lower else c
            try:
                out_dir.mkdir(parents=True, exist_ok=True)
                return out_dir
            except Exception:
                pass
    
    # Fallback to home/Pictures
    fallback = HOME / "Pictures" / "Bikli_Images"
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback

def _slugify(text: str) -> str:
    """Create a clean filename slug from a prompt."""
    cleaned = re.sub(r'[^\w\s-]', '', text.lower()).strip()
    words = cleaned.split()[:5]
    slug = "_".join(words)
    return slug if slug else "generated_image"

@register("generateImage")
def generate_image_handler(args: Dict[str, Any]) -> Dict[str, Any]:
    prompt = str(args.get("prompt") or "").strip()
    if not prompt:
        raise ToolError("Parameter 'prompt' is required for generateImage.")

    folder_name = str(args.get("folder") or "Pictures")
    out_dir = _resolve_user_picture_folder(folder_name)

    filename_arg = str(args.get("filename") or "").strip()
    if filename_arg:
        if not filename_arg.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
            filename_arg += ".jpg"
        clean_name = re.sub(r'[\\/:*?"<>|]', '_', filename_arg)
    else:
        seed_suffix = random.randint(1000, 9999)
        clean_name = f"{_slugify(prompt)}_{seed_suffix}.jpg"

    file_path = out_dir / clean_name

    # Pollinations AI text-to-image API (free, fast, direct image download)
    encoded_prompt = urllib.parse.quote(prompt)
    seed = random.randint(1, 999999)
    img_url = f"https://image.pollinations.ai/prompt/{encoded_prompt}?width=1024&height=1024&seed={seed}&nologo=true"

    try:
        req = urllib.request.Request(
            img_url,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Bikli/1.0",
                "Accept": "image/jpeg,image/png,image/*",
            }
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
            if not data or len(data) < 1000:
                raise ToolError("Image provider returned empty or corrupt data.")
            with open(file_path, "wb") as f:
                f.write(data)
    except Exception as e:
        if isinstance(e, ToolError):
            raise
        raise ToolError(f"Failed to download/generate image: {e}")

    # Open image automatically in Windows Photo Viewer / default app
    abs_path_str = str(file_path.resolve())
    opened = False
    try:
        if os.name == "nt":
            os.startfile(abs_path_str)
            opened = True
        else:
            subprocess.Popen(["xdg-open", abs_path_str])
            opened = True
    except Exception:
        try:
            subprocess.Popen(f'explorer "{abs_path_str}"', shell=True)
            opened = True
        except Exception:
            pass

    status_msg = f"Image successfully generated for '{prompt}' and saved to '{abs_path_str}'."
    if opened:
        status_msg += " Opened image in Photo Viewer."

    return {
        "result": status_msg,
        "path": abs_path_str,
        "filename": file_path.name,
        "prompt": prompt,
        "opened": opened,
        "ok": True,
    }
