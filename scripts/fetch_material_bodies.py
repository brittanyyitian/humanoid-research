#!/usr/bin/env python3
"""Fetch body text for material payloads.

This upgrades metadata-only raw payloads into readable research materials.
It does not promote claims or create observations.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import sys
import urllib.request
from datetime import datetime
from io import BytesIO
from pathlib import Path
from zoneinfo import ZoneInfo

from pypdf import PdfReader


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
RAW_ARTIFACTS_DIR = DATA_DIR / "raw_artifacts"
PAYLOADS_DIR = RAW_ARTIFACTS_DIR / "payloads"
CLAIMS_DIR = DATA_DIR / "claims"
FETCH_RUNS_DIR = DATA_DIR / "fetch_runs"
MATERIALS_FILE = DATA_DIR / "dashboard" / "serenity_materials.json"

PRIORITY_RANK = {"high": 0, "medium": 1, "low": 2}
ARTIFACT_TYPES = {"filing", "pdf", "news_page", "product_page", "webpage"}


def now_shanghai() -> str:
    return datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds")


def read_json(path: Path, fallback=None):
    try:
        with path.open("r", encoding="utf-8") as file:
            return json.load(file)
    except FileNotFoundError:
        if fallback is not None:
            return fallback
        raise


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)
        file.write("\n")


def stable_stringify(value) -> str:
    if isinstance(value, list):
        return "[" + ",".join(stable_stringify(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(json.dumps(key, ensure_ascii=False) + ":" + stable_stringify(value[key]) for key in sorted(value)) + "}"
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def content_hash(content: dict) -> str:
    return "sha256:" + hashlib.sha256(stable_stringify(content).encode("utf-8")).hexdigest()


def fetch_bytes(url: str) -> tuple[bytes, str | None]:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 humanoid-research-material-fetch/0.1",
            "Accept": "text/html,application/pdf,application/xhtml+xml",
        },
    )
    with urllib.request.urlopen(request, timeout=24) as response:
        return response.read(), response.headers.get_content_type()


def extract_pdf_text(raw: bytes, max_pages: int, max_chars: int) -> tuple[str, dict]:
    reader = PdfReader(BytesIO(raw))
    parts = []
    pages_read = 0
    for page in reader.pages[:max_pages]:
        pages_read += 1
        text = page.extract_text() or ""
        if text.strip():
            parts.append(text)
        if sum(len(item) for item in parts) >= max_chars:
            break
    text = normalize_text("\n".join(parts))[:max_chars]
    return text, {
        "method": "pypdf",
        "pageCount": len(reader.pages),
        "pagesRead": pages_read,
        "truncated": len(normalize_text("\n".join(parts))) > max_chars or len(reader.pages) > pages_read,
    }


def extract_html_text(raw: bytes, content_type: str | None, max_chars: int) -> tuple[str, dict]:
    charset = "utf-8"
    if content_type and "charset=" in content_type:
        charset = content_type.split("charset=", 1)[1].split(";", 1)[0].strip()
    try:
        markup = raw.decode(charset, errors="ignore")
    except LookupError:
        markup = raw.decode("utf-8", errors="ignore")
    if len(markup) and mostly_replacement(markup):
        markup = raw.decode("gb18030", errors="ignore")
    markup = re.sub(r"(?is)<(script|style|noscript)\b.*?</\1>", " ", markup)
    markup = re.sub(r"(?is)<br\s*/?>", "\n", markup)
    markup = re.sub(r"(?is)</(p|div|li|h[1-6]|tr)>", "\n", markup)
    text = re.sub(r"(?is)<[^>]+>", " ", markup)
    text = html.unescape(text)
    text = normalize_text(text)
    return text[:max_chars], {
        "method": "html_regex",
        "truncated": len(text) > max_chars,
    }


def mostly_replacement(value: str) -> bool:
    return value.count("\ufffd") > max(10, len(value) // 100)


def normalize_text(value: str) -> str:
    value = value.replace("\u00a0", " ")
    value = re.sub(r"[ \t\r\f\v]+", " ", value)
    value = re.sub(r"\n\s+", "\n", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def is_pdf(url: str, content_type: str | None, artifact_type: str) -> bool:
    return url.lower().endswith(".pdf") or content_type == "application/pdf" or artifact_type in {"filing", "pdf"}


def load_material_priority() -> dict[str, str]:
    payload = read_json(MATERIALS_FILE, {"rows": []})
    return {row.get("rawArtifactId"): row.get("priority", "medium") for row in payload.get("rows", [])}


def load_candidates(args: argparse.Namespace) -> list[dict]:
    priorities = load_material_priority()
    rows = []
    threshold = PRIORITY_RANK.get(args.priority, 3)
    requested_entities = {
        value.strip() for value in (args.entity_ids or "").split(",") if value.strip()
    }
    for artifact_file in RAW_ARTIFACTS_DIR.glob("raw_*.json"):
        artifact = read_json(artifact_file)
        artifact_type = artifact.get("artifactType")
        if artifact_type not in ARTIFACT_TYPES:
            continue
        if args.entity_id and args.entity_id not in (artifact.get("entityIds") or []):
            continue
        if requested_entities and not requested_entities.intersection(artifact.get("entityIds") or []):
            continue
        payload = read_json(PAYLOADS_DIR / f"{artifact['id']}.json", None)
        if not payload or payload.get("retrievalStatus") != "metadata_only":
            continue
        priority = priorities.get(artifact["id"], infer_priority_from_artifact(artifact))
        if PRIORITY_RANK.get(priority, 1) > threshold:
            continue
        rows.append(
            {
                "artifact": artifact,
                "artifactFile": artifact_file,
                "payload": payload,
                "payloadFile": PAYLOADS_DIR / f"{artifact['id']}.json",
                "priority": priority,
            }
        )
    sorted_rows = sorted(
        rows,
        key=lambda row: (
            PRIORITY_RANK.get(row["priority"], 1),
            -date_sort_value(row["artifact"].get("publishedAt") or row["artifact"].get("capturedAt")),
            row["artifact"]["id"],
        ),
    )
    if args.limit_per_entity:
        selected = []
        counts: dict[str, int] = {}
        for row in sorted_rows:
            entity_ids = row["artifact"].get("entityIds") or ["unknown"]
            if all(counts.get(entity_id, 0) >= args.limit_per_entity for entity_id in entity_ids):
                continue
            selected.append(row)
            for entity_id in entity_ids:
                counts[entity_id] = counts.get(entity_id, 0) + 1
            if len(selected) >= args.limit:
                break
        return selected
    return sorted_rows[: args.limit]


def date_sort_value(value) -> int:
    text = str(value or "0000-00-00")[:10].replace("-", "")
    try:
        return int(text)
    except ValueError:
        return 0


def infer_priority_from_artifact(artifact: dict) -> str:
    text = f"{artifact.get('title') or ''} {artifact.get('notes') or ''}"
    if re.search(r"订单|客户|交付|合作|量产|产线|机器人|人形|具身|财报|年度报告|年报|半年度|季度报告|一季度|三季度|业绩|收入|利润|现金流|临床试验|药品|储量|产量|发电量|专利|定增|募投", text):
        return "high"
    if re.search(r"质押|担保|减持|会议|股东|董事|监事|分红|权益", text):
        return "low"
    return "medium"


def update_fetch_run(fetch_run_id: str, status: str, captured_at: str, content_hash: str | None, storage_path: str, gap=None) -> None:
    path = FETCH_RUNS_DIR / f"{fetch_run_id}.json"
    run = read_json(path, None)
    if not run:
        return
    run["finishedAt"] = captured_at
    run["status"] = status
    if status == "success":
        run["error"] = None
    if status == "success":
        gaps = [item for item in (run.get("gaps") or []) if item.get("kind") != "raw_payload_not_fetched"]
    else:
        gaps = run.get("gaps") or []
    if gap:
        gaps.append(gap)
    run["gaps"] = gaps
    run.setdefault("attemptLedger", []).append(
        {
            "kind": "material_body_fetch",
            "status": status,
            "startedAt": captured_at,
            "finishedAt": captured_at,
            "contentHash": content_hash or "",
            "storagePath": storage_path,
        }
    )
    write_json(path, run)


def update_claim_gaps(artifact_id: str) -> int:
    updated = 0
    for claim_file in CLAIMS_DIR.glob("claim_*.json"):
        claim = read_json(claim_file)
        if artifact_id not in (claim.get("artifactIds") or []):
            continue
        gaps = [gap for gap in (claim.get("dataGaps") or []) if gap.get("kind") != "raw_payload_not_fetched"]
        if gaps != (claim.get("dataGaps") or []):
            claim["dataGaps"] = gaps
            write_json(claim_file, claim)
            updated += 1
    return updated


def fetch_one(row: dict, args: argparse.Namespace) -> dict:
    artifact = row["artifact"]
    payload = row["payload"]
    captured_at = now_shanghai()
    url = artifact.get("url")
    raw, content_type = fetch_bytes(url)
    if is_pdf(url, content_type, artifact.get("artifactType")):
        text, extraction = extract_pdf_text(raw, args.max_pages, args.max_chars)
        body_format = "pdf_text"
    else:
        text, extraction = extract_html_text(raw, content_type, args.max_chars)
        body_format = "text"

    if len(text) < args.min_chars:
        update_fetch_run(
            artifact["fetchRunId"],
            "partial",
            captured_at,
            artifact.get("contentHash"),
            artifact.get("storagePath") or "",
            {
                "kind": "body_extraction_empty",
                "description": "Material body fetch ran but extracted too little text.",
                "severity": "medium",
            },
        )
        return {"id": artifact["id"], "status": "too_short", "chars": len(text), "url": url}

    payload["retrievalStatus"] = "captured_payload"
    payload["capturedAt"] = captured_at
    payload.setdefault("content", {})
    payload["content"]["body"] = text
    payload["content"]["bodyFormat"] = body_format
    payload["bodyFetch"] = {
        "fetchedAt": captured_at,
        "contentType": content_type,
        "byteLength": len(raw),
        **extraction,
    }
    new_hash = content_hash(payload["content"])
    artifact["contentHash"] = new_hash
    write_json(row["payloadFile"], payload)
    write_json(row["artifactFile"], artifact)
    update_fetch_run(artifact["fetchRunId"], "success", captured_at, new_hash, artifact.get("storagePath") or "")
    updated_claims = update_claim_gaps(artifact["id"])
    return {
        "id": artifact["id"],
        "status": "captured",
        "chars": len(text),
        "format": body_format,
        "claimsUpdated": updated_claims,
        "url": url,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch body text for metadata-only research materials.")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--priority", choices=["high", "medium", "low", "all"], default="high")
    parser.add_argument("--entity-id")
    parser.add_argument("--entity-ids", help="Comma-separated entity ids")
    parser.add_argument("--limit-per-entity", type=int)
    parser.add_argument("--max-pages", type=int, default=20)
    parser.add_argument("--max-chars", type=int, default=80_000)
    parser.add_argument("--min-chars", type=int, default=80)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    rows = load_candidates(args)
    if args.dry_run:
        print(
            json.dumps(
                [
                    {
                        "id": row["artifact"]["id"],
                        "title": row["artifact"]["title"],
                        "url": row["artifact"]["url"],
                        "priority": row["priority"],
                        "entityIds": row["artifact"].get("entityIds") or [],
                    }
                    for row in rows
                ],
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    results = []
    failures = 0
    for row in rows:
        try:
            result = fetch_one(row, args)
        except Exception as exc:  # noqa: BLE001 - keep batch fetch moving.
            failures += 1
            result = {
                "id": row["artifact"]["id"],
                "status": "failed",
                "error": str(exc),
                "url": row["artifact"].get("url"),
            }
        results.append(result)
        print(json.dumps(result, ensure_ascii=False))

    captured = sum(1 for item in results if item["status"] == "captured")
    print(f"Material body fetch complete. selected={len(rows)}, captured={captured}, failed={failures}.")
    return 1 if failures and not captured else 0


if __name__ == "__main__":
    sys.exit(main())
