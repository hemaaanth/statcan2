# Local WDS acquisition

The first capture targets all 8,271 PIDs in a saved WDS inventory, including archived tables, **English ZIPs only**. French ZIPs are deferred. WDS tables are not an inventory of every public Statistics Canada product. A captured ZIP is one publication version at its download time; old reference periods do not recover earlier publication versions.

## Current machine

- USB SSD: Kingston XS1000, exFAT UUID `72D0-2131`, mounted at `/run/media/hemanth/Kingston`.
- Data root: `/run/media/hemanth/Kingston/statcan-wds`. The `baseline` capture was started on 2026-09-30 UTC.
- Service: `statcan-wds-en-baseline.service` in the user's systemd manager. It is a one-shot background run, not a scheduled update job.
- The SSD had about 588 GiB free at start. The downloader stops before free space falls below its 100 GiB reserve. The size survey is only an estimate, not a guarantee the corpus fits.
- This SSD capture is **not a backup**. Do not treat it as production storage until a second copy and restore check exist.

## Check progress

```bash
systemctl --user show statcan-wds-en-baseline.service -p ActiveState -p SubState -p ExecMainStatus
findmnt -n -o SOURCE,UUID,TARGET --target /run/media/hemanth/Kingston/statcan-wds
# Only read the following paths when the UUID above is 72D0-2131:
tail -n 20 /run/media/hemanth/Kingston/statcan-wds/baseline/acquisition.log
```

`baseline/inventory.json` is the unchanged WDS inventory response. `baseline/inventory-source.json` records its source and hash. `baseline/zips/<PID>-en.zip` holds unchanged source bytes. `baseline/manifests/<PID>-en.json` records the URL, capture time, size, HTTP validators, and SHA-256. Incomplete `.zip.part` and `.zip.part.json` files can resume; `baseline/failures.jsonl` lists attempted PIDs that failed. Historical failures remain in that log after a successful retry; reconcile ZIPs and manifests against the inventory to find current gaps. After retries, an upstream HTTP 503 stops the batch instead of marking more PIDs failed. The final log summary and service exit status distinguish a clean finish from a partial run. Do not infer completion from the existence of the inventory or a few ZIPs.

## Stop or resume

```bash
systemctl --user stop statcan-wds-en-baseline.service
```

Stop may leave a partial ZIP, which is expected. To resume from the repository directory, first confirm the SSD UUID with `findmnt` and make sure the service is not running. The script checks the mount again before every write. It verifies completed files rather than replacing them:

```bash
SSD=/run/media/hemanth/Kingston/statcan-wds
TMPDIR="$SSD" python3 -B tools/wds_download.py \
  --destination "$SSD" --mount-uuid 72D0-2131 \
  --capture-id baseline --fetch-inventory --languages en
```

A repeat with `baseline` uses the same inventory and skips verified ZIPs. A different `--capture-id` makes a separate later capture; it does not overwrite this one. Do not run two downloaders for the same capture at once. The existing service's log is on the SSD; the manual command above prints progress to the terminal. The script's `--check` option checks the mount and inventory without writing or making requests.

The [network-free tests](tools/test_wds_download.py) require `WDS_TEST_DEST` and `WDS_TEST_UUID`; set them to a checked mounted test destination before running. They never choose the OS disk as a default.
