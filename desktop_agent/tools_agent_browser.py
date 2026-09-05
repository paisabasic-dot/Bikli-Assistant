"""
Agent-Browser Automation for BIKLI Desktop Agent.

Uses vercel-labs/agent-browser CLI to automate Chromium/Edge:
- Reuses the active browser tab by default (preventing unwanted tab proliferation).
- Inspects the live accessibility tree (snapshot -i) to click the EXACT
  on-screen video cards on YouTube when the user asks to "play first video"
  or "play another one".
"""

from __future__ import annotations

import logging
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple

from .registry import ToolError, register

logger = logging.getLogger("bikli.agent_browser")

SESSION_NAME = "bikli_main"

# Path to the bundled agent-browser executable
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_AGENT_BROWSER_BIN = os.path.join(_PROJECT_ROOT, "bin", "agent-browser.exe" if platform.system() == "Windows" else "agent-browser")


def _find_agent_browser() -> str:
    """Locate the agent-browser binary."""
    if os.path.isfile(_AGENT_BROWSER_BIN):
        return _AGENT_BROWSER_BIN
    found = shutil.which("agent-browser")
    if found:
        return found
    return _AGENT_BROWSER_BIN


def _get_browser_env() -> Dict[str, str]:
    """Prepare environment variables for agent-browser."""
    env = os.environ.copy()
    env["AGENT_BROWSER_SESSION"] = SESSION_NAME
    env["AGENT_BROWSER_HEADED"] = "1"
    env["AGENT_BROWSER_PIN_TAB"] = "1"

    # Known Edge / Chrome paths if custom executable needed
    edge_path = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    chrome_path = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
    custom_installed = os.path.expanduser(r"~\.agent-browser\browsers\chrome-152.0.7977.82\chrome.exe")

    if os.path.isfile(custom_installed):
        # Default agent-browser installed Chrome
        pass
    elif os.path.isfile(edge_path):
        env.setdefault("AGENT_BROWSER_EXECUTABLE_PATH", edge_path)
    elif os.path.isfile(chrome_path):
        env.setdefault("AGENT_BROWSER_EXECUTABLE_PATH", chrome_path)

    return env


def run_agent_browser(*args: str, timeout: float = 25.0) -> Tuple[int, str, str]:
    """Execute agent-browser commands safely without handle inheritance hangs.

    Windows pipe inheritance can hang on daemonized processes; we redirect
    stdout/stderr to temp files and pass stdin=DEVNULL.
    """
    bin_path = _find_agent_browser()
    if not os.path.isfile(bin_path):
        raise ToolError(f"agent-browser binary not found at '{bin_path}'.")

    cmd = [bin_path, "--session", SESSION_NAME] + list(args)
    env = _get_browser_env()

    out_fd, out_path = tempfile.mkstemp(prefix="ab_out_")
    err_fd, err_path = tempfile.mkstemp(prefix="ab_err_")
    os.close(out_fd)
    os.close(err_fd)

    try:
        with open(out_path, "w", encoding="utf-8") as out_f, open(err_path, "w", encoding="utf-8") as err_f:
            p = subprocess.run(
                cmd,
                stdin=subprocess.DEVNULL,
                stdout=out_f,
                stderr=err_f,
                env=env,
                timeout=timeout,
                close_fds=True,
                creationflags=int(getattr(subprocess, "CREATE_NO_WINDOW", 0)),
            )
        with open(out_path, "r", encoding="utf-8", errors="replace") as f:
            stdout_text = f.read()
        with open(err_path, "r", encoding="utf-8", errors="replace") as f:
            stderr_text = f.read()
        return p.returncode, stdout_text, stderr_text
    except subprocess.TimeoutExpired as e:
        logger.warning("agent-browser command timed out: %s", cmd)
        raise ToolError("Browser action timed out.") from e
    finally:
        for p_path in (out_path, err_path):
            try:
                if os.path.exists(p_path):
                    os.remove(p_path)
            except OSError:
                pass


def browser_open_url(url: str, new_tab: bool = False, new_window: bool = False) -> Dict[str, Any]:
    """Open or navigate to a URL using agent-browser in the current active tab."""
    u = url.strip()
    if not u:
        raise ToolError("URL is empty.")
    if "://" not in u:
        u = "https://" + u

    if new_tab or new_window:
        code, out, err = run_agent_browser("tab", "new", u)
        mode = "new_tab"
    else:
        code, out, err = run_agent_browser("open", u)
        mode = "same_tab"

    if code != 0 and "Navigation failed" in err:
        raise ToolError(f"Failed to navigate to {u}: {err.strip()}")

    return {
        "result": f"Opened {u} in browser ({mode}).",
        "url": u,
        "mode": mode,
    }


def browser_search(query: str, engine: str = "google", new_tab: bool = False) -> Dict[str, Any]:
    """Search on Google, YouTube, GitHub, etc., navigating in the same tab."""
    q = (query or "").strip()
    if not q:
        raise ToolError("Parameter 'query' is required.")

    encoded = urllib.parse.quote(q)
    engine_lower = engine.strip().lower()

    if engine_lower == "youtube":
        target_url = f"https://www.youtube.com/results?search_query={encoded}"
    elif engine_lower == "github":
        target_url = f"https://github.com/search?q={encoded}&type=repositories"
    elif engine_lower == "bing":
        target_url = f"https://www.bing.com/search?q={encoded}"
    elif engine_lower == "duckduckgo":
        target_url = f"https://duckduckgo.com/?q={encoded}"
    else:
        target_url = f"https://www.google.com/search?q={encoded}"

    res = browser_open_url(target_url, new_tab=new_tab)
    res["query"] = q
    res["engine"] = engine_lower
    return res


def browser_parse_youtube_snapshot(snapshot_text: str) -> List[Dict[str, str]]:
    """Parse video cards from an accessibility tree snapshot.

    Matches level=3 headings and their corresponding link references.
    """
    items: List[Dict[str, str]] = []
    lines = snapshot_text.splitlines()

    for i, line in enumerate(lines):
        m_h = re.search(r'-\s+heading\s+"([^"]+)"\s+\[level=3,\s*ref=(e\d+)\]', line)
        if m_h:
            title = m_h.group(1).strip()
            h_ref = m_h.group(2)
            link_ref = None
            # Look ahead for child link ref
            for j in range(i + 1, min(len(lines), i + 4)):
                m_l = re.search(r'-\s+link\s+.*\[ref=(e\d+)\]', lines[j])
                if m_l:
                    link_ref = m_l.group(1)
                    break
            target_ref = link_ref or h_ref
            items.append({
                "title": title,
                "ref": target_ref,
                "h_ref": h_ref,
            })

    return items


def normalize_title(text: str) -> str:
    """Normalizes text for robust title matching."""
    t = (text or "").lower()
    t = re.sub(r"[\[\(\{\]\)\}]", " ", t)
    t = re.sub(r"official\s+(music\s+)?(video|audio|trailer|lyric\s+video|hd|4k)", " ", t, flags=re.I)
    t = re.sub(r"[^\w\s]", " ", t)
    return " ".join(t.split())


def score_title_match(query: str, card_title: str) -> float:
    """Computes match score (0 to 1) between query and video card title."""
    norm_q = normalize_title(query)
    norm_t = normalize_title(card_title)
    if not norm_q or not norm_t:
        return 0.0
    if norm_q in norm_t:
        return 1.0
    if norm_t in norm_q:
        return 0.95
    q_tokens = [w for w in norm_q.split() if len(w) > 1]
    t_tokens = set(w for w in norm_t.split() if len(w) > 1)
    if not q_tokens or not t_tokens:
        return 0.0
    matched = 0.0
    for q in q_tokens:
        if q in t_tokens:
            matched += 1.0
            continue
        for t in t_tokens:
            if (len(q) >= 4 and q in t) or (len(t) >= 4 and t in q):
                matched += 0.8
                break
    return matched / len(q_tokens)


def find_best_matching_card(query: str, cards: List[Dict[str, str]], threshold: float = 0.35) -> Optional[Tuple[Dict[str, str], int, float]]:
    if not query or not cards:
        return None
    best_card = None
    best_idx = -1
    best_score = 0.0
    for i, c in enumerate(cards):
        s = score_title_match(query, c.get("title", ""))
        if s > best_score:
            best_score = s
            best_card = c
            best_idx = i + 1
    if best_card and best_score >= threshold:
        return (best_card, best_idx, best_score)
    return None


def browser_play_youtube(
    query: str = "",
    index: int = 1,
    prefer_on_screen: bool = True,
) -> Dict[str, Any]:
    """Play a video on YouTube matching title or index by clicking its accessibility element.

    If the requested video title is already visible on the current YouTube screen,
    it clicks that exact card directly without re-searching. Otherwise, it searches
    and immediately clicks the top matching video so playback starts automatically.
    """
    idx = max(1, int(index or 1))
    clean_q = (query or "").strip()

    # Filter out ordinal command words from query
    is_ordinal_only = bool(re.match(
        r"^(the\s+)?(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|next|another|different|other)(\s+(video|one|result|clip|song))?$",
        clean_q,
        re.I,
    ))
    if is_ordinal_only:
        clean_q = ""

    # Check current browser URL
    code, current_url, _ = run_agent_browser("get", "url")
    current_url = current_url.strip()
    is_on_youtube = "youtube.com" in current_url

    # PRIORITY 1: Check active YouTube screen for matching title FIRST!
    if clean_q and is_on_youtube:
        code, snapshot, _ = run_agent_browser("snapshot", "-i")
        cards = browser_parse_youtube_snapshot(snapshot)
        match = find_best_matching_card(clean_q, cards, threshold=0.35)
        if match:
            target, target_idx, score = match
            target_ref = target["ref"]
            title = target["title"]
            click_code, _, _ = run_agent_browser("click", f"@{target_ref}")
            if click_code != 0 and target.get("h_ref"):
                run_agent_browser("click", f"@{target['h_ref']}")
            time.sleep(1.0)
            _, final_url, _ = run_agent_browser("get", "url")
            return {
                "result": f"Playing \"{title}\" on YouTube.",
                "title": title,
                "index": target_idx,
                "ref": f"@{target_ref}",
                "url": final_url.strip(),
                "query": clean_q,
                "matched_on_screen": True,
            }

    # PRIORITY 2: Search and immediately play matching result
    need_search_navigation = bool(clean_q)
    if clean_q and "youtube.com/results" in current_url:
        encoded = urllib.parse.quote_plus(clean_q.lower())
        if encoded in current_url.lower():
            need_search_navigation = False

    if need_search_navigation:
        search_url = f"https://www.youtube.com/results?search_query={urllib.parse.quote(clean_q)}"
        browser_open_url(search_url)
        time.sleep(2.0)
    elif not is_on_youtube:
        search_url = f"https://www.youtube.com/results?search_query={urllib.parse.quote(clean_q or 'trending')}"
        browser_open_url(search_url)
        time.sleep(2.0)

    # Snapshot view after search
    code, snapshot, err = run_agent_browser("snapshot", "-i")
    items = browser_parse_youtube_snapshot(snapshot)

    if not items:
        time.sleep(1.5)
        code, snapshot, err = run_agent_browser("snapshot", "-i")
        items = browser_parse_youtube_snapshot(snapshot)

    if not items:
        if clean_q:
            fallback_url = f"https://www.youtube.com/results?search_query={urllib.parse.quote(clean_q)}"
            browser_open_url(fallback_url)
            return {
                "result": f"Opened YouTube search for '{clean_q}'. Say 'play first video' to start playing.",
                "url": fallback_url,
                "query": clean_q,
            }
        raise ToolError("Could not detect any video cards on the current YouTube screen.")

    # Select best matching card or index
    if clean_q:
        match = find_best_matching_card(clean_q, items, threshold=0.25)
        if match:
            target, selected_idx, _ = match
        else:
            selected_idx = min(idx, len(items))
            target = items[selected_idx - 1]
    else:
        selected_idx = min(idx, len(items))
        target = items[selected_idx - 1]

    target_ref = target["ref"]
    title = target["title"]

    click_code, click_out, click_err = run_agent_browser("click", f"@{target_ref}")
    if click_code != 0:
        h_ref = target.get("h_ref")
        if h_ref and h_ref != target_ref:
            run_agent_browser("click", f"@{h_ref}")

    time.sleep(1.0)
    _, final_url, _ = run_agent_browser("get", "url")

    return {
        "result": f"Playing \"{title}\" on YouTube.",
        "title": title,
        "index": selected_idx,
        "ref": f"@{target_ref}",
        "url": final_url.strip(),
        "query": clean_q,
    }


# ── Registered Tools ─────────────────────────────────────────────────────────

@register("browserOpenUrl")
def tool_browser_open_url(args: Dict[str, Any]) -> Dict[str, Any]:
    url = args.get("url") or args.get("target") or ""
    new_tab = bool(args.get("new_tab") or args.get("new_window") or False)
    return browser_open_url(str(url), new_tab=new_tab)


@register("browserSearch")
def tool_browser_search(args: Dict[str, Any]) -> Dict[str, Any]:
    query = args.get("query") or args.get("q") or ""
    engine = str(args.get("engine") or "google")
    new_tab = bool(args.get("new_tab") or args.get("new_window") or False)
    return browser_search(str(query), engine=engine, new_tab=new_tab)


@register("browserPlayYouTube")
def tool_browser_play_youtube(args: Dict[str, Any]) -> Dict[str, Any]:
    query = str(args.get("query") or args.get("q") or "")
    try:
        index = int(args.get("index") or args.get("n") or args.get("position") or 1)
    except (TypeError, ValueError):
        index = 1
    prefer_on_screen = bool(args.get("preferOnScreen", True))
    return browser_play_youtube(query=query, index=index, prefer_on_screen=prefer_on_screen)


__all__ = [
    "run_agent_browser",
    "browser_open_url",
    "browser_search",
    "browser_play_youtube",
    "browser_parse_youtube_snapshot",
    "tool_browser_open_url",
    "tool_browser_search",
    "tool_browser_play_youtube",
]
