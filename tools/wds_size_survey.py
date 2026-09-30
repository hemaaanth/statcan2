#!/usr/bin/env python3
"""Measure a reproducible, stratified sample of WDS English ZIP sizes.

This program stores the WDS inventory byte-for-byte and uses only HEAD requests
for table ZIPs. It intentionally does not estimate a total corpus size.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import sys
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

INVENTORY_URL = "https://www150.statcan.gc.ca/t1/wds/rest/getAllCubesList"
ZIP_URL = "https://www150.statcan.gc.ca/n1/tbl/csv/{pid}-eng.zip"
DEFAULT_SAMPLE_SIZE = 220
DEFAULT_EDGE_SIZE = 12
REQUEST_INTERVAL_SECONDS = 0.5
REQUEST_TIMEOUT_SECONDS = 30
MAX_ATTEMPTS = 3


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def stable_rank(seed: str, value: str) -> str:
    return hashlib.sha256(f"{seed}\0{value}".encode("utf-8")).hexdigest()


def json_dump(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")


def parse_content_length(value: str | None) -> int | None:
    """Return a byte count only for an unambiguous non-negative decimal header."""
    if value is None or not value.isascii() or not value.isdecimal():
        return None
    return int(value)


def dimensions_band(count: int) -> str:
    if count <= 2:
        return "1-2"
    if count <= 4:
        return "3-4"
    return "5+"


def pid_string(record: dict[str, Any]) -> str:
    """Return the URL-safe PID while leaving the API's productId value unchanged."""
    raw_pid = record["productId"]
    if isinstance(raw_pid, int) and not isinstance(raw_pid, bool) and raw_pid > 0:
        return str(raw_pid)
    if isinstance(raw_pid, str) and raw_pid.isdecimal() and raw_pid:
        return raw_pid
    raise ValueError(f"productId must be a positive integer or non-empty decimal string, got {raw_pid!r}")


def correction_count(record: dict[str, Any]) -> int:
    if "corrections" not in record:
        raise ValueError(f"PID {pid_string(record)!r}: missing corrections array")
    value = record["corrections"]
    if not isinstance(value, list):
        raise ValueError(f"PID {pid_string(record)!r}: corrections must be an array")
    return len(value)


def validate_inventory(raw: Any) -> list[dict[str, Any]]:
    """Validate only the fields this survey depends on; never coerce API values."""
    if not isinstance(raw, list):
        raise ValueError("getAllCubesList response must be a top-level JSON array")
    seen: set[str] = set()
    records: list[dict[str, Any]] = []
    for index, record in enumerate(raw):
        if not isinstance(record, dict):
            raise ValueError(f"inventory item {index} must be an object")
        for field in ("productId", "archived", "dimensions", "frequencyCode", "corrections"):
            if field not in record:
                raise ValueError(f"inventory item {index} is missing required field {field!r}")
        try:
            pid = pid_string(record)
        except ValueError as exc:
            raise ValueError(f"inventory item {index}: {exc}") from exc
        if pid in seen:
            raise ValueError(f"inventory contains duplicate productId {pid!r}")
        if not isinstance(record["dimensions"], list) or not all(isinstance(item, dict) for item in record["dimensions"]):
            raise ValueError(f"PID {pid}: dimensions must be an array of objects")
        if not isinstance(record["archived"], (str, int)) or isinstance(record["archived"], bool):
            raise ValueError(f"PID {pid}: archived must be a string or integer code")
        if not isinstance(record["frequencyCode"], (str, int)) or isinstance(record["frequencyCode"], bool):
            raise ValueError(f"PID {pid}: frequencyCode must be a string or integer code")
        correction_count(record)
        seen.add(pid)
        records.append(record)
    if not records:
        raise ValueError("inventory array is empty")
    return records


def archive_code(record: dict[str, Any]) -> str:
    """Display an API value without mapping its meaning to current or archived."""
    return str(record["archived"])


def frequency_code(record: dict[str, Any]) -> str:
    return str(record["frequencyCode"])


def title(record: dict[str, Any]) -> str:
    for field in ("cubeTitleEn", "titleEn", "title"):
        value = record.get(field)
        if isinstance(value, str):
            return value
    return ""


def edge_categories(records: list[dict[str, Any]], seed: str, per_category: int = 3) -> dict[str, set[str]]:
    """Return deliberately selected outliers, separately from probability sampling."""
    frequency_counts = Counter(frequency_code(record) for record in records)
    categories: dict[str, list[dict[str, Any]]] = {
        "high_dimension": sorted(records, key=lambda r: (-len(r["dimensions"]), stable_rank(seed, pid_string(r)))),
        "rare_frequency": sorted(
            records,
            key=lambda r: (frequency_counts[frequency_code(r)], stable_rank(seed, pid_string(r))),
        ),
        "census": sorted(
            [r for r in records if pid_string(r).startswith("98") or "census" in title(r).casefold()],
            key=lambda r: stable_rank(seed, pid_string(r)),
        ),
        "correction_record": sorted(
            [r for r in records if correction_count(r) > 0],
            key=lambda r: stable_rank(seed, pid_string(r)),
        ),
    }
    selected: dict[str, set[str]] = {}
    for category, candidates in categories.items():
        for record in candidates[:per_category]:
            selected.setdefault(pid_string(record), set()).add(category)
    return selected


def allocate_strata(groups: dict[str, list[dict[str, Any]]], target: int) -> dict[str, int]:
    if target > sum(len(group) for group in groups.values()):
        raise ValueError("sample target exceeds available records")
    keys = sorted(groups)
    allocation = {key: 0 for key in keys}
    # Give every nonempty stratum one table where the target permits it.
    for key in sorted(keys, key=lambda k: (stable_rank("stratum-order", k), k))[:target]:
        allocation[key] = 1
    remaining = target - sum(allocation.values())
    while remaining:
        capacity = {key: len(groups[key]) - allocation[key] for key in keys}
        eligible = [key for key in keys if capacity[key] > 0]
        if not eligible:
            raise ValueError("stratum allocation exhausted candidates")
        total_capacity = sum(capacity[key] for key in eligible)
        additions = {
            key: min(capacity[key], math.floor(remaining * capacity[key] / total_capacity))
            for key in eligible
        }
        made = sum(additions.values())
        for key, value in additions.items():
            allocation[key] += value
        remaining -= made
        if remaining:
            # Largest remainder, with a stable tie break, assigns the leftovers.
            eligible = [key for key in eligible if len(groups[key]) > allocation[key]]
            remainders = sorted(
                eligible,
                key=lambda key: (
                    -(remaining * capacity[key] / total_capacity - math.floor(remaining * capacity[key] / total_capacity)),
                    stable_rank("allocation-tie", key),
                ),
            )
            for key in remainders[:remaining]:
                allocation[key] += 1
            remaining = 0
    return allocation


def select_sample(records: list[dict[str, Any]], seed: str, sample_size: int, edge_size: int) -> list[dict[str, Any]]:
    if sample_size < edge_size:
        raise ValueError("sample size must be at least the edge-case cohort size")
    if len(records) < sample_size:
        raise ValueError(f"inventory has {len(records)} records, fewer than sample size {sample_size}")

    edge_labels = edge_categories(records, seed)
    edge_ids = list(edge_labels)
    if len(edge_ids) < edge_size:
        existing = set(edge_ids)
        fill = sorted(records, key=lambda r: stable_rank(seed, "edge-fill:" + pid_string(r)))
        for record in fill:
            pid = pid_string(record)
            if pid not in existing:
                edge_ids.append(pid)
                edge_labels[pid] = {"edge_fill"}
                existing.add(pid)
            if len(edge_ids) == edge_size:
                break
    edge_ids = sorted(edge_ids, key=lambda pid: stable_rank(seed, "edge:" + pid))[:edge_size]
    edge_set = set(edge_ids)
    remaining_records = [record for record in records if pid_string(record) not in edge_set]

    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in remaining_records:
        stratum = f"archive={archive_code(record)};dimensions={dimensions_band(len(record['dimensions']))}"
        groups[stratum].append(record)
    allocation = allocate_strata(groups, sample_size - edge_size)

    selected: list[dict[str, Any]] = []
    by_pid = {pid_string(record): record for record in records}
    for pid in edge_ids:
        selected.append({
            "record": by_pid[pid],
            "selection_kind": "nonrandom_edge_case",
            "edge_categories": sorted(edge_labels[pid]),
            "stratum": f"archive={archive_code(by_pid[pid])};dimensions={dimensions_band(len(by_pid[pid]['dimensions']))}",
        })
    for stratum in sorted(groups):
        chosen = sorted(groups[stratum], key=lambda r: stable_rank(seed, "random:" + stratum + ":" + pid_string(r)))[:allocation[stratum]]
        for record in chosen:
            selected.append({
                "record": record,
                "selection_kind": "stratified_random",
                "edge_categories": [],
                "stratum": stratum,
            })
    if len(selected) != sample_size or len({pid_string(entry["record"]) for entry in selected}) != sample_size:
        raise AssertionError("selection did not produce distinct requested sample size")
    return sorted(selected, key=lambda entry: pid_string(entry["record"]))


class PacedRequester:
    def __init__(self, interval: float) -> None:
        self.interval = interval
        self.next_allowed = 0.0

    def head(self, url: str) -> tuple[int | None, dict[str, str], str | None, int]:
        last_error: str | None = None
        for attempt in range(1, MAX_ATTEMPTS + 1):
            wait = self.next_allowed - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self.next_allowed = time.monotonic() + self.interval
            request = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "statcan-wds-size-survey/1.0"})
            try:
                with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
                    return response.status, dict(response.headers.items()), None, attempt
            except urllib.error.HTTPError as exc:
                # Do not read the response body: table ZIP contents are never downloaded.
                status = exc.code
                headers = dict(exc.headers.items()) if exc.headers else {}
                if status in (408, 429) or 500 <= status <= 599:
                    last_error = f"HTTP {status}"
                    if attempt < MAX_ATTEMPTS:
                        continue
                return status, headers, last_error or f"HTTP {status}", attempt
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                if attempt < MAX_ATTEMPTS:
                    continue
                return None, {}, last_error, attempt
        raise AssertionError("unreachable")


def summary_text(run: dict[str, Any]) -> str:
    results = run["results"]
    known = sorted(result["zip_bytes"] for result in results if result["zip_bytes"] is not None)
    status_counts = Counter(str(result["http_status"]) for result in results)
    archive_counts = Counter(result["archived_code_raw"] for result in results)
    stratum_counts = Counter(result["stratum"] for result in results)
    kind_counts = Counter(result["selection_kind"] for result in results)
    errors = [result for result in results if result["error"]]
    lines = [
        "# WDS English ZIP HEAD size survey",
        "",
        f"- Run: `{run['run_id']}`",
        f"- Inventory retrieved: {run['inventory']['retrieved_at_utc']}",
        f"- Inventory SHA-256: `{run['inventory']['sha256']}`",
        f"- Inventory records: {run['inventory']['record_count']}",
        f"- Selected: {len(results)} ({kind_counts['stratified_random']} stratified-random; {kind_counts['nonrandom_edge_case']} deliberately selected edge cases)",
        f"- HEAD results with an unambiguous `Content-Length`: {len(known)}; unknown/error: {len(results) - len(known)}",
        "- This is a measured sample. It deliberately does **not** estimate full-corpus storage.",
        "- `archived` is reported below as the raw API code; this survey does not map code meanings to current/archived status.",
        "",
        "## Known ZIP-byte distribution",
        "",
    ]
    if known:
        def percentile(p: float) -> int:
            return known[math.ceil(p * len(known)) - 1]
        lines.extend([
            f"- Minimum: {known[0]:,}",
            f"- p25: {percentile(.25):,}",
            f"- Median: {percentile(.50):,}",
            f"- p75: {percentile(.75):,}",
            f"- Maximum: {known[-1]:,}",
            f"- Sum of known sampled ZIPs only: {sum(known):,}",
        ])
    else:
        lines.append("No successful unambiguous Content-Length values were returned.")
    lines.extend(["", "## Coverage", "", "### Raw archive-status codes", ""])
    lines.extend(f"- `{code}`: {count}" for code, count in sorted(archive_counts.items()))
    lines.extend(["", "### Selected strata", ""])
    lines.extend(f"- `{stratum}`: {count}" for stratum, count in sorted(stratum_counts.items()))
    lines.extend(["", "### HTTP statuses", ""])
    lines.extend(f"- `{code}`: {count}" for code, count in sorted(status_counts.items()))
    lines.extend(["", "## Edge-case cohort", ""])
    for result in results:
        if result["selection_kind"] == "nonrandom_edge_case":
            lines.append(f"- `{result['pid']}`: {', '.join(result['edge_categories'])}")
    if errors:
        lines.extend(["", "## Errors or unknown sizes", ""])
        for result in errors:
            lines.append(f"- `{result['pid']}`: {result['error']}")
    lines.extend([
        "",
        "## Limits",
        "",
        "- Measurements use HEAD only. A missing or malformed Content-Length is recorded as unknown, not inferred.",
        "- The raw inventory is a dated snapshot. ZIP sizes can change after this run.",
        "- The 12 edge cases are nonrandom and must not be used as probability-sample observations.",
        "- No ZIP payloads were downloaded by this program.",
        "",
    ])
    return "\n".join(lines)


def fetch_inventory(output_dir: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    retrieved_at = utc_now()
    request = urllib.request.Request(INVENTORY_URL, headers={"User-Agent": "statcan-wds-size-survey/1.0"})
    with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
        if response.status != 200:
            raise RuntimeError(f"inventory request returned HTTP {response.status}")
        raw_bytes = response.read()
    raw_path = output_dir / "inventory.json"
    raw_path.write_bytes(raw_bytes)
    sha256 = hashlib.sha256(raw_bytes).hexdigest()
    (output_dir / "inventory.json.sha256").write_text(f"{sha256}  inventory.json\n", encoding="utf-8")
    try:
        decoded = json.loads(raw_bytes)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"inventory bytes are not valid JSON: {exc}") from exc
    records = validate_inventory(decoded)
    return records, {
        "url": INVENTORY_URL,
        "retrieved_at_utc": retrieved_at,
        "raw_path": raw_path.name,
        "sha256_path": "inventory.json.sha256",
        "sha256": sha256,
        "byte_count": len(raw_bytes),
        "record_count": len(records),
    }


def run(args: argparse.Namespace) -> int:
    output_root = Path(args.output_root)
    run_id = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output_dir = output_root / run_id
    output_dir.mkdir(parents=True, exist_ok=False)
    records, inventory = fetch_inventory(output_dir)
    selected = select_sample(records, args.seed, args.sample_size, args.edge_size)
    requester = PacedRequester(REQUEST_INTERVAL_SECONDS)
    results: list[dict[str, Any]] = []
    transient_failures = 0
    transient_error_count = 0
    for index, entry in enumerate(selected, start=1):
        record = entry["record"]
        pid = pid_string(record)
        url = ZIP_URL.format(pid=pid)
        measured_at = utc_now()
        status, headers, error, attempts = requester.head(url)
        content_length_header = headers.get("Content-Length")
        zip_bytes = parse_content_length(content_length_header) if status and 200 <= status < 300 else None
        result = {
            "pid": pid,
            "pid_raw": record["productId"],
            "url": url,
            "measured_at_utc": measured_at,
            "http_status": status,
            "attempts": attempts,
            "content_length_header": content_length_header,
            "zip_bytes": zip_bytes,
            "error": error,
            "selection_kind": entry["selection_kind"],
            "edge_categories": entry["edge_categories"],
            "stratum": entry["stratum"],
            "archived_code_raw": record["archived"],
            "dimension_count": len(record["dimensions"]),
            "dimensions_band": dimensions_band(len(record["dimensions"])),
            "frequency_code_raw": record.get("frequencyCode"),
            "correction_count": correction_count(record),
        }
        results.append(result)
        transient_error = bool(error and (status is None or status == 408 or status == 429 or (status is not None and status >= 500)))
        if transient_error:
            transient_failures += 1
            transient_error_count += 1
        else:
            transient_failures = 0
        print(f"[{index}/{len(selected)}] {pid} status={status} bytes={zip_bytes if zip_bytes is not None else 'unknown'}", flush=True)
        # Stop before increasing WDS load when either sustained or broad degradation is observed.
        if transient_failures >= 10 or (index >= 30 and transient_error_count / index >= 0.25):
            print("Stopping because transient upstream failures indicate degradation.", file=sys.stderr)
            break

    run_data = {
        "run_id": run_id,
        "program": "tools/wds_size_survey.py",
        "seed": args.seed,
        "parameters": {
            "sample_size_requested": args.sample_size,
            "edge_case_count_requested": args.edge_size,
            "request_interval_seconds": REQUEST_INTERVAL_SECONDS,
            "request_timeout_seconds": REQUEST_TIMEOUT_SECONDS,
            "max_attempts": MAX_ATTEMPTS,
        },
        "inventory": inventory,
        "results": results,
    }
    json_dump(output_dir / "results.json", run_data)
    (output_dir / "summary.md").write_text(summary_text(run_data), encoding="utf-8")
    json_dump(output_dir / "manifest.json", {
        "run_id": run_id,
        "created_at_utc": utc_now(),
        "files": ["inventory.json", "inventory.json.sha256", "results.json", "summary.md"],
        "inventory_sha256": inventory["sha256"],
        "result_count": len(results),
        "completed_requested_sample": len(results) == args.sample_size,
    })
    print(f"Wrote {output_dir}")
    return 0 if len(results) == args.sample_size else 2


def self_check() -> int:
    assert parse_content_length("0") == 0
    assert parse_content_length("12345") == 12345
    assert parse_content_length(None) is None
    assert parse_content_length("12,345") is None
    assert parse_content_length(" 12") is None
    assert parse_content_length("１２３") is None
    assert parse_content_length("-1") is None
    records = []
    for index in range(80):
        pid = 98000000 + index if index in (5, 6, 7, 8) else 12000000 + index
        records.append({
            "productId": pid,
            "archived": "1" if index % 2 else "2",
            "dimensions": [{}] * (index % 6 + 1),
            "frequencyCode": str(index % 7),
            "cubeTitleEn": "Census test" if index == 9 else "Test",
            "corrections": [{}] if index % 11 == 0 else [],
        })
    checked = validate_inventory(records)
    first = select_sample(checked, "self-check", 30, 8)
    second = select_sample(checked, "self-check", 30, 8)
    assert [pid_string(entry["record"]) for entry in first] == [pid_string(entry["record"]) for entry in second]
    assert len(first) == 30
    assert sum(entry["selection_kind"] == "nonrandom_edge_case" for entry in first) == 8
    assert all(entry["stratum"].startswith("archive=") for entry in first)
    print("self-check passed")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-root", default="data/local/wds-size-survey", help="ignored local output directory")
    parser.add_argument("--sample-size", type=int, default=DEFAULT_SAMPLE_SIZE)
    parser.add_argument("--edge-size", type=int, default=DEFAULT_EDGE_SIZE)
    parser.add_argument("--seed", default="wds-size-survey-v1")
    parser.add_argument("--self-check", action="store_true", help="run deterministic parsing and sampling checks without network access")
    args = parser.parse_args()
    if args.self_check:
        return self_check()
    if args.sample_size <= 0 or args.edge_size < 0:
        parser.error("sample size must be positive and edge size must not be negative")
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
