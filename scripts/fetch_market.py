#!/usr/bin/env python3
"""Fetch structured market quotes for listed watchlist entities.

Output goes to data/inbox/market_latest.json first. The script does not infer
why a stock moved, and it does not write formal stock snapshots by default.
"""

from __future__ import annotations

import json
import sys
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
INBOX_DIR = DATA_DIR / "inbox"
ENTITIES_FILE = DATA_DIR / "entities" / "index.json"
STOCKS_DIR = DATA_DIR / "stocks"
PROMOTED_SOURCE_ID = "src_eastmoney_market_quote"
PROVIDER_SOURCE_IDS = {
    "eastmoney": "src_eastmoney_market_quote",
    "tencent": "src_tencent_market_quote",
}

EASTMONEY_FIELDS = ",".join(
    [
        "f43",  # latest price, scaled by 100
        "f48",  # turnover amount, yuan
        "f57",  # stock code
        "f58",  # stock name
        "f62",  # main net inflow, yuan
        "f168",  # turnover rate, scaled by 100
        "f170",  # change pct, scaled by 100
    ]
)


def now_shanghai() -> str:
    return datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds")


def read_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)
        file.write("\n")


def promote_stock_snapshots(rows: list[dict], captured_at: str) -> tuple[Path, int]:
    date = captured_at[:10]
    snapshots = []
    for row in rows:
        if row.get("status") != "fetched":
            continue
        snapshots.append(
            {
                "id": f"stock_{date}_{row['entityId']}",
                "date": date,
                "entityId": row["entityId"],
                "stockCode": row["stockCode"],
                "market": row["market"],
                "snapshotType": "intraday_or_latest",
                "isFinal": False,
                "price": row.get("price"),
                "changePct": row.get("changePct"),
                "turnoverAmount": row.get("turnoverAmount"),
                "turnoverRate": row.get("turnoverRate"),
                "totalMarketCap": row.get("totalMarketCap"),
                "floatMarketCap": row.get("floatMarketCap"),
                "mainNetInflow": row.get("mainNetInflow"),
                "fiveDayChangePct": row.get("fiveDayChangePct"),
                "twentyDayChangePct": row.get("twentyDayChangePct"),
                "sourceIds": [PROVIDER_SOURCE_IDS.get(row.get("provider"), PROMOTED_SOURCE_ID)],
                "capturedAt": captured_at,
                "provider": row.get("provider"),
                "providerSourceUrl": row.get("sourceUrl"),
                "quoteUrl": row.get("quoteUrl"),
                "klineSourceUrl": row.get("klineSourceUrl"),
                "quoteTime": row.get("quoteTime"),
            }
        )

    output = STOCKS_DIR / f"market_{date.replace('-', '_')}.json"
    if snapshots:
        write_json(output, snapshots)
    return output, len(snapshots)


def eastmoney_secid(market: str | None, stock_code: str | None) -> str | None:
    if not stock_code:
        return None
    if market == "SZSE":
        return f"0.{stock_code}"
    if market == "SSE":
        return f"1.{stock_code}"
    return None


def quote_page(market: str | None, stock_code: str | None) -> str | None:
    if not stock_code:
        return None
    if market == "SZSE":
        return f"https://quote.eastmoney.com/sz{stock_code}.html"
    if market == "SSE":
        return f"https://quote.eastmoney.com/sh{stock_code}.html"
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


def scaled(value, divisor: int = 100):
    if value in (None, "-", ""):
        return None
    try:
        return round(float(value) / divisor, 2)
    except (TypeError, ValueError):
        return None


def yuan_to_cn(value) -> str | None:
    if value in (None, "-", ""):
        return None
    try:
        amount = float(value)
    except (TypeError, ValueError):
        return None
    if abs(amount) >= 100_000_000:
        return f"{amount / 100_000_000:.2f}亿"
    if abs(amount) >= 10_000:
        return f"{amount / 10_000:.2f}万"
    return f"{amount:.0f}"


def cap_to_cn_yi(value, suffix: str = "亿") -> str | None:
    if value in (None, "-", ""):
        return None
    try:
        amount = float(value)
    except (TypeError, ValueError):
        return None
    return f"{amount:.2f}{suffix}"


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


def fetch_eastmoney(entity: dict) -> dict:
    stock_code = entity.get("stockCode")
    market = entity.get("market")
    secid = eastmoney_secid(market, stock_code)
    if not secid:
        return {
            "entityId": entity.get("id"),
            "company": entity.get("name"),
            "stockCode": stock_code,
            "market": market,
            "status": "skipped",
            "reason": "missing_a_share_code_or_market",
        }

    query = urllib.parse.urlencode({"secid": secid, "fields": EASTMONEY_FIELDS})
    source_url = f"https://push2.eastmoney.com/api/qt/stock/get?{query}"
    request = urllib.request.Request(
        source_url,
        headers={
            "User-Agent": "Mozilla/5.0 humanoid-research/0.1",
            "Referer": quote_page(market, stock_code) or "https://quote.eastmoney.com/",
        },
    )

    with urllib.request.urlopen(request, timeout=12) as response:
        payload = json.loads(response.read().decode("utf-8"))

    raw = payload.get("data") or {}
    return {
        "entityId": entity.get("id"),
        "company": entity.get("name"),
        "stockCode": raw.get("f57") or stock_code,
        "market": market,
        "status": "fetched",
        "provider": "eastmoney",
        "sourceName": "东方财富公开行情接口",
        "sourceUrl": source_url,
        "quoteUrl": quote_page(market, stock_code),
        "price": scaled(raw.get("f43")),
        "changePct": scaled(raw.get("f170")),
        "turnoverAmount": yuan_to_cn(raw.get("f48")),
        "turnoverRate": scaled(raw.get("f168")),
        "mainNetInflow": yuan_to_cn(raw.get("f62")),
        "raw": raw,
    }


def fetch_tencent(entity: dict) -> dict:
    stock_code = entity.get("stockCode")
    market = entity.get("market")
    symbol = tencent_symbol(market, stock_code)
    if not symbol:
        return {
            "entityId": entity.get("id"),
            "company": entity.get("name"),
            "stockCode": stock_code,
            "market": market,
            "status": "skipped",
            "reason": "missing_a_share_code_or_market",
        }

    source_url = f"https://qt.gtimg.cn/q={symbol}"
    request = urllib.request.Request(
        source_url,
        headers={"User-Agent": "Mozilla/5.0 humanoid-research/0.1"},
    )

    with urllib.request.urlopen(request, timeout=12) as response:
        body = response.read().decode("gbk", errors="ignore")

    if '="' not in body:
        raise ValueError("unexpected_tencent_quote_response")

    parts = body.split('="', 1)[1].rsplit('";', 1)[0].split("~")
    if len(parts) < 39:
        raise ValueError("incomplete_tencent_quote_fields")

    is_hk = market == "HKEX"
    currency_suffix = "亿港元" if is_hk else "亿"
    kline = fetch_tencent_kline(symbol)

    return {
        "entityId": entity.get("id"),
        "company": entity.get("name"),
        "stockCode": parts[2] or stock_code,
        "market": market,
        "status": "fetched",
        "provider": "tencent",
        "sourceName": "腾讯财经公开行情接口",
        "sourceUrl": source_url,
        "quoteUrl": source_url,
        "klineSourceUrl": kline["sourceUrl"],
        "price": parse_float(parts[3]),
        "changePct": parse_float(parts[32]),
        "turnoverAmount": yuan_to_cn(parse_float(parts[37]) * (1 if is_hk else 10_000) if parts[37] else None),
        "turnoverRate": parse_float(parts[38]),
        "totalMarketCap": cap_to_cn_yi(parts[45] if len(parts) > 45 else None, currency_suffix),
        "floatMarketCap": cap_to_cn_yi(parts[44] if len(parts) > 44 else None, currency_suffix),
        "mainNetInflow": None,
        "quoteTime": parts[30] or None,
        "fiveDayChangePct": kline["fiveDayChangePct"],
        "twentyDayChangePct": kline["twentyDayChangePct"],
        "raw": {"fields": parts},
    }


def fetch_tencent_kline(symbol: str) -> dict:
    source_url = f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={symbol},day,,,30,qfq"
    request = urllib.request.Request(
        source_url,
        headers={"User-Agent": "Mozilla/5.0 humanoid-research/0.1"},
    )
    with urllib.request.urlopen(request, timeout=12) as response:
        payload = json.loads(response.read().decode("utf-8"))

    rows = (payload.get("data") or {}).get(symbol, {})
    kline_rows = rows.get("qfqday") or rows.get("day") or []
    closes = [parse_float(row[2]) for row in kline_rows if len(row) > 2]
    closes = [value for value in closes if value is not None]
    current = closes[-1] if closes else None
    return {
        "sourceUrl": source_url,
        "fiveDayChangePct": percent_change(current, closes[-6] if len(closes) >= 6 else None),
        "twentyDayChangePct": percent_change(current, closes[-21] if len(closes) >= 21 else None),
    }


def fetch_quote(entity: dict) -> dict:
    try:
        return fetch_tencent(entity)
    except Exception as tencent_error:  # noqa: BLE001 - fallback keeps source diversity.
        try:
            row = fetch_eastmoney(entity)
            row["fallbackFrom"] = {
                "provider": "tencent",
                "error": str(tencent_error),
            }
            return row
        except Exception as eastmoney_error:  # noqa: BLE001 - caller records final error.
            raise RuntimeError(
                f"tencent failed: {tencent_error}; eastmoney failed: {eastmoney_error}"
            ) from eastmoney_error


def main() -> int:
    promote = "--promote" in sys.argv[1:]
    captured_at = now_shanghai()
    entities = read_json(ENTITIES_FILE).get("entities", [])
    watchlist = [
        entity
        for entity in entities
        if entity.get("listed") and "Watchlist" in (entity.get("tags") or [])
    ]

    rows = []
    for entity in watchlist:
        try:
            rows.append(fetch_quote(entity))
        except Exception as exc:  # noqa: BLE001 - keep failed candidates visible.
            rows.append(
                {
                    "entityId": entity.get("id"),
                    "company": entity.get("name"),
                    "stockCode": entity.get("stockCode"),
                    "market": entity.get("market"),
                    "status": "error",
                    "error": str(exc),
                }
            )

    payload = {
        "date": captured_at[:10],
        "capturedAt": captured_at,
        "reviewStatus": "structured_market_candidate",
        "sourcePolicy": "行情为结构化数据；正式入库前仍保留来源链接和抓取时间。",
        "rows": rows,
    }
    write_json(INBOX_DIR / "market_latest.json", payload)
    print(f"Wrote {INBOX_DIR / 'market_latest.json'} with {len(rows)} rows.")

    if promote:
        output, count = promote_stock_snapshots(rows, captured_at)
        print(f"Promoted {count} fetched rows to {output}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
