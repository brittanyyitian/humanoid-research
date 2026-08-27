#!/usr/bin/env python3
"""Light quote and daily-kline access for benchmarks and claim resolution.

This module is intentionally small and provider-thin. It serves two callers:
`build_market_snapshot.py` (benchmark indices for market regime) and
`resolve_due_claims.py --fetch` (current prices for machine-checkable claims).
Issuer research fetches stay on the full audited path in data_layer/data_router;
this module never replaces that path and records no rating semantics.

Tencent endpoints are preferred because they resolve index aliases directly
(sh000300, sz399006, hkHSI) and are reachable from mainland environments.
Yahoo chart is used for US index symbols when the endpoint is reachable.
"""

from __future__ import annotations

import datetime as dt
import json
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Mapping, Optional, Sequence

TENCENT_QUOTE_URL: str = "https://qt.gtimg.cn/q="
TENCENT_KLINE_URL: str = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
YAHOO_CHART_URL: str = "https://query1.finance.yahoo.com/v8/finance/chart/"
USER_AGENT: str = "Mozilla/5.0"

# Benchmark registry for market-regime snapshots. Keys are stable identifiers;
# aliases are provider-native codes. Extend here, not in call sites.
BENCHMARKS: dict[str, dict[str, str]] = {
    "csi300": {"provider": "tencent", "alias": "sh000300", "market": "CN_A", "name": "沪深300"},
    "csi500": {"provider": "tencent", "alias": "sh000905", "market": "CN_A", "name": "中证500"},
    "chinext": {"provider": "tencent", "alias": "sz399006", "market": "CN_A", "name": "创业板指"},
    "star50": {"provider": "tencent", "alias": "sh000688", "market": "CN_A", "name": "科创50"},
    "hsi": {"provider": "tencent", "alias": "hkHSI", "market": "HK", "name": "恒生指数"},
    "spx": {"provider": "yahoo", "alias": "^GSPC", "market": "US", "name": "S&P 500"},
    "ndx": {"provider": "yahoo", "alias": "^NDX", "market": "US", "name": "Nasdaq 100"},
}
DEFAULT_BENCHMARK_KEYS: tuple[str, ...] = ("csi300", "csi500", "chinext", "hsi")


def _read_url(url: str, *, headers: Optional[Mapping[str, str]] = None, retries: int = 2, timeout: int = 20) -> bytes:
    try:
        import certifi  # type: ignore

        context: Any = ssl.create_default_context(cafile=certifi.where())
    except Exception:
        context = ssl.create_default_context()
    request_headers: dict[str, str] = {"User-Agent": USER_AGENT, "Accept": "*/*"}
    if headers:
        request_headers.update(headers)
    last_error: Optional[BaseException] = None
    for attempt in range(retries + 1):
        request: urllib.request.Request = urllib.request.Request(url, headers=request_headers)
        try:
            with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
                return response.read()
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ConnectionResetError) as exc:
            last_error = exc
            if attempt >= retries:
                raise
            time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(str(last_error) if last_error else f"failed to read {url}")


def tencent_quote(alias: str) -> dict[str, Any]:
    """Return name/current price for a Tencent quote alias (stock or index)."""
    raw: str = _read_url(
        f"{TENCENT_QUOTE_URL}{alias}", headers={"Referer": "https://gu.qq.com/"}
    ).decode("gbk", errors="replace")
    marker: str = f'v_{alias}="'
    start: int = raw.find(marker)
    if start < 0:
        raise ValueError(f"tencent quote alias not found in response: {alias}")
    body: str = raw[start + len(marker):]
    body = body[: body.find('"')]
    fields: list[str] = body.split("~")
    if len(fields) < 6 or not fields[3]:
        raise ValueError(f"tencent quote fields incomplete for {alias}")
    return {
        "alias": alias,
        "name": fields[1],
        "current_price": float(fields[3]),
        "prev_close": float(fields[4]) if fields[4] else None,
        "as_of": dt.datetime.now(dt.timezone.utc).isoformat(),
        "source": "Tencent_Quote_L2",
    }


def tencent_daily_kline(alias: str, *, count: int = 280) -> list[dict[str, Any]]:
    """Return daily OHLCV rows for a Tencent kline alias (qfq for stocks, raw for indices)."""
    url: str = f"{TENCENT_KLINE_URL}?param={alias},day,,,{count},qfq"
    payload: Any = json.loads(_read_url(url, headers={"Referer": "https://gu.qq.com/"}).decode("utf-8", errors="replace"))
    data: Mapping[str, Any] = payload.get("data", {}).get(alias, {}) if isinstance(payload, Mapping) else {}
    rows_raw: Any = None
    for key in ("qfqday", "day"):
        if isinstance(data.get(key), list) and data.get(key):
            rows_raw = data[key]
            break
    if not rows_raw:
        raise ValueError(f"tencent kline returned no daily rows for {alias}")
    rows: list[dict[str, Any]] = []
    for item in rows_raw:
        if not isinstance(item, list) or len(item) < 6:
            continue
        rows.append(
            {
                "date": str(item[0]),
                "open": float(item[1]),
                "close": float(item[2]),
                "high": float(item[3]),
                "low": float(item[4]),
                "volume": float(item[5]),
            }
        )
    if not rows:
        raise ValueError(f"tencent kline rows unparsable for {alias}")
    return rows


def yahoo_daily_chart(symbol: str, *, chart_range: str = "1y") -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Return (quote, daily rows) from the Yahoo chart API."""
    url: str = f"{YAHOO_CHART_URL}{urllib.parse.quote(symbol)}?range={chart_range}&interval=1d"
    payload: Any = json.loads(_read_url(url).decode("utf-8", errors="replace"))
    result: Mapping[str, Any] = {}
    try:
        result = payload["chart"]["result"][0]
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError(f"yahoo chart returned no result for {symbol}") from exc
    meta: Mapping[str, Any] = result.get("meta", {}) if isinstance(result.get("meta"), Mapping) else {}
    timestamps: Sequence[Any] = result.get("timestamp") or []
    indicators: Mapping[str, Any] = result.get("indicators", {}) if isinstance(result.get("indicators"), Mapping) else {}
    quote_block: Mapping[str, Any] = {}
    quote_items: Any = indicators.get("quote")
    if isinstance(quote_items, list) and quote_items and isinstance(quote_items[0], Mapping):
        quote_block = quote_items[0]
    rows: list[dict[str, Any]] = []
    for index, stamp in enumerate(timestamps):
        try:
            close: Any = quote_block.get("close", [])[index]
            high: Any = quote_block.get("high", [])[index]
            low: Any = quote_block.get("low", [])[index]
            open_: Any = quote_block.get("open", [])[index]
            volume: Any = quote_block.get("volume", [])[index]
        except (IndexError, TypeError):
            continue
        if close is None or high is None or low is None:
            continue
        rows.append(
            {
                "date": dt.datetime.fromtimestamp(int(stamp), tz=dt.timezone.utc).date().isoformat(),
                "open": float(open_) if open_ is not None else float(close),
                "close": float(close),
                "high": float(high),
                "low": float(low),
                "volume": float(volume) if volume is not None else 0.0,
            }
        )
    if not rows:
        raise ValueError(f"yahoo chart rows unparsable for {symbol}")
    quote: dict[str, Any] = {
        "alias": symbol,
        "name": str(meta.get("shortName") or meta.get("symbol") or symbol),
        "current_price": float(meta.get("regularMarketPrice")) if meta.get("regularMarketPrice") is not None else rows[-1]["close"],
        "prev_close": float(meta.get("chartPreviousClose")) if meta.get("chartPreviousClose") is not None else None,
        "as_of": dt.datetime.now(dt.timezone.utc).isoformat(),
        "source": "Yahoo_Chart_L2",
    }
    return quote, rows


def quote_route_for_symbol(symbol: str) -> Optional[tuple[str, str]]:
    """Map a canonical research symbol onto a light quote route.

    Returns (provider, alias) or None when no light route exists. BJ symbols
    stay on the full data_router path because their alias rules are special.
    """
    text: str = (symbol or "").strip().upper()
    if not text:
        return None
    if text.endswith(".SH"):
        return "tencent", f"sh{text[:-3]}"
    if text.endswith(".SZ"):
        return "tencent", f"sz{text[:-3]}"
    if text.endswith(".HK"):
        code: str = text[:-3]
        if code.isdigit():
            return "tencent", f"hk{code.zfill(5)}"
        return None
    if text.endswith(".BJ"):
        return None
    if text.replace(".", "").replace("-", "").isalnum() and not text[:1].isdigit():
        return "yahoo", text
    return None


def fetch_current_price(symbol: str) -> dict[str, Any]:
    """Fetch one current price through the light route; raises when unsupported."""
    route: Optional[tuple[str, str]] = quote_route_for_symbol(symbol)
    if route is None:
        raise ValueError(f"no light quote route for symbol: {symbol}")
    provider, alias = route
    if provider == "tencent":
        quote: dict[str, Any] = tencent_quote(alias)
    else:
        quote, _ = yahoo_daily_chart(alias, chart_range="5d")
    quote["symbol"] = symbol
    return quote


def fetch_benchmark(key: str, *, chart_range_days: int = 280) -> dict[str, Any]:
    """Fetch one registry benchmark as a market-snapshot row."""
    record: Optional[Mapping[str, str]] = BENCHMARKS.get(key)
    if record is None:
        raise ValueError(f"unknown benchmark key: {key}; known: {', '.join(sorted(BENCHMARKS))}")
    provider: str = record["provider"]
    alias: str = record["alias"]
    if provider == "tencent":
        quote = tencent_quote(alias)
        rows = tencent_daily_kline(alias, count=chart_range_days)
    else:
        quote, rows = yahoo_daily_chart(alias, chart_range="1y")
    return {
        "key": key,
        "symbol": alias,
        "name": record.get("name") or quote.get("name") or key,
        "market": record.get("market", ""),
        "quote": quote,
        "price_history": rows,
    }


def fetch_daily_rows(symbol: str, *, days: int = 260) -> list[dict[str, Any]]:
    """Daily OHLCV rows for one canonical symbol through the light route."""
    route: Optional[tuple[str, str]] = quote_route_for_symbol(symbol)
    if route is None:
        raise ValueError(f"no light kline route for symbol: {symbol}")
    provider, alias = route
    if provider == "tencent":
        return tencent_daily_kline(alias, count=days)
    _, rows = yahoo_daily_chart(alias, chart_range="1y")
    return rows[-days:]
