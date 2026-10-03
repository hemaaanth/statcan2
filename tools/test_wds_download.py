#!/usr/bin/env python3
"""Network-free checks; all temporary data is created on the UUID-checked SSD."""

import io
import json
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import wds_download as wds

SSD = Path(os.environ["WDS_TEST_DEST"]) if os.environ.get("WDS_TEST_DEST") else None
UUID = os.environ.get("WDS_TEST_UUID")
PID = "17100009"
URL = f"https://www150.statcan.gc.ca/n1/tbl/csv/{PID}-eng.zip"
buffer = io.BytesIO()
with zipfile.ZipFile(buffer, "w") as archive:
    archive.writestr("sample.csv", "value\n1\n")
DATA = buffer.getvalue()


class Response:
    def __init__(self, data, status=200, offset=0, interrupted=False):
        self.status = status
        self.headers = {"Content-Length": str(len(data) - offset), "ETag": '"version-1"',
                        "Last-Modified": "Wed, 30 Sep 2026 00:00:00 GMT", "Content-Type": "application/zip"}
        if status == 206:
            self.headers["Content-Range"] = f"bytes {offset}-{len(data) - 1}/{len(data)}"
        self.body = io.BytesIO(data[offset:])
        self.interrupted = interrupted
        self.reads = 0

    def read(self, count):
        self.reads += 1
        if self.interrupted and self.reads == 2:
            raise wds.StopRequested()
        return self.body.read(min(count, 7))

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.body.close()


class Client:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def open(self, url, headers=None):
        self.calls.append((url, headers))
        assert url == URL
        return self.response.pop(0) if isinstance(self.response, list) else self.response


class DownloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if SSD is None or UUID is None:
            raise unittest.SkipTest("set WDS_TEST_DEST and WDS_TEST_UUID to run SSD-only tests")
        wds.Drive(SSD, UUID).check()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=SSD)
        self.addCleanup(self.temp.cleanup)
        self.drive = wds.Drive(self.temp.name, UUID)
        self.output = Path(self.temp.name) / "table.zip"
        self.manifest = Path(self.temp.name) / "table.json"

    def transfer(self, client):
        return wds.transfer(self.drive, client, PID, "en", URL, self.output, self.manifest)

    def test_interruption_resume_and_verified_skip(self):
        with self.assertRaises(wds.StopRequested):
            self.transfer(Client(Response(DATA, interrupted=True)))
        part = self.output.with_suffix(".zip.part")
        self.assertEqual(part.read_bytes(), DATA[:7])
        resumed = Client(Response(DATA, status=206, offset=7))
        self.assertEqual(self.transfer(resumed), ("downloaded", len(DATA)))
        self.assertEqual(resumed.calls[0][1], {"Range": "bytes=7-", "If-Range": '"version-1"'})
        self.assertEqual(self.output.read_bytes(), DATA)
        meta = json.loads(self.manifest.read_text())
        self.assertEqual(meta["pid"], PID)
        self.assertEqual(meta["etag"], '"version-1"')
        self.assertEqual(meta["source_total_bytes"], len(DATA))
        self.assertEqual(self.transfer(Client(None)), ("skipped", 0))
        self.output.write_bytes(DATA + b"corrupt")
        with self.assertRaisesRegex(wds.DownloadError, "size mismatch"):
            self.transfer(Client(None))

    def test_recover_after_final_rename(self):
        self.transfer(Client(Response(DATA)))
        state = self.output.with_suffix(".zip.part.json")
        self.manifest.rename(state)  # Simulate interruption between the two renames.
        self.assertEqual(self.transfer(Client(None)), ("skipped", 0))
        self.assertTrue(self.manifest.exists())

    def test_wrong_mount_and_low_disk_stop(self):
        with self.assertRaises(wds.StorageStop):
            wds.Drive(self.temp.name, "0000-0000")
        with patch.object(wds.os.path, "ismount", return_value=False):
            with self.assertRaisesRegex(wds.StorageStop, "not mounted"):
                self.drive.check()
        original = self.drive.check
        def no_space(size=0):
            if size >= len(DATA) + wds.CHUNK:
                raise wds.StorageStop("reserve reached")
            return original(size)
        with patch.object(self.drive, "check", side_effect=no_space):
            with self.assertRaisesRegex(wds.StorageStop, "reserve reached"):
                self.transfer(Client(Response(DATA)))
        self.assertFalse(self.output.exists())

    def test_identity_encoding_and_update_window_retry(self):
        client = wds.Client()
        with patch.object(client.opener, "open", return_value=Response(DATA)) as opened:
            with client.open(URL):
                pass
        self.assertEqual(opened.call_args.args[0].get_header("Accept-encoding"), "identity")
        conflict = wds.urllib.error.HTTPError(URL, 409, "Conflict", {}, None)
        self.assertTrue(wds.retryable(conflict))
        conflict.close()
        compressed = Response(DATA)
        compressed.headers["Content-Encoding"] = "gzip"
        with self.assertRaisesRegex(wds.DownloadError, "Content-Encoding"):
            self.transfer(Client(compressed))
        self.assertFalse(self.output.with_suffix(".zip.part").exists())

    def test_persistent_503_stops_without_marking_a_table_failed(self):
        source = Path(self.temp.name) / "inventory-source.json"
        source.write_text(json.dumps([{"productId": int(PID)}]))
        args = SimpleNamespace(destination=Path(self.temp.name), capture_id="outage-test", mount_uuid=UUID,
                               reserve_gib=100, check=False, inventory=source, fetch_inventory=False,
                               limit=None, pids=None, languages=["en"], dry_run=False)
        outage = wds.urllib.error.HTTPError(URL, 503, "Service Unavailable", {}, None)
        with patch.object(wds.Client, "open", side_effect=outage) as opened, patch.object(wds.time, "sleep"):
            self.assertEqual(wds.run(args), 3)
        self.assertEqual(opened.call_count, 3)
        self.assertFalse((Path(self.temp.name) / "outage-test/failures.jsonl").exists())
        with patch.object(wds.Client, "open", side_effect=outage) as opened, patch.object(wds.time, "sleep"):
            with self.assertRaises(wds.UpstreamStop):
                self.transfer(wds.Client())
        self.assertEqual(opened.call_count, 3)
        self.assertFalse(self.output.exists())
        outage.close()

    def test_slow_connection_reconnects_and_resumes(self):
        clock = [0]
        class Slow(Response):
            def read(self, count):
                clock[0] += wds.SLOW_WINDOW
                return super().read(count)
        client = Client([Slow(DATA), Response(DATA, status=206, offset=7)])
        with patch.object(wds.time, "monotonic", lambda: clock[0]), patch.object(wds.time, "sleep"):
            self.assertEqual(self.transfer(client), ("downloaded", len(DATA)))
        self.assertEqual(client.calls[1][1], {"Range": "bytes=7-", "If-Range": '"version-1"'})
        self.assertEqual(self.output.read_bytes(), DATA)

    def test_api_url_is_authoritative_for_archived_tables(self):
        archived = f"https://www150.statcan.gc.ca/archive/{PID}/download.zip"
        with patch.object(wds, "api_json", return_value=json.dumps({"status": "SUCCESS", "object": archived}).encode()):
            self.assertEqual(wds.zip_url(None, PID, "en"), archived)
        with patch.object(wds, "api_json", return_value=b'{"status":"FAILED","object":null}'):
            with self.assertRaisesRegex(wds.DownloadError, "did not provide a ZIP"):
                wds.zip_url(None, PID, "en")

    def test_sigterm_stops_before_download(self):
        source = Path(self.temp.name) / "inventory-source.json"
        source.write_text(json.dumps([{"productId": int(PID)}]))
        args = SimpleNamespace(destination=Path(self.temp.name), capture_id="signal-test", mount_uuid=UUID,
                               reserve_gib=100, check=False, inventory=source, fetch_inventory=False,
                               limit=None, pids=None, languages=["en"], dry_run=False)
        handlers = {}
        def stop_on_request(*_):
            handlers[wds.signal.SIGTERM](wds.signal.SIGTERM, None)
            raise wds.StopRequested()
        with patch.object(wds.signal, "signal", side_effect=lambda sig, handler: handlers.__setitem__(sig, handler)):
            with patch.object(wds, "zip_url", side_effect=stop_on_request):
                self.assertEqual(wds.run(args), 130)
        self.assertIn(wds.signal.SIGTERM, handlers)

    def test_range_ignored_restarts_and_invalid_range_rejected(self):
        with self.assertRaises(wds.StopRequested):
            self.transfer(Client(Response(DATA, interrupted=True)))
        with self.assertRaisesRegex(wds.DownloadError, "invalid resume response"):
            self.transfer(Client(Response(DATA, status=206, offset=8)))
        self.assertEqual(self.output.with_suffix(".zip.part").read_bytes(), DATA[:7])
        full = Client(Response(DATA))
        self.assertEqual(self.transfer(full), ("downloaded", len(DATA)))
        self.assertEqual(full.calls[0][1]["Range"], "bytes=7-")
        self.assertEqual(self.output.read_bytes(), DATA)


if __name__ == "__main__":
    unittest.main()
