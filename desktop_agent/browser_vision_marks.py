"""
Set-of-Marks (SoM) visual grounding and DOM extraction for Playwright.
Inspired by Browser-Use and WebVoyager.

Injects lightweight, high-contrast numbered badges directly over interactive
elements on the page, captures an annotated screenshot, extracts structured
element metadata (tag, text, role, selector, bounding box), and cleans up.
"""

from __future__ import annotations

import base64
import json
import logging
from typing import Any, Dict, List, Optional, Tuple

log = logging.getLogger("bikli.som")

# JavaScript snippet that tags interactive elements with numbered badges.
# Injects a container #__bikli_som_container__ which can be removed in one call.
INJECT_SOM_JS = """
(() => {
  // Clean up any prior marks
  const old = document.getElementById('__bikli_som_container__');
  if (old) old.remove();

  const container = document.createElement('div');
  container.id = '__bikli_som_container__';
  container.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 2147483640;';
  document.body.appendChild(container);

  // Candidate selectors for interactive elements
  const selectors = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'textarea',
    'select',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="tab"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="combobox"]',
    '[role="searchbox"]',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]'
  ];

  const elements = Array.from(document.querySelectorAll(selectors.join(',')));
  const visibleElements = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let markId = 1;
  const maxMarks = 60; // Cap to keep token usage efficient

  // Palette of distinct high-visibility tag colors
  const colors = [
    { bg: '#FFEB3B', text: '#000000', border: '#F57F17' }, // Yellow
    { bg: '#00E676', text: '#000000', border: '#00B0FF' }, // Bright Green
    { bg: '#FF4081', text: '#FFFFFF', border: '#C51162' }, // Pink
    { bg: '#00B0FF', text: '#FFFFFF', border: '#0091EA' }, // Cyan
    { bg: '#FF9100', text: '#000000', border: '#E65100' }, // Orange
    { bg: '#D500F9', text: '#FFFFFF', border: '#4A148C' }, // Purple
  ];

  for (const el of elements) {
    if (markId > maxMarks) break;

    // Check visibility
    const rect = el.getBoundingClientRect();
    if (rect.width < 6 || rect.height < 6) continue;
    if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;

    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

    // Element is visible in viewport!
    const color = colors[(markId - 1) % colors.length];

    // Create badge
    const badge = document.createElement('div');
    badge.className = '__bikli_som_badge__';
    badge.innerText = String(markId);
    badge.style.cssText = `
      position: fixed;
      left: ${Math.max(0, rect.left)}px;
      top: ${Math.max(0, rect.top)}px;
      background: ${color.bg};
      color: ${color.text};
      border: 1.5px solid ${color.border};
      font-size: 11px;
      font-weight: 900;
      font-family: monospace, sans-serif;
      padding: 1px 4px;
      border-radius: 3px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.6);
      line-height: 12px;
      z-index: 2147483647;
      pointer-events: none;
    `;
    container.appendChild(badge);

    // Outline target element slightly
    el.setAttribute('data-bikli-mark-id', String(markId));

    // Gather text and metadata
    let text = (el.innerText || el.textContent || el.value || el.placeholder || el.getAttribute('aria-label') || el.title || '').trim();
    if (text.length > 50) text = text.substring(0, 47) + '...';

    visibleElements.push({
      id: markId,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      role: el.getAttribute('role') || '',
      text: text.replace(/[\\r\\n]+/g, ' '),
      placeholder: el.getAttribute('placeholder') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      href: el.getAttribute('href') || '',
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    });

    markId++;
  }

  return visibleElements;
})()
"""

CLEANUP_SOM_JS = """
(() => {
  const container = document.getElementById('__bikli_som_container__');
  if (container) container.remove();
  document.querySelectorAll('[data-bikli-mark-id]').forEach(el => {
    el.removeAttribute('data-bikli-mark-id');
  });
})()
"""

CLICK_MARK_JS = """
(markId) => {
  const el = document.querySelector(`[data-bikli-mark-id="${markId}"]`);
  if (!el) return { ok: false, error: "Mark not found" };
  el.scrollIntoView({ behavior: 'instant', block: 'center' });
  el.click();
  return { ok: true, tag: el.tagName };
}
"""

FILL_MARK_JS = """
([markId, value]) => {
  const el = document.querySelector(`[data-bikli-mark-id="${markId}"]`);
  if (!el) return { ok: false, error: "Mark not found" };
  el.scrollIntoView({ behavior: 'instant', block: 'center' });
  el.focus();
  if ('value' in el) {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (el.isContentEditable) {
    el.innerText = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return { ok: true };
}
"""


async def capture_set_of_marks(page: Any) -> Tuple[str, List[Dict[str, Any]]]:
    """
    Injects visual Set-of-Marks badges into the active Playwright page,
    takes a screenshot, extracts the element catalog, and cleans up badges.

    Returns:
        (screenshot_base64_jpeg, elements_list)
    """
    try:
        elements: List[Dict[str, Any]] = await page.evaluate(INJECT_SOM_JS)
    except Exception as e:
        log.warning("Failed to inject SoM: %s", e)
        elements = []

    # Capture annotated screenshot as JPEG for fast upload & token economy
    try:
        shot_bytes = await page.screenshot(type="jpeg", quality=75)
        shot_b64 = base64.b64encode(shot_bytes).decode("ascii")
    except Exception as e:
        log.error("Failed to capture screenshot: %s", e)
        shot_b64 = ""

    # Clean up badges so DOM is not permanently modified
    try:
        await page.evaluate(CLEANUP_SOM_JS)
    except Exception:
        pass

    return shot_b64, elements


async def click_element_by_mark(page: Any, mark_id: int) -> Dict[str, Any]:
    """Click an element using its assigned mark ID."""
    try:
        res = await page.evaluate(CLICK_MARK_JS, mark_id)
        if not res.get("ok"):
            return {"ok": False, "error": f"Mark ID #{mark_id} not found on current page."}
        return {"ok": True, "result": f"Clicked element #{mark_id} ({res.get('tag', 'element')})"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


async def fill_element_by_mark(page: Any, mark_id: int, text: str) -> Dict[str, Any]:
    """Fill text into an element using its assigned mark ID."""
    try:
        res = await page.evaluate(FILL_MARK_JS, [mark_id, text])
        if not res.get("ok"):
            return {"ok": False, "error": f"Mark ID #{mark_id} not found on current page."}
        return {"ok": True, "result": f"Filled text into element #{mark_id}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}
