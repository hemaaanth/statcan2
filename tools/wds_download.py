#!/usr/bin/env python3
"""Capture WDS full-table CSV ZIPs on a specified, UUID-checked mounted drive.

Default: the saved inventory and English only. Use --fetch-inventory to obtain a
new snapshot directly on the destination drive. Re-run the same command to resume.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import http.client
import json
import os
import re
import shutil
import signal
import stat
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

INVENTORY_URL = "https://www150.statcan.gc.ca/t1/wds/rest/getAllCubesList"
API_URL = "https://www150.statcan.gc.ca/t1/wds/rest/getFullTableDownloadCSV/{pid}/{language}"
SAVED_INVENTORY = Path(__file__).resolve().parent.parent / "data/local/wds-size-survey/20260930T015419Z/inventory.json"
CHUNK = 1024 * 1024
RESERVE = 100 * 1024**3


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class StorageStop(Exception):
    pass


class UpstreamStop(Exception):
    pass


class DownloadError(Exception):
    pass


class StopRequested(Exception):
    pass


class Drive:
    def __init__(self, destination, uuid, reserve=RESERVE):
        self.destination = Path(destination).absolute()
        if not re.fullmatch(r"[0-9A-Fa-f-]{4,64}", uuid):
            raise StorageStop("invalid filesystem UUID")
        self.uuid = uuid
        self.reserve = reserve
        self.check()

    def check(self, bytes_to_write=0):
        # Compare the mounted filesystem's device ID with the requested UUID's
        # block device. If unplugged, the underlying OS directory cannot pass.
        device = Path("/dev/disk/by-uuid") / self.uuid
        try:
            info = device.stat()
            if not stat.S_ISBLK(info.st_mode):
                raise StorageStop(f"UUID {self.uuid} is not a block device")
            root = self.destination
            while not os.path.ismount(root) and root != root.parent:
                root = root.parent
            existing = self.destination.resolve()
            while not existing.exists() and existing != existing.parent:
                existing = existing.parent
            if root.stat().st_dev != info.st_rdev or existing.stat().st_dev != info.st_rdev:
                raise StorageStop(f"destination is not mounted UUID {self.uuid}")
            free = shutil.disk_usage(root).free
        except OSError as exc:
            raise StorageStop(f"cannot verify mounted UUID {self.uuid}: {exc}") from exc
        if free < self.reserve + bytes_to_write:
            raise StorageStop(f"free space {free:,} B is below reserve {self.reserve:,} B plus next write {bytes_to_write:,} B")
        return free

    def mkdir(self, path):
        self.check(CHUNK)
        path.mkdir(parents=True, exist_ok=True)

    def write(self, stream, data):
        self.check(len(data) + CHUNK)
        stream.write(data)

    def atomic_json(self, path, value):
        data = (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()
        self.check(len(data) + CHUNK)
        fd, name = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
        tmp = Path(name)
        try:
            with os.fdopen(fd, "wb") as stream:
                self.write(stream, data)
                stream.flush()
                os.fsync(stream.fileno())
            self.check()
            os.replace(tmp, path)
        finally:
            if tmp.exists():
                self.check()
                tmp.unlink()  # Only this call's private, incomplete metadata file.


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


class Client:
    def __init__(self):
        self.opener = urllib.request.build_opener(NoRedirect)
        self.next_request = 0.0
        self.should_stop = lambda: False

    def open(self, url, headers=None):
        for _ in range(5):
            if self.should_stop():
                raise StopRequested()
            parsed = urllib.parse.urlsplit(url)
            if parsed.scheme != "https" or parsed.netloc != "www150.statcan.gc.ca":
                raise DownloadError(f"untrusted WDS URL: {url}")
            pause = self.next_request - time.monotonic()
            if pause > 0:
                time.sleep(pause)
            if self.should_stop():
                raise StopRequested()
            self.next_request = time.monotonic() + 0.5
            request = urllib.request.Request(url, headers={"User-Agent": "statcan-wds-download/1.0", **(headers or {}), "Accept-Encoding": "identity"})
            try:
                return self.opener.open(request, timeout=60)
            except urllib.error.HTTPError as exc:
                if exc.code in (301, 302, 303, 307, 308):
                    location = exc.headers.get("Location")
                    exc.close()
                    if not location:
                        raise DownloadError(f"redirect without Location: {url}")
                    url = urllib.parse.urljoin(url, location)
                    continue
                raise
        raise DownloadError("too many redirects")


def retryable(exc):
    return not isinstance(exc, urllib.error.HTTPError) or exc.code in (408, 409, 429, 500, 502, 503, 504)


def api_json(client, url):
    for attempt in range(3):
        try:
            with client.open(url) as response:
                if response.status != 200:
                    raise DownloadError(f"API returned HTTP {response.status}")
                raw = response.read(32 * 1024 * 1024 + 1)
                if len(raw) > 32 * 1024 * 1024:
                    raise DownloadError("API response exceeds 32 MiB")
                return raw
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError, http.client.IncompleteRead) as exc:
            if attempt == 2 or not retryable(exc):
                if isinstance(exc, urllib.error.HTTPError) and exc.code == 503:
                    raise UpstreamStop(f"WDS API unavailable: {exc}") from exc
                raise DownloadError(str(exc)) from exc
            time.sleep(2**attempt)
    raise AssertionError("unreachable")


def inventory(drive, client, source, fetch):
    dest = drive.destination / "inventory.json"
    if dest.exists():
        raw = dest.read_bytes()
        record = drive.destination / "inventory-source.json"
        if record.exists() and json.loads(record.read_text()).get("sha256") != hashlib.sha256(raw).hexdigest():
            raise DownloadError("SSD inventory checksum mismatch")
        if not record.exists():
            drive.atomic_json(record, {"source": "existing SSD snapshot (original provenance unavailable)",
                "captured_at_utc": utc_now(), "sha256": hashlib.sha256(raw).hexdigest(),
                "bytes": len(raw), "records": len(parse_inventory(raw))})
    else:
        if fetch:
            raw = api_json(client, INVENTORY_URL)
        else:
            raw = source.read_bytes()
            digest_file = source.with_name(source.name + ".sha256")
            if digest_file.exists() and digest_file.read_text().split()[0] != hashlib.sha256(raw).hexdigest():
                raise DownloadError("saved inventory checksum mismatch")
        records = parse_inventory(raw)
        drive.check(len(raw) + CHUNK)
        fd, name = tempfile.mkstemp(prefix="inventory.", dir=drive.destination)
        tmp = Path(name)
        try:
            with os.fdopen(fd, "wb") as stream:
                drive.write(stream, raw)
                stream.flush()
                os.fsync(stream.fileno())
            drive.check(CHUNK)
            tmp.rename(dest)
        finally:
            if tmp.exists():
                drive.check()
                tmp.unlink()
        drive.atomic_json(drive.destination / "inventory-source.json", {
            "source": INVENTORY_URL if fetch else str(source), "captured_at_utc": utc_now(),
            "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw), "records": len(records),
        })
        return records
    return parse_inventory(raw)


def parse_inventory(raw):
    data = json.loads(raw)
    if not isinstance(data, list) or not data:
        raise DownloadError("inventory must be a nonempty array")
    ids = []
    for record in data:
        if not isinstance(record, dict) or type(record.get("productId")) is not int or record["productId"] <= 0:
            raise DownloadError("inventory contains an invalid numeric productId")
        ids.append(str(record["productId"]))
    if len(ids) != len(set(ids)):
        raise DownloadError("inventory contains duplicate productIds")
    return data


def zip_url(client, pid, language):
    endpoint = API_URL.format(pid=pid, language=language)
    answer = json.loads(api_json(client, endpoint))
    if not isinstance(answer, dict) or answer.get("status") != "SUCCESS" or not isinstance(answer.get("object"), str):
        raise DownloadError(f"WDS full-table API did not provide a ZIP: {str(answer)[:300]}")
    url = answer["object"]
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != "https" or parsed.netloc != "www150.statcan.gc.ca"
            or not parsed.path.lower().endswith(".zip") or parsed.fragment):
        raise DownloadError(f"unexpected WDS ZIP URL for {pid}/{language}: {url}")
    return url


def number(value):
    return int(value) if value is not None and re.fullmatch(r"[0-9]+", value) else None


def verified(path, manifest):
    meta = json.loads(manifest.read_text())
    if meta.get("bytes") != path.stat().st_size:
        raise DownloadError(f"saved ZIP size mismatch: {path}")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(CHUNK), b""):
            digest.update(chunk)
    if digest.hexdigest() != meta.get("sha256"):
        raise DownloadError(f"saved ZIP checksum mismatch: {path}")


def transfer(drive, client, pid, language, url, output, manifest, should_stop=lambda: False):
    part = output.with_suffix(".zip.part")
    state_path = output.with_suffix(".zip.part.json")
    if output.exists() and not manifest.exists() and state_path.exists():
        state = json.loads(state_path.read_text())
        if state.get("pid") == pid and state.get("language") == language and state.get("sha256"):
            verified(output, state_path)
            drive.check(CHUNK)
            state_path.rename(manifest)
    if output.exists() or manifest.exists():
        if not output.exists() or not manifest.exists():
            raise DownloadError(f"ZIP/manifest pair incomplete: {output}")
        verified(output, manifest)
        return "skipped", 0
    if state_path.exists() != part.exists():
        raise DownloadError(f"partial ZIP/state pair incomplete: {part}")
    state = json.loads(state_path.read_text()) if part.exists() else None
    if state and state.get("sha256"):
        if state.get("pid") != pid or state.get("language") != language:
            raise DownloadError(f"completed partial belongs to a different PID: {part}")
        verified(part, state_path)
        drive.check(CHUNK)
        part.rename(output)
        drive.check(CHUNK)
        state_path.rename(manifest)
        return "downloaded", state["bytes"]
    if state and (state.get("url") != url or state.get("pid") != pid or state.get("language") != language):
        raise DownloadError(f"partial ZIP belongs to a different source: {part}")
    for attempt in range(3):
        if should_stop():
            raise StopRequested()
        size = part.stat().st_size if part.exists() else 0
        validator = state.get("etag") or state.get("last_modified") if state else None
        headers = ({"Range": f"bytes={size}-", "If-Range": validator}
                   if size and validator and (state.get("total") is None or size < state["total"]) else {})
        try:
            with client.open(url, headers) as response:
                if response.status not in (200, 206):
                    raise DownloadError(f"ZIP returned HTTP {response.status}")
                encoding = response.headers.get("Content-Encoding", "identity")
                if encoding.strip().lower() != "identity":
                    raise DownloadError(f"ZIP has unexpected Content-Encoding {encoding!r}: {pid}/{language}")
                length = number(response.headers.get("Content-Length"))
                if length is None:
                    raise DownloadError(f"ZIP has no valid Content-Length: {pid}/{language}")
                if response.status == 206:
                    match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", ""))
                    if (not headers or not match or int(match[1]) != size or int(match[2]) < size
                            or int(match[3]) != int(match[2]) + 1 or length != int(match[3]) - size
                            or (state.get("total") is not None and state["total"] != int(match[3]))
                            or (state.get("etag") and response.headers.get("ETag") != state["etag"])
                            or (state.get("last_modified") and response.headers.get("Last-Modified") != state["last_modified"])):
                        raise DownloadError(f"invalid resume response for {pid}/{language}")
                    total = int(match[3])
                    mode = "ab"
                else:
                    total = length
                    mode = "wb"  # 200 to a Range request means the server ignored it or the file changed.
                    size = 0
                if total is not None:
                    drive.check(max(0, total - size) + CHUNK)
                if mode == "wb":
                    state = {"pid": pid, "language": language, "url": url, "started_at_utc": utc_now(),
                             "etag": response.headers.get("ETag"), "last_modified": response.headers.get("Last-Modified"),
                             "total": total}
                    drive.atomic_json(state_path, state)
                drive.check(CHUNK)
                with part.open(mode) as stream:
                    while True:
                        if should_stop():
                            raise StopRequested()
                        chunk = response.read(CHUNK)
                        if not chunk:
                            break
                        drive.write(stream, chunk)
                        size += len(chunk)
                        if total is not None and size > total:
                            raise DownloadError(f"ZIP exceeds Content-Length: {pid}/{language}")
                    stream.flush()
                    os.fsync(stream.fileno())
                if total is not None and size != total:
                    raise DownloadError(f"ZIP ended early: {pid}/{language} ({size}/{total})")
                if not zipfile.is_zipfile(part):
                    raise DownloadError(f"not a complete ZIP: {pid}/{language}")
                with part.open("rb") as stream:
                    digest = hashlib.sha256()
                    stream.seek(0)
                    for chunk in iter(lambda: stream.read(CHUNK), b""):
                        digest.update(chunk)
                metadata = {"pid": pid, "language": language, "source_url": url,
                            "started_at_utc": state["started_at_utc"], "completed_at_utc": utc_now(),
                            "bytes": size, "sha256": digest.hexdigest(), "http_status": response.status,
                            "content_length": length, "content_range": response.headers.get("Content-Range"),
                            "source_total_bytes": total, "etag": response.headers.get("ETag"),
                            "last_modified": response.headers.get("Last-Modified"),
                            "content_type": response.headers.get("Content-Type")}
                drive.atomic_json(state_path, metadata)
                drive.check(CHUNK)
                if output.exists():
                    raise DownloadError(f"completed ZIP appeared during transfer: {output}")
                part.rename(output)
                drive.check(CHUNK)
                state_path.rename(manifest)
                return "downloaded", size
        except StorageStop:
            raise
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError, http.client.IncompleteRead, DownloadError) as exc:
            if attempt == 2 or (isinstance(exc, urllib.error.HTTPError) and not retryable(exc)) or isinstance(exc, DownloadError):
                if isinstance(exc, urllib.error.HTTPError) and exc.code == 503:
                    raise UpstreamStop(f"WDS ZIP unavailable: {exc}") from exc
                raise DownloadError(str(exc)) from exc
            time.sleep(2**attempt)
    raise AssertionError("unreachable")


def run(args):
    drive = Drive(args.destination / args.capture_id, args.mount_uuid, int(args.reserve_gib * 1024**3))
    client = Client()
    if args.check:
        path = drive.destination / "inventory.json"
        source = path if path.exists() else args.inventory
        records = parse_inventory(source.read_bytes()) if source.exists() else []
        print(f"UUID {args.mount_uuid} mounted; free={drive.check():,} B; inventory={len(records)} PIDs; no writes")
        return 0
    drive.mkdir(drive.destination)
    drive.mkdir(drive.destination / "zips")
    drive.mkdir(drive.destination / "manifests")
    lock_path = drive.destination / ".lock"
    drive.check(CHUNK)
    with lock_path.open("a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        records = inventory(drive, client, args.inventory, args.fetch_inventory)
        chosen = records[:args.limit] if args.limit is not None else records
        if args.pids:
            requested = args.pids.split(",")
            if any(not pid.isascii() or not pid.isdecimal() for pid in requested) or len(set(requested)) != len(requested):
                raise DownloadError("--pids must be distinct decimal PIDs separated by commas")
            by_pid = {str(r["productId"]): r for r in records}
            if set(requested) - by_pid.keys():
                raise DownloadError(f"PIDs not in inventory: {sorted(set(requested) - by_pid.keys())}")
            chosen = [by_pid[pid] for pid in requested]
        jobs = [(str(r["productId"]), lang) for r in chosen for lang in args.languages]
        if args.dry_run:
            print(f"{len(records)} inventory PIDs; {len(jobs)} jobs; no ZIP requests")
            return 0
        stopped = False
        def on_signal(signum, frame):
            nonlocal stopped
            stopped = True
        signal.signal(signal.SIGINT, on_signal)
        signal.signal(signal.SIGTERM, on_signal)
        client.should_stop = lambda: stopped
        counts = {"downloaded": 0, "skipped": 0, "failed": 0}
        for index, (pid, language) in enumerate(jobs, 1):
            if stopped:
                break
            output = drive.destination / "zips" / f"{pid}-{language}.zip"
            manifest = drive.destination / "manifests" / f"{pid}-{language}.json"
            try:
                state_file = output.with_suffix(".zip.part.json")
                completed_partial = (not output.exists() and not manifest.exists() and state_file.exists()
                                     and "sha256" in json.loads(state_file.read_text()))
                if output.exists() or manifest.exists() or completed_partial:
                    result, size = transfer(drive, client, pid, language, "", output, manifest, lambda: stopped)
                else:
                    url = zip_url(client, pid, language)
                    result, size = transfer(drive, client, pid, language, url, output, manifest, lambda: stopped)
            except StopRequested:
                stopped = True
                break
            except (StorageStop, UpstreamStop) as exc:
                print(f"STOP [{index}/{len(jobs)}] {pid}/{language}: {exc}", file=sys.stderr, flush=True)
                return 3
            except (DownloadError, ValueError, OSError, urllib.error.URLError) as exc:
                result, size = "failed", 0
                message = f"[{index}/{len(jobs)}] {pid}/{language} failed: {exc}"
                print(message, file=sys.stderr, flush=True)
                log = drive.destination / "failures.jsonl"
                drive.check(CHUNK)
                with log.open("ab") as stream:
                    drive.write(stream, (json.dumps({"pid": pid, "language": language,
                        "at_utc": utc_now(), "error": str(exc)}) + "\n").encode())
            counts[result] += 1
            print(f"[{index}/{len(jobs)}] {pid}/{language} {result} {size:,} B", flush=True)
        print(f"Summary: {counts}; stopped={stopped}; jobs={len(jobs)}", flush=True)
        return 130 if stopped else (2 if counts["failed"] else 0)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", required=True, type=Path, help="directory on the mounted SSD")
    parser.add_argument("--mount-uuid", required=True, help="required filesystem UUID (not device name)")
    parser.add_argument("--capture-id", default="baseline", help="stable capture name; change for a later vintage")
    parser.add_argument("--inventory", type=Path, default=SAVED_INVENTORY, help="saved WDS inventory to copy to SSD")
    parser.add_argument("--fetch-inventory", action="store_true", help="fetch inventory directly into SSD if none saved there")
    parser.add_argument("--languages", nargs="+", choices=("en", "fr"), default=["en"])
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--limit", type=int, help="first N inventory PIDs")
    selection.add_argument("--pids", help="comma-separated inventory PIDs for a pilot")
    parser.add_argument("--reserve-gib", type=float, default=100, help="minimum remaining free GiB (default 100)")
    parser.add_argument("--check", action="store_true", help="check mount and local inventory without writes or network")
    parser.add_argument("--dry-run", action="store_true", help="stage inventory on SSD, show job count; no ZIP requests")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", args.capture_id):
        parser.error("--capture-id must be a simple name without slashes")
    if (args.limit is not None and args.limit < 1) or not (0 < args.reserve_gib < 100000):
        parser.error("--limit must be positive and --reserve-gib must be positive")
    try:
        return run(args)
    except (StorageStop, UpstreamStop, DownloadError, OSError, ValueError) as exc:
        print(f"STOP: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
