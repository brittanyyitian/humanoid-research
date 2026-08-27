#!/usr/bin/env python3
"""Fetch CNINFO announcement candidates for A-share watchlist entities.

Announcements are merged into data/inbox/news_candidates.json so the existing
intake pipeline can turn them into review-gated claim/evidence candidates.
They are not promoted to facts by this script.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
ENTITIES_FILE = DATA_DIR / "entities" / "index.json"
NEWS_INBOX_PATH = DATA_DIR / "inbox" / "news_candidates.json"
CNINFO_STOCK_LIST_URL = "http://www.cninfo.com.cn/new/data/szse_stock.json"
CNINFO_QUERY_URL = "http://www.cninfo.com.cn/new/hisAnnouncement/query"
CNINFO_STATIC_URL = "http://static.cninfo.com.cn"

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


def fetch_json(url: str, data: dict | None = None) -> dict:
    encoded = urllib.parse.urlencode(data or {}).encode("utf-8") if data else None
    request = urllib.request.Request(
        url,
        data=encoded,
        headers={
            "User-Agent": "Mozilla/5.0 humanoid-research-cninfo-intake/0.1",
            "Referer": "http://www.cninfo.com.cn/new/index",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
    )
    with urllib.request.urlopen(request, timeout=18) as response:
        return json.loads(response.read().decode("utf-8"))


def fingerprint_for(*parts: str) -> str:
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:16]


def load_cninfo_stock_map() -> dict[str, dict]:
    payload = fetch_json(CNINFO_STOCK_LIST_URL)
    return {row.get("code"): row for row in payload.get("stockList", []) if row.get("code")}


def cninfo_plate(market: str, stock_code: str) -> tuple[str, str]:
    if market == "SZSE":
        return "szse", "sz"
    if market == "SSE":
        return "sse", "sh"
    raise ValueError(f"unsupported_market_for_cninfo:{market}:{stock_code}")


def date_from_announcement_time(value) -> str | None:
    if value in (None, "", "-"):
        return None
    try:
        return datetime.fromtimestamp(float(value) / 1000, ZoneInfo("Asia/Shanghai")).date().isoformat()
    except (TypeError, ValueError, OSError):
        return None


def candidate_key(candidate: dict) -> str:
    if candidate.get("fingerprint"):
        return str(candidate["fingerprint"])
    return fingerprint_for(candidate.get("url") or candidate.get("sourceUrl") or "", candidate.get("title") or "")


def sort_key(candidate: dict) -> tuple[str, str, str]:
    return (
        str(candidate.get("publishedAt") or "0000-00-00"),
        str(candidate.get("discoveredAt") or ""),
        str(candidate.get("title") or ""),
    )


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


def fetch_announcements(
    entity: dict,
    stock_meta: dict,
    start_date: str,
    end_date: str,
    limit: int,
    category: str = "",
) -> tuple[list[dict], dict | None]:
    stock_code = entity.get("stockCode")
    market = entity.get("market")
    try:
        column, plate = cninfo_plate(market, stock_code)
        payload = fetch_json(
            CNINFO_QUERY_URL,
            {
                "pageNum": 1,
                "pageSize": limit,
                "column": column,
                "tabName": "fulltext",
                "plate": plate,
                "stock": f"{stock_code},{stock_meta['orgId']}",
                "seDate": f"{start_date}~{end_date}",
                "searchkey": "",
                "category": category,
                "trade": "",
                "sortName": "",
                "sortType": "",
                "isHLtitle": "true",
            },
        )
    except Exception as exc:  # noqa: BLE001 - caller records source status.
        return [], {
            "sourceId": f"src_cninfo_{stock_code}_announcements",
            "sourceName": f"巨潮资讯公告 · {entity.get('name')}",
            "listUrl": CNINFO_QUERY_URL,
            "error": str(exc),
        }

    announcements = payload.get("announcements") or []
    candidates = []
    for item in announcements[:limit]:
        title = (item.get("announcementTitle") or item.get("shortTitle") or "").strip()
        adjunct_url = item.get("adjunctUrl")
        published_at = date_from_announcement_time(item.get("announcementTime"))
        announcement_id = str(item.get("announcementId") or fingerprint_for(stock_code, title, published_at or ""))
        if not title or not adjunct_url or not published_at:
            continue
        url = f"{CNINFO_STATIC_URL}/{adjunct_url.lstrip('/')}"
        fingerprint = fingerprint_for("cninfo", stock_code, announcement_id)
        candidates.append(
            {
                "id": f"announcement_candidate_{fingerprint}",
                "entityId": entity["id"],
                "entityIds": [entity["id"]],
                "sourceId": f"src_cninfo_{stock_code}_announcements",
                "sourceName": f"巨潮资讯公告 · {entity.get('name')}",
                "publisher": item.get("secName") or entity.get("name"),
                "title": title,
                "url": url,
                "sourceUrl": url,
                "listUrl": CNINFO_QUERY_URL,
                "publishedAt": published_at,
                "discoveredAt": now_shanghai(),
                "sourceType": "exchange_announcement",
                "ingestionSourceType": "exchange",
                "artifactType": "filing",
                "status": "candidate",
                "reviewStatus": "pending",
                "fingerprint": fingerprint,
                "routeHint": "filing_pipeline",
                "parserType": "cninfo_announcement",
                "suggestedEvidenceLevel": "A",
                "moduleHint": entity.get("segment") or entity.get("kind") or "",
                "rawTitle": title,
                "announcementId": announcement_id,
                "stockCode": stock_code,
                "market": market,
            }
        )
    return candidates, None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch CNINFO announcement candidates.")
    parser.add_argument("--days", type=int, default=45, help="Calendar days to look back.")
    parser.add_argument("--limit-per-entity", type=int, default=5, help="Max announcements per entity.")
    parser.add_argument(
        "--entity-ids",
        default="",
        help="Optional comma-separated entity IDs. When omitted, fetch every A-share watchlist entity.",
    )
    parser.add_argument(
        "--category",
        default="",
        help="Optional CNINFO category filter, for example category_ndbg_szsh for annual reports.",
    )
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    selected_entity_ids = {value.strip() for value in args.entity_ids.split(",") if value.strip()}
    captured_at = now_shanghai()
    end = datetime.now(ZoneInfo("Asia/Shanghai")).date()
    start = end - timedelta(days=max(args.days, 1) - 1)
    entities = read_json(ENTITIES_FILE).get("entities", [])
    a_share_watchlist = [
        entity
        for entity in entities
        if entity.get("listed")
        and entity.get("market") in {"SZSE", "SSE"}
        and "Watchlist" in (entity.get("tags") or [])
        and entity.get("stockCode")
        and (not selected_entity_ids or entity.get("id") in selected_entity_ids)
    ]
    stock_map = load_cninfo_stock_map()

    existing_payload = read_json(
        NEWS_INBOX_PATH,
        {
            "version": 1,
            "date": captured_at[:10],
            "capturedAt": captured_at,
            "reviewStatus": "pending_manual_review",
            "policy": "Candidates enter inbox first. Review and promotion are separate steps.",
            "candidates": [],
            "errors": [],
        },
    )
    existing_by_key = {candidate_key(candidate): candidate for candidate in existing_payload.get("candidates", [])}
    errors = []
    new_count = 0
    fetched_count = 0

    for entity in a_share_watchlist:
        stock_code = entity.get("stockCode")
        stock_meta = stock_map.get(stock_code)
        if not stock_meta:
            errors.append(
                {
                    "sourceId": f"src_cninfo_{stock_code}_announcements",
                    "sourceName": f"巨潮资讯公告 · {entity.get('name')}",
                    "listUrl": CNINFO_STOCK_LIST_URL,
                    "error": "missing_cninfo_org_id",
                }
            )
            continue
        candidates, error = fetch_announcements(
            entity,
            stock_meta,
            start.isoformat(),
            end.isoformat(),
            args.limit_per_entity,
            args.category,
        )
        if error:
            errors.append(error)
            continue
        fetched_count += len(candidates)
        for candidate in candidates:
            key = candidate_key(candidate)
            if key not in existing_by_key:
                new_count += 1
            existing_by_key[key] = merge_candidate(existing_by_key.get(key), candidate)

    candidates = sorted(existing_by_key.values(), key=sort_key, reverse=True)
    payload = {
        **existing_payload,
        "version": 1,
        "date": captured_at[:10],
        "capturedAt": captured_at,
        "reviewStatus": "pending_manual_review",
        "policy": (
            "Inbox candidates are not formal facts. Candidates must be captured, routed, "
            "processed by rules, reviewed and promoted before they become observations."
        ),
        "candidateCount": len(candidates),
        "newCandidateCount": int(existing_payload.get("newCandidateCount") or 0) + new_count,
        "announcementCandidateCount": sum(1 for candidate in candidates if candidate.get("parserType") == "cninfo_announcement"),
        "announcementFetchedCount": fetched_count,
        "candidates": candidates,
        "errors": [*(existing_payload.get("errors") or []), *errors],
    }

    if args.dry_run:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        write_json(NEWS_INBOX_PATH, payload)
        print(
            f"Merged {fetched_count} CNINFO announcement candidates into {NEWS_INBOX_PATH} "
            f"({new_count} new, {len(errors)} errors)."
        )
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
