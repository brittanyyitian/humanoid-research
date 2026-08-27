#!/usr/bin/env python3
"""Backfill final daily market snapshots for listed watchlist entities.

The script writes only market facts. It does not infer event impact.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
ENTITIES_FILE = DATA_DIR / "entities" / "index.json"
STOCKS_DIR = DATA_DIR / "stocks"
EASTMONEY_SOURCE_ID = "src_eastmoney_market_quote"
TENCENT_SOURCE_ID = "src_tencent_market_quote"

KLINE_FIELDS = ",".join(
    [
        "f51",  # date
        "f52",  # open
        "f53",  # close
        "f54",  # high
        "f55",  # low
        "f56",  # volume
        "f57",  # turnover amount
        "f58",  # amplitude
        "f59",  # change pct
        "f60",  # change amount
        "f61",  # turnover rate
    ]
)


def read_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)


def write_json(path: Path, payload: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)
        file.write("\n")


def parse_float(value):
    if value in (None, "-", ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def percent_change(current: float | None, base: float | None) -> float | None:
    if current is None or base in (None, 0):
        return None
    return round((current / base - 1) * 100, 2)


def yuan_to_cn(value) -> str | None:
    amount = parse_float(value)
    if amount is None:
        return None
    if abs(amount) >= 100_000_000:
        return f"{amount / 100_000_000:.2f}亿"
    if abs(amount) >= 10_000:
        return f"{amount / 10_000:.2f}万"
    return f"{amount:.0f}"


def eastmoney_secid(market: str | None, stock_code: str | None) -> str | None:
    if not stock_code:
        return None
    if market == "SZSE":
        return f"0.{stock_code}"
    if market == "SSE":
        return f"1.{stock_code}"
    if market == "HKEX":
        return f"116.{stock_code}"
    return None


def quote_page(market: str | None, stock_code: str | None) -> str | None:
    if not stock_code:
        return None
    if market == "SZSE":
        return f"https://quote.eastmoney.com/sz{stock_code}.html"
    if market == "SSE":
        return f"https://quote.eastmoney.com/sh{stock_code}.html"
    if market == "HKEX":
        return f"https://quote.eastmoney.com/hk/{stock_code}.html"
    return None


def tencent_symbol(market: str | None, stock_code: str | None) -> str | None:
    if not stock_code:
        return None
    if market == "SZSE":
        return f"sz{stock_code}"
    if market == "SSE":
        return f"sh{stock_code}"
    if market == "HKEX":
        return f"hk{stock_code}"
    return None


def date_token(value: date) -> str:
    return value.strftime("%Y%m%d")


def market_file(day: str) -> Path:
    return STOCKS_DIR / f"market_{day.replace('-', '_')}.json"


def fetch_json(url: str) -> dict:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 humanoid-research/0.1",
            "Referer": "https://quote.eastmoney.com/",
        },
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def fetch_eastmoney_history(entity: dict, begin: date, end: date) -> tuple[str, list[dict]]:
    stock_code = entity.get("stockCode")
    market = entity.get("market")
    secid = eastmoney_secid(market, stock_code)
    if not secid:
        raise ValueError("missing_eastmoney_secid")

    query = urllib.parse.urlencode(
        {
            "secid": secid,
            "fields1": "f1,f2,f3,f4,f5,f6",
            "fields2": KLINE_FIELDS,
            "klt": "101",
            "fqt": "1",
            "beg": date_token(begin),
            "end": date_token(end),
        }
    )
    source_url = f"https://push2his.eastmoney.com/api/qt/stock/kline/get?{query}"
    payload = fetch_json(source_url)
    lines = ((payload.get("data") or {}).get("klines")) or []

    rows = []
    for line in lines:
        parts = line.split(",")
        if len(parts) < 11:
            continue
        rows.append(
            {
                "date": parts[0],
                "open": parse_float(parts[1]),
                "close": parse_float(parts[2]),
                "high": parse_float(parts[3]),
                "low": parse_float(parts[4]),
                "volume": parse_float(parts[5]),
                "turnoverAmount": yuan_to_cn(parts[6]),
                "changePct": parse_float(parts[8]),
                "turnoverRate": parse_float(parts[10]),
            }
        )
    return source_url, rows


def fetch_tencent_history(entity: dict, begin: date, end: date) -> tuple[str, list[dict]]:
    symbol = tencent_symbol(entity.get("market"), entity.get("stockCode"))
    if not symbol:
        raise ValueError("missing_tencent_symbol")

    source_url = f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={symbol},day,,,90,qfq"
    payload = fetch_json(source_url)
    raw = ((payload.get("data") or {}).get(symbol) or {})
    raw_rows = raw.get("qfqday") or raw.get("day") or []
    rows = []
    for raw_row in raw_rows:
        if len(raw_row) < 6:
            continue
        row_date = datetime.strptime(raw_row[0], "%Y-%m-%d").date()
        if begin <= row_date <= end:
            rows.append(
                {
                    "date": raw_row[0],
                    "open": parse_float(raw_row[1]),
                    "close": parse_float(raw_row[2]),
                    "high": parse_float(raw_row[3]),
                    "low": parse_float(raw_row[4]),
                    "volume": parse_float(raw_row[5]),
                    "turnoverAmount": None,
                    "changePct": None,
                    "turnoverRate": None,
                }
            )
    return source_url, rows


def attach_rolling_metrics(rows: list[dict]) -> list[dict]:
    sorted_rows = sorted(rows, key=lambda row: row["date"])
    for index, row in enumerate(sorted_rows):
        close = row.get("close")
        if row.get("changePct") is None and index >= 1:
            row["changePct"] = percent_change(close, sorted_rows[index - 1].get("close"))
        row["fiveDayChangePct"] = percent_change(close, sorted_rows[index - 5].get("close")) if index >= 5 else None
        row["twentyDayChangePct"] = percent_change(close, sorted_rows[index - 20].get("close")) if index >= 20 else None
    return sorted_rows


def snapshot_from_row(entity: dict, row: dict, source_url: str, provider: str) -> dict:
    day = row["date"]
    stock_code = entity.get("stockCode")
    return {
        "id": f"stock_{day}_{entity['id']}",
        "date": day,
        "entityId": entity["id"],
        "stockCode": stock_code,
        "market": entity.get("market"),
        "snapshotType": "historical_daily_close",
        "isFinal": True,
        "price": row.get("close"),
        "open": row.get("open"),
        "high": row.get("high"),
        "low": row.get("low"),
        "volume": row.get("volume"),
        "changePct": row.get("changePct"),
        "turnoverAmount": row.get("turnoverAmount"),
        "turnoverRate": row.get("turnoverRate"),
        "totalMarketCap": None,
        "floatMarketCap": None,
        "mainNetInflow": None,
        "fiveDayChangePct": row.get("fiveDayChangePct"),
        "twentyDayChangePct": row.get("twentyDayChangePct"),
        "sourceIds": [EASTMONEY_SOURCE_ID if provider == "eastmoney" else TENCENT_SOURCE_ID],
        "capturedAt": f"{day}T15:30:00+08:00",
        "provider": provider,
        "providerSourceUrl": source_url,
        "quoteUrl": quote_page(entity.get("market"), stock_code) or source_url,
        "klineSourceUrl": source_url,
        "quoteTime": f"{day} close",
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill market daily close snapshots.")
    parser.add_argument("--start", help="Start date, YYYY-MM-DD.")
    parser.add_argument("--end", help="End date, YYYY-MM-DD.")
    parser.add_argument("--days", type=int, default=14, help="Calendar days to look back when start/end are omitted.")
    parser.add_argument("--overwrite", action="store_true", help="Rewrite existing market_YYYY_MM_DD.json files.")
    parser.add_argument(
        "--entity-ids",
        default="",
        help="Optional comma-separated entity IDs. Existing daily files are merged for these entities.",
    )
    return parser.parse_args()


def resolve_window(args: argparse.Namespace) -> tuple[date, date]:
    if args.start or args.end:
        if not (args.start and args.end):
            raise ValueError("--start and --end must be provided together")
        return date.fromisoformat(args.start), date.fromisoformat(args.end)

    today = datetime.now(ZoneInfo("Asia/Shanghai")).date()
    end = today - timedelta(days=1)
    return end - timedelta(days=max(args.days, 1) - 1), end


def main() -> int:
    args = parse_args()
    selected_entity_ids = {value.strip() for value in args.entity_ids.split(",") if value.strip()}
    start, end = resolve_window(args)
    fetch_begin = start - timedelta(days=70)
    entities = read_json(ENTITIES_FILE).get("entities", [])
    watchlist = [
        entity
        for entity in entities
        if entity.get("listed") and "Watchlist" in (entity.get("tags") or [])
        and (not selected_entity_ids or entity.get("id") in selected_entity_ids)
    ]

    snapshots_by_date: dict[str, list[dict]] = defaultdict(list)
    failures = []

    for entity in watchlist:
        try:
            provider = "eastmoney"
            source_url, rows = fetch_eastmoney_history(entity, fetch_begin, end)
        except Exception as eastmoney_error:  # noqa: BLE001 - Tencent is a source fallback.
            try:
                provider = "tencent"
                source_url, rows = fetch_tencent_history(entity, fetch_begin, end)
            except Exception as tencent_error:  # noqa: BLE001 - keep all source failures visible.
                failures.append(
                    {
                        "entityId": entity.get("id"),
                        "stockCode": entity.get("stockCode"),
                        "error": f"eastmoney: {eastmoney_error}; tencent: {tencent_error}",
                    }
                )
                continue

        for row in attach_rolling_metrics(rows):
            row_date = date.fromisoformat(row["date"])
            if start <= row_date <= end:
                snapshots_by_date[row["date"]].append(snapshot_from_row(entity, row, source_url, provider))

    current = start
    written = []
    skipped = []
    while current <= end:
        day = current.isoformat()
        rows = sorted(snapshots_by_date.get(day, []), key=lambda row: row["entityId"])
        output = market_file(day)
        if not rows:
            skipped.append((day, "no_market_rows"))
        elif output.exists() and selected_entity_ids:
            existing_rows = read_json(output)
            merged_by_entity = {row.get("entityId"): row for row in existing_rows}
            merged_by_entity.update({row.get("entityId"): row for row in rows})
            merged_rows = sorted(merged_by_entity.values(), key=lambda row: row["entityId"])
            write_json(output, merged_rows)
            written.append((day, len(merged_rows), output))
        elif output.exists() and not args.overwrite:
            skipped.append((day, "exists"))
        else:
            write_json(output, rows)
            written.append((day, len(rows), output))
        current += timedelta(days=1)

    for day, count, output in written:
        print(f"Wrote {count} rows for {day} -> {output}")
    for day, reason in skipped:
        print(f"Skipped {day}: {reason}")
    if failures:
        print("Source failures:")
        for failure in failures:
            print(json.dumps(failure, ensure_ascii=False))
    return 1 if failures and not written else 0


if __name__ == "__main__":
    sys.exit(main())
