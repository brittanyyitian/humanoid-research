#!/usr/bin/env python3
"""Fetch official news list pages into the review inbox.

Official News Intake v0 is intentionally conservative:
- it extracts article candidates from configured official list pages;
- it writes only data/inbox/news_candidates.json;
- it never creates events, observations, relations or promoted facts.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
INBOX_DIR = DATA_DIR / "inbox"
DEFAULT_SOURCES_PATH = DATA_DIR / "intake" / "official_news_sources.json"
NEWS_INBOX_PATH = INBOX_DIR / "news_candidates.json"

ANCHOR_RE = re.compile(r"<a\b(?P<attrs>[^>]*)>(?P<body>.*?)</a>", flags=re.I | re.S)
HREF_RE = re.compile(
    r"""href\s*=\s*(?:"(?P<double>[^"]+)"|'(?P<single>[^']+)'|(?P<bare>[^\s>]+))""",
    flags=re.I,
)
NUMERIC_DATE_RE = re.compile(r"(20\d{2})[.\-/年](\d{1,2})[.\-/月](\d{1,2})日?")
EN_DATE_RE = re.compile(
    r"\b("
    r"jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|"
    r"jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?"
    r")\s+(\d{1,2}),\s*(20\d{2})\b",
    flags=re.I,
)
MONTHS = {
    "jan": 1,
    "january": 1,
    "feb": 2,
    "february": 2,
    "mar": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "may": 5,
    "jun": 6,
    "june": 6,
    "jul": 7,
    "july": 7,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "september": 9,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "november": 11,
    "dec": 12,
    "december": 12,
}
TITLE_NOISE = [
    "媒体报道",
    "新闻资讯",
    "公司新闻",
    "展会活动",
    "展会论坛",
    "新闻动态",
    "News Center",
    "Company news",
    "Learn More",
    "Learn more",
    "了解更多",
    "阅读更多",
    "Read More",
    "Read more",
    "MORE",
    "More",
    "more",
    "",
    "",
]
GENERIC_TITLES = {
    "首页",
    "home",
    "news",
    "news center",
    "新闻中心",
    "动态速递",
    "公司新闻",
    "展会活动",
    "更多",
    "下一页",
    "上一页",
}
PERSISTED_CANDIDATE_FIELDS = [
    "rawArtifactId",
    "routeDecisionId",
    "pipelineTaskId",
    "pipeline",
    "ingestedAt",
    "ingestionStatus",
    "claimIds",
    "evidenceIds",
    "ruleOutputIds",
    "pipelineRunIds",
    "lastIngestError",
]


def now_shanghai() -> str:
    return datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds")


def read_json(path: Path, fallback: dict | None = None) -> dict:
    try:
        with path.open("r", encoding="utf-8") as file:
            return json.load(file)
    except FileNotFoundError:
        if fallback is None:
            raise
        return fallback


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)
        file.write("\n")


def clean_text(value: str | None) -> str:
    if not value:
        return ""
    value = html.unescape(value)
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def text_from_html(markup: str) -> str:
    markup = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", markup)
    markup = re.sub(r"(?is)<[^>]+>", " ", markup)
    return clean_text(markup)


def attr_value(attrs: str, attr_name: str) -> str | None:
    if attr_name.lower() != "href":
        return None
    match = HREF_RE.search(attrs)
    if not match:
        return None
    return match.group("double") or match.group("single") or match.group("bare")


def fetch_markup(url: str) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 humanoid-research-official-news-intake/0.1",
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Encoding": "identity",
        },
    )
    with urllib.request.urlopen(request, timeout=18) as response:
        raw = response.read()
        charset = response.headers.get_content_charset() or "utf-8"
    return raw.decode(charset, errors="ignore")


def extract_date(value: str) -> tuple[str | None, str | None]:
    numeric = NUMERIC_DATE_RE.search(value)
    if numeric:
        year, month, day = [int(part) for part in numeric.groups()]
        if valid_date_parts(year, month, day):
            return f"{year:04d}-{month:02d}-{day:02d}", numeric.group(0)

    english = EN_DATE_RE.search(value)
    if english:
        month_name, day_text, year_text = english.groups()
        year = int(year_text)
        month = MONTHS[month_name.lower()]
        day = int(day_text)
        if valid_date_parts(year, month, day):
            return f"{year:04d}-{month:02d}-{day:02d}", english.group(0)

    return None, None


def valid_date_parts(year: int, month: int, day: int) -> bool:
    return 2000 <= year <= 2099 and 1 <= month <= 12 and 1 <= day <= 31


def normalized_title(raw_text: str, matched_date: str | None) -> str:
    value = raw_text
    if matched_date:
        value = value.replace(matched_date, " ")
    value = NUMERIC_DATE_RE.sub(" ", value)
    value = EN_DATE_RE.sub(" ", value)
    for token in TITLE_NOISE:
        value = value.replace(token, " ")
    value = re.sub(r"[|｜]+", " ", value)
    value = re.sub(r"\s+", " ", value)
    return value.strip(" -_/·,，。:：")


def canonical_url(raw_url: str, base_url: str) -> str | None:
    if not raw_url:
        return None
    resolved = urllib.parse.urljoin(base_url, html.unescape(raw_url.strip()))
    parsed = urllib.parse.urlsplit(resolved)
    if parsed.scheme not in {"http", "https"}:
        return None
    path = parsed.path or "/"
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc.lower(), path, parsed.query, ""))


def site_key(value: str) -> str:
    try:
        host = urllib.parse.urlsplit(value).netloc.lower()
    except ValueError:
        return ""
    return host.removeprefix("www.")


def same_site(url: str, list_url: str) -> bool:
    return site_key(url) == site_key(list_url)


def fingerprint_for(url: str, title: str, published_at: str | None) -> str:
    key = f"{url}|{title}|{published_at or ''}"
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


def route_hint_for(title: str, default_hint: str | None) -> str:
    text = title.lower()
    if has_any(text, ["发布", "release", "product", "产品", "walker", "unitree", "gemini", "h2", "g1", "g2"]):
        return "product_pipeline"
    if has_any(text, ["交付", "下线", "部署", "大会", "展会", "里程碑", "showcase", "exhibition"]):
        return "event_pipeline"
    return default_hint or "company_pipeline"


def has_any(value: str, needles: list[str]) -> bool:
    return any(needle in value for needle in needles)


def looks_like_article(title: str, url: str, config: dict) -> bool:
    if len(title) < int(config.get("minTitleLength", 6)):
        return False
    if title.strip().lower() in GENERIC_TITLES:
        return False
    blocked = [item.lower() for item in config.get("excludeTitleKeywords", [])]
    if any(item and item in title.lower() for item in blocked):
        return False
    if not config.get("allowExternal", False) and not same_site(url, config["listUrl"]):
        return False
    return True


def extract_articles(markup: str, config: dict) -> list[dict]:
    articles: list[dict] = []
    seen = set()
    for match in ANCHOR_RE.finditer(markup):
        href = attr_value(match.group("attrs"), "href")
        url = canonical_url(href or "", config["listUrl"])
        if not url:
            continue

        raw_text = text_from_html(match.group("body"))
        published_at, matched_date = extract_date(raw_text)
        if not published_at:
            continue

        title = normalized_title(raw_text, matched_date)
        if not looks_like_article(title, url, config):
            continue

        key = fingerprint_for(url, title, published_at)
        if key in seen:
            continue
        seen.add(key)
        articles.append(
            {
                "title": title,
                "url": url,
                "publishedAt": published_at,
                "rawTitle": raw_text,
                "fingerprint": key,
            }
        )

    limit = int(config.get("maxItems", 50))
    return articles[:limit]


def build_candidate(config: dict, article: dict, discovered_at: str) -> dict:
    entity_ids = config.get("entityIds") or [config.get("entityId")]
    entity_ids = [item for item in entity_ids if item]
    entity_id = entity_ids[0] if entity_ids else None
    source_level = config.get("sourceLevel", "A")
    fingerprint = article["fingerprint"]
    title = article["title"]

    return {
        "id": f"news_candidate_{fingerprint}",
        "entityId": entity_id,
        "entityIds": entity_ids,
        "sourceId": config["sourceId"],
        "sourceName": config["title"],
        "publisher": config["publisher"],
        "title": title,
        "url": article["url"],
        "sourceUrl": article["url"],
        "listUrl": config["listUrl"],
        "publishedAt": article["publishedAt"],
        "discoveredAt": discovered_at,
        "sourceType": config.get("candidateSourceType", "company_official"),
        "ingestionSourceType": config.get("ingestionSourceType", "news"),
        "artifactType": config.get("artifactType", "news_page"),
        "status": "candidate",
        "reviewStatus": "pending",
        "fingerprint": fingerprint,
        "routeHint": route_hint_for(title, config.get("routeHint")),
        "parserType": config.get("parserType", "anchor_date"),
        "suggestedEvidenceLevel": source_level,
        "moduleHint": config.get("moduleHint", ""),
        "rawTitle": article["rawTitle"],
    }


def merge_candidate(existing: dict | None, new_candidate: dict) -> dict:
    if not existing:
        return new_candidate
    merged = {**existing, **new_candidate}
    if existing.get("status") and existing.get("status") != "candidate":
        merged["status"] = existing["status"]
    for field in PERSISTED_CANDIDATE_FIELDS:
        if existing.get(field) is not None:
            merged[field] = existing[field]
    return merged


def candidate_key(candidate: dict) -> str:
    if candidate.get("fingerprint"):
        return str(candidate["fingerprint"])
    url = candidate.get("url") or candidate.get("sourceUrl") or ""
    title = candidate.get("title") or candidate.get("rawTitle") or ""
    return fingerprint_for(url, title, candidate.get("publishedAt"))


def sort_key(candidate: dict) -> tuple[str, str, str]:
    return (
        str(candidate.get("publishedAt") or "0000-00-00"),
        str(candidate.get("discoveredAt") or ""),
        str(candidate.get("title") or ""),
    )


def fetch_source(config: dict, discovered_at: str) -> tuple[list[dict], dict | None]:
    try:
        markup = fetch_markup(config["listUrl"])
        articles = extract_articles(markup, config)
        candidates = [build_candidate(config, article, discovered_at) for article in articles]
        return candidates, None
    except Exception as exc:  # noqa: BLE001 - preserve failed source status.
        return [], {
            "sourceId": config.get("id"),
            "sourceName": config.get("title"),
            "listUrl": config.get("listUrl"),
            "error": str(exc),
        }


def load_sources(path: Path, selected_source_ids: set[str]) -> list[dict]:
    config = read_json(path)
    sources = []
    for source in config.get("sources", []):
        if not source.get("enabled", True):
            continue
        if selected_source_ids and source.get("id") not in selected_source_ids and source.get("sourceId") not in selected_source_ids:
            continue
        sources.append(source)
    return sources


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch official news list pages into inbox candidates.")
    parser.add_argument("--sources", default=str(DEFAULT_SOURCES_PATH), help="official news source config path")
    parser.add_argument("--source-id", action="append", default=[], help="only fetch one source id; repeatable")
    parser.add_argument("--max-per-source", type=int, help="override max items per source")
    parser.add_argument("--dry-run", action="store_true", help="print payload without writing")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    discovered_at = now_shanghai()
    sources_path = Path(args.sources)
    sources = load_sources(sources_path, set(args.source_id))
    if args.max_per_source:
        for source in sources:
            source["maxItems"] = args.max_per_source

    existing_payload = read_json(
        NEWS_INBOX_PATH,
        {
            "version": 1,
            "date": discovered_at[:10],
            "capturedAt": discovered_at,
            "reviewStatus": "pending_manual_review",
            "policy": "Official news candidates enter inbox first. Review and promotion are separate steps.",
            "candidates": [],
            "errors": [],
        },
    )
    existing_by_key = {candidate_key(candidate): candidate for candidate in existing_payload.get("candidates", [])}

    errors = []
    new_count = 0
    for source in sources:
        candidates, error = fetch_source(source, discovered_at)
        if error:
            errors.append(error)
            continue
        for candidate in candidates:
            key = candidate_key(candidate)
            if key not in existing_by_key:
                new_count += 1
            existing_by_key[key] = merge_candidate(existing_by_key.get(key), candidate)

    candidates = sorted(existing_by_key.values(), key=sort_key, reverse=True)
    payload = {
        "version": 1,
        "date": discovered_at[:10],
        "capturedAt": discovered_at,
        "reviewStatus": "pending_manual_review",
        "policy": (
            "Official news list intake only writes candidates. Candidates must be captured, "
            "routed, processed by rules, reviewed and promoted before they become formal facts."
        ),
        "sourceConfigPath": str(sources_path.relative_to(ROOT)),
        "sourceCount": len(sources),
        "candidateCount": len(candidates),
        "newCandidateCount": new_count,
        "candidates": candidates,
        "errors": errors,
    }

    if args.dry_run:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        write_json(NEWS_INBOX_PATH, payload)
        print(
            f"Wrote {NEWS_INBOX_PATH} with {len(candidates)} candidates "
            f"({new_count} new) and {len(errors)} errors."
        )
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())
