"""
Search commands: open a search results page for a query on a given engine.

These launch in the user's default browser (separate from the Playwright
automation browser). For form-filling / in-page automation see tools_browser.

playYouTube: scrapes YouTube search results and opens the Nth watch URL so
"play X on YouTube" / "play first video" actually plays a video (not just
the results page).
"""

from __future__ import annotations

import json
import os
import platform
import re
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

from .registry import ToolError, register
from .tools_websites import _build_search_url, open_url

# Remember last successful YouTube query for "play first video" follow-ups.
_LAST_YT_QUERY: str = ""
# Title of last opened video — distinguishes watch page from a new manual search.
_LAST_PLAYED_TITLE: str = ""


def _http_get(url: str, timeout: float = 15.0) -> str:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ),
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _fetch_youtube_results(query: str, limit: int = 15) -> List[Dict[str, str]]:
    q = (query or "").strip()
    if not q:
        return []
    search_url = (
        "https://www.youtube.com/results?search_query="
        + urllib.parse.quote(q)
        + "&hl=en&sp=EgIQAQ%253D%253D"
    )
    html = _http_get(search_url)
    videos: List[Dict[str, str]] = []

    m = re.search(r"ytInitialData\s*=\s*({.+?});", html)
    if m:
        try:
            data = json.loads(m.group(1))
            contents = (
                data.get("contents", {})
                .get("twoColumnSearchResultRenderer", {})
                .get("primaryContents", {})
                .get("sectionListRenderer", {})
                .get("contents", [{}])[0]
                .get("itemSectionRenderer", {})
                .get("contents", [])
            )
            if isinstance(contents, list):
                for item in contents:
                    vr = item.get("videoRenderer") if isinstance(item, dict) else None
                    if not vr:
                        continue
                    vid = vr.get("videoId")
                    if not vid:
                        continue
                    title = "YouTube Video"
                    t = vr.get("title") or {}
                    if isinstance(t.get("runs"), list) and t["runs"]:
                        title = t["runs"][0].get("text") or title
                    elif t.get("simpleText"):
                        title = t["simpleText"]
                    author = "Unknown Channel"
                    for key in ("ownerText", "shortBylineText"):
                        runs = (vr.get(key) or {}).get("runs")
                        if isinstance(runs, list) and runs:
                            author = runs[0].get("text") or author
                            break
                    videos.append(
                        {
                            "videoId": vid,
                            "title": title,
                            "author": author,
                            "duration": (vr.get("lengthText") or {}).get("simpleText")
                            or "N/A",
                        }
                    )
        except Exception:
            videos = []

    if not videos:
        ids: List[str] = []
        for match in re.finditer(r'"videoId":"([^"]+)"', html):
            vid = match.group(1)
            if vid and len(vid) == 11 and vid not in ids:
                ids.append(vid)
            if len(ids) >= limit:
                break
        for vid in ids:
            videos.append(
                {
                    "videoId": vid,
                    "title": f"YouTube video {vid}",
                    "author": "YouTube",
                    "duration": "N/A",
                }
            )

    return videos[:limit]


@register("searchWeb")
def search_web(args: Dict[str, Any]) -> Dict[str, Any]:
    query = args.get("query") or args.get("q")
    engine = (args.get("engine") or "google").strip().lower()
    if not query:
        raise ToolError("Parameter 'query' is required.")
    url = _build_search_url(engine, str(query))
    resolved = open_url(url)
    return {"result": f"Searching {engine} for '{query}': opened {resolved}."}


@register("searchYouTube")
def search_youtube(args: Dict[str, Any]) -> Dict[str, Any]:
    """Open YouTube search RESULTS only — never autoplay a video.

    play/open/playFirst flags from the model are ignored so 'search X on
    YouTube' never starts a video. Use playYouTube for open/play/watch.
    """
    global _LAST_YT_QUERY, _LAST_PLAYED_TITLE, _LAST_PLAY_KEY, _LAST_PLAY_AT
    query = args.get("query") or args.get("q")
    if not query:
        raise ToolError("Parameter 'query' is required.")
    q_str = str(query).strip()
    # Clean accidental command words from the search box
    clean = re.sub(r"\b(search|find|look\s*up|browse)\b", " ", q_str, flags=re.I)
    clean = re.sub(r"\bon\s+youtube\b", " ", clean, flags=re.I)
    clean = re.sub(r"\byoutube\b", " ", clean, flags=re.I)
    clean = re.sub(r"\s+", " ", clean).strip() or q_str
    _LAST_YT_QUERY = clean
    # Fresh search → allow "play first" again even after a prior play.
    _LAST_PLAYED_TITLE = ""
    _LAST_PLAY_KEY = ""
    _LAST_PLAY_AT = 0.0

    url = _build_search_url("youtube", clean)
    resolved = open_url(url)
    return {
        "result": (
            f"YouTube search results for '{clean}' opened (no video autoplay). "
            "Say open the first/second video to play one."
        ),
        "query": clean,
        "url": resolved,
        "autoplay": False,
    }


# Debounce identical play requests so Gemini double-fires don't open two tabs.
_LAST_PLAY_KEY: str = ""
_LAST_PLAY_AT: float = 0.0
_PLAY_DEBOUNCE_SEC = 6.0


def _normalize_yt_title(s: str) -> str:
    t = re.sub(r"[^\w\s]", " ", (s or "").lower())
    return re.sub(r"\s+", " ", t).strip()


def _guess_yt_query_from_browser_title() -> str:
    """Read live YouTube window title so manual searches override stale cache."""
    if platform.system() != "Windows":
        return ""
    script = r"""
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class BikliYtTitlePy {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
}
"@
function Get-WinTitle([IntPtr]$h) {
  if ($h -eq [IntPtr]::Zero) { return '' }
  $sb = New-Object System.Text.StringBuilder 512
  [void][BikliYtTitlePy]::GetWindowText($h, $sb, $sb.Capacity)
  return $sb.ToString()
}
$fg = [BikliYtTitlePy]::GetForegroundWindow()
$fgTitle = Get-WinTitle $fg
if ($fgTitle -and $fgTitle.ToLower().Contains('youtube')) {
  Write-Output $fgTitle
  exit 0
}
$script:best = ''
$script:bestScore = -1
[BikliYtTitlePy]::EnumWindows({
  param($h,$l)
  if (-not [BikliYtTitlePy]::IsWindowVisible($h)) { return $true }
  $t = Get-WinTitle $h
  if (-not $t) { return $true }
  $low = $t.ToLower()
  if (-not $low.Contains('youtube')) { return $true }
  $qPart = ($t -replace '\s*[-|]\s*YouTube.*$','').Trim()
  $score = 10
  if ($qPart.Length -le 28) { $score += 40 }
  elseif ($qPart.Length -le 48) { $score += 20 }
  elseif ($qPart.Length -gt 70) { $score -= 15 }
  if ($score -gt $script:bestScore) { $script:bestScore = $score; $script:best = $t }
  return $true
}, [IntPtr]::Zero) | Out-Null
Write-Output $script:best
"""
    path = ""
    try:
        fd, path = tempfile.mkstemp(suffix=".ps1", prefix="bikli-yt-")
        os.close(fd)
        with open(path, "w", encoding="utf-8") as f:
            f.write(script)
        completed = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                path,
            ],
            capture_output=True,
            text=True,
            timeout=8,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        title = (completed.stdout or "").strip()
        if not title:
            return ""
        q = re.sub(r"\s*[-|]\s*YouTube.*$", "", title, flags=re.I)
        q = re.sub(
            r"\s*-\s*(Google Chrome|Microsoft Edge|Brave|Firefox|Opera|MSEdge).*$",
            "",
            q,
            flags=re.I,
        )
        q = re.sub(r"\s+", " ", q).strip()
        if len(q) < 2 or len(q) > 120:
            return ""
        if re.match(r"^(youtube|home|subscriptions|library|history|trending)$", q, re.I):
            return ""
        return q
    except Exception:
        return ""
    finally:
        if path:
            try:
                os.unlink(path)
            except OSError:
                pass


def _is_likely_watch_page_title(browser_title: str) -> bool:
    t = _normalize_yt_title(browser_title)
    played = _normalize_yt_title(_LAST_PLAYED_TITLE)
    if not t or not played:
        return False
    if t == played:
        return True
    if t in played or played in t:
        return True
    if t[:36] and played[:36] and t[:36] == played[:36]:
        return True
    return False


def _resolve_yt_play_query(requested: str) -> str:
    """Prefer live browser search over stale _LAST_YT_QUERY after manual opens."""
    global _LAST_YT_QUERY, _LAST_PLAY_KEY, _LAST_PLAY_AT
    explicit = (requested or "").strip()
    cached = (_LAST_YT_QUERY or "").strip()
    from_browser = _guess_yt_query_from_browser_title()

    is_explicit_fresh = bool(explicit) and (
        not cached or explicit.lower() != cached.lower()
    )
    if is_explicit_fresh:
        return explicit

    if from_browser:
        if _is_likely_watch_page_title(from_browser):
            return cached or explicit or from_browser
        if not cached or from_browser.lower() != cached.lower():
            _LAST_YT_QUERY = from_browser
            # New manual search — drop debounce for the old query
            if _LAST_PLAY_KEY and not _LAST_PLAY_KEY.startswith(f"{from_browser.lower()}|"):
                _LAST_PLAY_KEY = ""
                _LAST_PLAY_AT = 0.0
            return from_browser
        return from_browser

    return explicit or cached


@register("playYouTube")
def play_youtube(args: Dict[str, Any]) -> Dict[str, Any]:
    """Search YouTube and open the Nth video watch page (actually plays)."""
    global _LAST_YT_QUERY, _LAST_PLAY_KEY, _LAST_PLAY_AT, _LAST_PLAYED_TITLE
    requested = (args.get("query") or args.get("q") or "").strip()
    query = _resolve_yt_play_query(requested or _LAST_YT_QUERY)
    if not query:
        raise ToolError(
            "No YouTube search query. Tell me what to play, e.g. 'play Believer on YouTube'."
        )
    try:
        index = max(1, int(args.get("index") or args.get("n") or args.get("position") or 1))
    except (TypeError, ValueError):
        index = 1

    play_key = f"{query.lower()}|{index}"
    # Same Nth result already opened for this query — do not re-open old search
    # until a new searchYouTube (or a different live browser query) clears the key.
    if play_key == _LAST_PLAY_KEY and _LAST_PLAY_AT > 0:
        return {
            "result": (
                f"Already opened video #{index} for '{query}' — not reopening the old search. "
                "Search something new, or say open the second/third video."
            ),
            "query": query,
            "index": index,
            "debounced": True,
        }

    try:
        results = _fetch_youtube_results(query, limit=max(15, index))
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise ToolError(f"Could not reach YouTube search: {e}") from e

    if not results:
        raise ToolError(f"No YouTube videos found for '{query}'.")
    if index > len(results):
        raise ToolError(
            f"Only found {len(results)} video(s) for '{query}'; cannot play #{index}."
        )

    hit = results[index - 1]
    _LAST_YT_QUERY = query
    _LAST_PLAYED_TITLE = hit.get("title") or ""
    _LAST_PLAY_KEY = play_key
    _LAST_PLAY_AT = time.time()
    watch_url = f"https://www.youtube.com/watch?v={hit['videoId']}&autoplay=1"
    resolved = open_url(watch_url)
    return {
        "result": f"Playing #{index}: \"{hit['title']}\" by {hit['author']} on YouTube.",
        "url": resolved,
        "videoId": hit["videoId"],
        "title": hit["title"],
        "author": hit["author"],
        "query": query,
        "index": index,
    }


@register("searchGoogle")
def search_google(args: Dict[str, Any]) -> Dict[str, Any]:
    query = args.get("query") or args.get("q")
    if not query:
        raise ToolError("Parameter 'query' is required.")
    q = str(query)
    # Image open intent → open direct image URL, not Google search page
    if re.search(r"\b(images?|photos?|pictures?)\b", q, re.I) or args.get("images"):
        clean = re.sub(
            r"\b(open|show|search|find|google|images?|photos?|pictures?|of|for)\b",
            " ",
            q,
            flags=re.I,
        )
        clean = re.sub(r"\s+", " ", clean).strip() or q
        try:
            index = max(1, int(args.get("index") or args.get("n") or 1))
        except (TypeError, ValueError):
            index = 1
        return open_image({"query": clean, "index": index})
    url = _build_search_url("google", q)
    resolved = open_url(url)
    return {"result": f"Google search for '{query}' opened at {resolved}."}


@register("searchGitHub")
def search_github(args: Dict[str, Any]) -> Dict[str, Any]:
    query = args.get("query") or args.get("q")
    if not query:
        raise ToolError("Parameter 'query' is required.")
    url = _build_search_url("github", str(query))
    resolved = open_url(url)
    return {"result": f"GitHub search for '{query}' opened at {resolved}."}


_LAST_IMAGE_QUERY: str = ""


def _normalize_image_url(raw: str) -> str:
    url = (
        str(raw or "")
        .replace("\\u0026", "&")
        .replace("\\/", "/")
        .replace("&amp;", "&")
        .replace("&quot;", "")
        .strip()
        .rstrip(";")
    )
    try:
        url = urllib.parse.unquote(url)
    except Exception:
        pass
    return url


def _push_image(
    hits: List[Dict[str, str]],
    seen: set,
    raw: str,
    limit: int,
) -> None:
    if len(hits) >= limit:
        return
    url = _normalize_image_url(raw)
    if not url.lower().startswith("http"):
        return
    low = url.lower()
    if low in seen:
        return
    if re.search(r"favicon|sprite|logo\.svg|1x1|pixel|r\.bing\.com/rp/", low):
        return
    seen.add(low)
    hits.append({"url": url, "title": f"Image {len(hits) + 1}"})


def _fetch_image_results(query: str, limit: int = 12) -> List[Dict[str, str]]:
    """Find direct image URLs: DuckDuckGo → Bing → Wikimedia."""
    q = (query or "").strip()
    if not q:
        return []
    hits: List[Dict[str, str]] = []
    seen: set = set()

    # 1) DuckDuckGo images JSON
    try:
        home = _http_get(
            "https://duckduckgo.com/?q="
            + urllib.parse.quote(q)
            + "&iax=images&ia=images"
        )
        vqd_m = re.search(r'vqd=["\']([^"\']+)["\']', home) or re.search(
            r"vqd=([\d-]+)", home
        )
        if vqd_m:
            vqd = vqd_m.group(1)
            api = (
                "https://duckduckgo.com/i.js?l=us-en&o=json&q="
                + urllib.parse.quote(q)
                + "&vqd="
                + urllib.parse.quote(vqd)
                + "&f=,,,&p=1"
            )
            raw = _http_get(api)
            data = json.loads(raw)
            for item in data.get("results") or []:
                img = item.get("image") if isinstance(item, dict) else None
                if img:
                    _push_image(hits, seen, img, limit)
                if len(hits) >= limit:
                    break
    except Exception:
        pass

    # 2) Bing Images (HTML-entity murl&quot;:&quot;)
    if len(hits) < limit:
        try:
            search_url = (
                "https://www.bing.com/images/search?q="
                + urllib.parse.quote(q)
                + "&form=HDRSC2&first=1"
            )
            html = _http_get(search_url)
            patterns = [
                r'murl&quot;:&quot;(https?:[^&"<>]+)',
                r'"murl"\s*:\s*"(https?://[^"\\]+)"',
                r"mediaurl=([^&\"'<>]+)",
                r'"turl"\s*:\s*"(https?://[^"\\]+)"',
                r'turl&quot;:&quot;(https?:[^&"<>]+)',
            ]
            for pat in patterns:
                for match in re.finditer(pat, html, re.I):
                    _push_image(hits, seen, match.group(1), limit)
                    if len(hits) >= limit:
                        break
                if len(hits) >= limit:
                    break
        except Exception:
            pass

    # 3) Wikimedia Commons
    if len(hits) < limit:
        try:
            wiki = (
                "https://commons.wikimedia.org/w/api.php?action=query"
                "&generator=search&gsrsearch="
                + urllib.parse.quote(q)
                + f"&gsrlimit={max(limit, 8)}&gsrnamespace=6"
                "&prop=imageinfo&iiprop=url&format=json&origin=*"
            )
            data = json.loads(_http_get(wiki))
            pages = (data.get("query") or {}).get("pages") or {}
            for page in pages.values():
                infos = page.get("imageinfo") or []
                if infos and infos[0].get("url"):
                    _push_image(hits, seen, infos[0]["url"], limit)
                if len(hits) >= limit:
                    break
        except Exception:
            pass

    return hits[:limit]


def _unblock_windows_file(path: str) -> None:
    """Clear Mark-of-the-Web so Windows does not show 'untrusted source'."""
    if platform.system() != "Windows" or not path:
        return
    try:
        # Zone.Identifier alternate data stream
        zone = path + ":Zone.Identifier"
        if os.path.exists(zone):
            os.remove(zone)
    except OSError:
        pass
    try:
        lit = path.replace("'", "''")
        subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                f"Unblock-File -LiteralPath '{lit}' -ErrorAction SilentlyContinue",
            ],
            capture_output=True,
            timeout=8,
            creationflags=int(getattr(subprocess, "CREATE_NO_WINDOW", 0)),
        )
    except Exception:
        pass


def _download_image_to_temp(url: str) -> Optional[str]:
    """Download remote image to a local temp file (no MOTW / security prompt)."""
    u = (url or "").strip()
    if not u.lower().startswith("http"):
        return None
    try:
        req = urllib.request.Request(
            u,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                ),
                "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            },
        )
        with urllib.request.urlopen(req, timeout=20.0) as resp:
            data = resp.read()
            content_type = (resp.headers.get("Content-Type") or "").lower()
        if not data or len(data) < 32:
            return None

        ext = ".jpg"
        path_part = u.split("?")[0].split("#")[0]
        m = re.search(r"\.(jpe?g|png|gif|webp|bmp|svg|avif|tif|tiff)(?:$)", path_part, re.I)
        if m:
            ext = "." + m.group(1).lower().replace("jpeg", "jpg")
        elif "png" in content_type:
            ext = ".png"
        elif "gif" in content_type:
            ext = ".gif"
        elif "webp" in content_type:
            ext = ".webp"
        elif "bmp" in content_type:
            ext = ".bmp"
        elif "svg" in content_type:
            ext = ".svg"
        elif data[:2] == b"\x89P":
            ext = ".png"
        elif data[:2] == b"GI":
            ext = ".gif"
        elif data[:2] == b"\xff\xd8":
            ext = ".jpg"

        folder = os.path.join(tempfile.gettempdir(), "bikli-images")
        os.makedirs(folder, exist_ok=True)
        name = f"bikli-img-{int(time.time() * 1000)}-{os.getpid()}{ext}"
        out = os.path.join(folder, name)
        with open(out, "wb") as f:
            f.write(data)
        _unblock_windows_file(out)
        return out
    except Exception:
        return None


def _schedule_temp_image_cleanup(path: str, delay_seconds: float = 120.0) -> None:
    """Best-effort delayed delete of a downloaded temp image.

    The image viewer is launched detached, so the file must survive for a bit;
    this removes it shortly after so %TEMP%\\bikli-images does not grow forever.
    """

    def _del() -> None:
        try:
            if os.path.exists(path):
                os.remove(path)
        except Exception:
            pass

    threading.Timer(delay_seconds, _del).start()


def _open_local_image_file(path: str) -> None:
    """Open a local image file with the default app (no security dialog)."""
    _unblock_windows_file(path)
    if platform.system() == "Windows":
        lit = path.replace("'", "''")
        try:
            subprocess.Popen(
                [
                    "powershell",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    f"Unblock-File -LiteralPath '{lit}' -ErrorAction SilentlyContinue; "
                    f"Start-Process -FilePath '{lit}'",
                ],
                close_fds=True,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=int(
                    getattr(subprocess, "DETACHED_PROCESS", 0)
                    | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                    | getattr(subprocess, "CREATE_NO_WINDOW", 0)
                ),
            )
            return
        except Exception:
            try:
                os.startfile(path)  # type: ignore[attr-defined]
                return
            except Exception as e:
                raise ToolError(f"Failed to open image file: {e}") from e
    # non-Windows
    import webbrowser

    webbrowser.open("file://" + path)


@register("openImage")
def open_image(args: Dict[str, Any]) -> Dict[str, Any]:
    """Find images, download locally, and open (no Windows untrusted-source prompt)."""
    global _LAST_IMAGE_QUERY
    query = (args.get("query") or args.get("q") or args.get("topic") or _LAST_IMAGE_QUERY or "").strip()
    if not query:
        raise ToolError(
            "No image query. Tell me what to open, e.g. 'open a cat image'."
        )
    try:
        index = max(1, int(args.get("index") or args.get("n") or args.get("position") or 1))
    except (TypeError, ValueError):
        index = 1

    try:
        results = _fetch_image_results(query, limit=max(15, index))
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise ToolError(f"Could not reach image search: {e}") from e

    if not results:
        # Soft fallback: images search page
        fallback = (
            "https://www.bing.com/images/search?q="
            + urllib.parse.quote(query)
            + "&form=HDRSC2"
        )
        open_url(fallback)
        return {
            "result": f"Could not extract a direct image; opened image search for '{query}'.",
            "query": query,
            "url": fallback,
            "fallback": True,
        }
    if index > len(results):
        raise ToolError(
            f"Only found {len(results)} image(s) for '{query}'; cannot open #{index}."
        )

    hit = results[index - 1]
    _LAST_IMAGE_QUERY = query
    local = _download_image_to_temp(hit["url"])
    if local:
        _open_local_image_file(local)
        _schedule_temp_image_cleanup(local)  # don't leak temp images forever
        return {
            "result": f"Opened image #{index} for '{query}' (saved locally, no security prompt).",
            "url": hit["url"],
            "localPath": local,
            "query": query,
            "index": index,
            "method": "local_download",
        }
    # Fallback: browser open of the URL
    resolved = open_url(hit["url"])
    return {
        "result": f"Opened image #{index} for '{query}' in the browser: {resolved}",
        "url": resolved,
        "query": query,
        "index": index,
        "method": "browser_url_fallback",
    }


__all__ = [
    "search_web",
    "search_youtube",
    "play_youtube",
    "search_google",
    "search_github",
    "open_image",
]
