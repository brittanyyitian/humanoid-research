#!/usr/bin/env python3
"""Fetch official robotics news pages into the review inbox.

This is intentionally semi-automatic: candidates are written to
data/inbox/news_candidates.json and never promoted into formal events without
manual source review.
"""

from __future__ import annotations

import hashlib
import html
import json
import re
import sys
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
INBOX_DIR = DATA_DIR / "inbox"

OFFICIAL_SOURCES = [
    {
        "sourceName": "智元机器人官网新闻",
        "publisher": "智元创新（上海）科技股份有限公司",
        "url": "https://www.agibot.com.cn/news",
        "suggestedEvidenceLevel": "A",
        "moduleHint": "整机厂",
    },
    {
        "sourceName": "宇树科技新闻中心",
        "publisher": "宇树科技股份有限公司",
        "url": "https://www.unitree.com/cn/news/",
        "suggestedEvidenceLevel": "A",
        "moduleHint": "整机厂",
    },
]


def now_shanghai() -> str:
    return datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds")


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)
        file.write("\n")


def clean_text(value: str | None) -> str | None:
    if not value:
        return None
    value = re.sub(r"\s+", " ", html.unescape(value)).strip()
    return value or None


def extract_title(markup: str) -> str | None:
    match = re.search(r"<title[^>]*>(.*?)</title>", markup, flags=re.I | re.S)
    return clean_text(match.group(1)) if match else None


def fetch_page(config: dict) -> dict:
    request = urllib.request.Request(
        config["url"],
        headers={"User-Agent": "Mozilla/5.0 humanoid-research/0.1"},
    )
    with urllib.request.urlopen(request, timeout=12) as response:
        raw = response.read()
    markup = raw.decode("utf-8", errors="ignore")
    title = extract_title(markup) or config["sourceName"]
    digest = hashlib.sha1(f"{config['url']}::{title}".encode("utf-8")).hexdigest()[:12]

    return {
        "id": f"candidate_{digest}",
        "title": title,
        "sourceName": config["sourceName"],
        "publisher": config["publisher"],
        "sourceUrl": config["url"],
        "suggestedEvidenceLevel": config["suggestedEvidenceLevel"],
        "moduleHint": config["moduleHint"],
        "reviewStatus": "pending",
        "rawTitle": title,
    }


def main() -> int:
    captured_at = now_shanghai()
    candidates = []
    errors = []

    for config in OFFICIAL_SOURCES:
        try:
            candidates.append(fetch_page(config))
        except Exception as exc:  # noqa: BLE001 - preserve failed source status.
            errors.append(
                {
                    "sourceName": config["sourceName"],
                    "sourceUrl": config["url"],
                    "error": str(exc),
                }
            )

    payload = {
        "date": captured_at[:10],
        "capturedAt": captured_at,
        "reviewStatus": "pending_manual_review",
        "policy": "抓取结果只进入 inbox。人工确认事实、来源和证据等级后，才写入 data/events。",
        "candidates": candidates,
        "errors": errors,
    }
    write_json(INBOX_DIR / "news_candidates.json", payload)
    print(
        f"Wrote {INBOX_DIR / 'news_candidates.json'} with "
        f"{len(candidates)} candidates and {len(errors)} errors."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
