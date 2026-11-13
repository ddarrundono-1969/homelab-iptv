"""
stream_iptv/anti_collision.py - Anti-Subscription Collision Engine for IPTV Streams
Prevents account concurrency collisions by:
1. Detecting upstream IPTV stream providers accurately.
2. Interleaving playlist channels so consecutive streams never share the same provider.
3. Calculating next/previous playback indices to bypass same-provider streams during active playback.

Provider identity is resolved to a canonical *subscription key* (URL first, then
normalized label) so aliases such as "Tubi" / "Tubi TV" are treated as the same upstream account.
"""

import re
from collections import defaultdict
from typing import List, Dict, Any
from urllib.parse import urlparse

# URL fingerprints -> canonical provider (checked before the free-text label,
# because the URL is the source of truth for which subscription is consumed).
_URL_RULES = [
    (("tubi.io", "tubitv.com", "tubi.video"), "Tubi TV"),
    (("pluto.tv", "jmp2.uk"), "Pluto TV"),
    (("youtube.com", "youtu.be", "googlevideo.com"), "YouTube"),
]

# Normalized label substrings -> canonical provider
_LABEL_RULES = [
    ("primary provider", "Primary Provider"),
    ("tubi", "Tubi TV"),
    ("pluto", "Pluto TV"),
    ("youtube", "YouTube"),
]

_GENERIC_LABELS = {"", "iptv", "live tv", "stream", "unknown", "other", "direct"}


def _normalize_label(label: str) -> str:
    # Drop emoji / punctuation, collapse whitespace, lowercase
    cleaned = re.sub(r"[^\w\s.:-]", " ", str(label or ""), flags=re.UNICODE)
    return re.sub(r"\s+", " ", cleaned).strip().lower()


def get_stream_provider(s: Dict[str, Any]) -> str:
    """Identify the canonical upstream IPTV provider (subscription key) for a stream dict."""
    if not s or not isinstance(s, dict):
        return "Unknown"

    u = (s.get("url") or "").lower()
    for needles, canon in _URL_RULES:
        if any(n in u for n in needles):
            return canon

    label = _normalize_label(s.get("provider"))
    if label not in _GENERIC_LABELS:
        for needle, canon in _LABEL_RULES:
            if needle in label:
                return canon
        return str(s.get("provider")).strip()

    host = urlparse(u).netloc.lower()
    if host:
        return host.split("@")[-1]

    cat = (s.get("category") or "").strip()
    return cat if cat else "Other"


def count_collisions(stream_list: List[Dict[str, Any]], circular: bool = True) -> int:
    """Number of adjacent pairs sharing a provider (wrap-around included when circular)."""
    n = len(stream_list or [])
    if n < 2:
        return 0
    keys = [get_stream_provider(s) for s in stream_list]
    pairs = n if (circular and n > 2) else n - 1
    return sum(1 for i in range(pairs) if keys[i] == keys[(i + 1) % n])


def _interleave_keys(items: List[Any], keys: List[str]) -> List[Any]:
    """Core interleave: returns items reordered so equal keys are never adjacent where possible."""
    n = len(items)
    if n <= 1:
        return list(items)

    groups = defaultdict(list)
    first_seen = {}
    for i, (it, k) in enumerate(zip(items, keys)):
        groups[k].append(it)
        first_seen.setdefault(k, i)

    result: List[Any] = []
    result_keys: List[str] = []
    last = None
    while True:
        available = [k for k in groups if groups[k] and k != last]
        if not available:
            break
        # Most remaining first (guarantees feasibility), stable tie-break on original order
        available.sort(key=lambda k: (-len(groups[k]), first_seen[k]))
        chosen = available[0]
        result.append(groups[chosen].pop(0))
        result_keys.append(chosen)
        last = chosen

    # Leftovers (only one provider can remain): slot each into a gap whose
    # neighbours are both different providers, otherwise append.
    for k in [k for k in groups if groups[k]]:
        for it in groups[k]:
            placed = False
            m = len(result_keys)
            for pos in range(m + 1):
                left = result_keys[pos - 1] if pos > 0 else None
                right = result_keys[pos] if pos < m else None
                if left != k and right != k:
                    result.insert(pos, it)
                    result_keys.insert(pos, k)
                    placed = True
                    break
            if not placed:
                result.append(it)
                result_keys.append(k)
        groups[k] = []

    # Wrap-around: playlist loops, so last -> first must also differ.
    if len(result) > 2 and result_keys[0] == result_keys[-1]:
        k = result_keys[-1]
        for pos in range(len(result) - 2, 0, -1):
            if result_keys[pos - 1] != k and result_keys[pos] != k:
                result.insert(pos, result.pop())
                result_keys.insert(pos, result_keys.pop())
                break

    return result


def interleave_streams_anti_collision(stream_list: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Reorders a list of stream dictionaries so that no two adjacent streams
    share the same upstream provider (prevents account subscription collisions).

    Playable streams are interleaved first; offline streams are interleaved and
    appended afterwards so they cannot hide a same-provider seam during playback.
    The user-facing ``provider`` label is preserved; it is only filled in when missing.
    """
    if not stream_list or len(stream_list) <= 1:
        return stream_list

    enriched = []
    for s in stream_list:
        item = dict(s)
        if not str(item.get("provider") or "").strip():
            item["provider"] = get_stream_provider(item)
        enriched.append(item)

    online = [s for s in enriched if not s.get("offline")]
    offline = [s for s in enriched if s.get("offline")]

    def _do(lst):
        return _interleave_keys(lst, [get_stream_provider(s) for s in lst])

    return _do(online) + _do(offline)


def get_next_anti_collision_index(current_idx: int, stream_list: List[Dict[str, Any]], forward: bool = True) -> int:
    """
    Given the current stream index, finds the next (or previous) stream index
    whose upstream provider is DIFFERENT from the current stream's provider.
    """
    if not stream_list:
        return 0
    if len(stream_list) == 1:
        return 0

    cur_stream = stream_list[current_idx] if 0 <= current_idx < len(stream_list) else None
    cur_prov = get_stream_provider(cur_stream) if cur_stream else ""

    direction = 1 if forward else -1
    for step in range(1, len(stream_list)):
        cand_idx = (current_idx + (step * direction)) % len(stream_list)
        cand_stream = stream_list[cand_idx]
        if cand_stream.get("offline"):
            continue
        if get_stream_provider(cand_stream) != cur_prov:
            return cand_idx

    return (current_idx + direction) % len(stream_list)
