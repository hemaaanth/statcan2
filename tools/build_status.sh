#!/usr/bin/env bash
# Progress of the full builds. Read-only. Usage: tools/build_status.sh
D=/run/media/hemanth/Kingston/statcan-derived
findmnt -n -o UUID --target /run/media/hemanth/Kingston | grep -q 72D0-2131 || { echo "SSD 72D0-2131 not mounted"; exit 1; }
date '+%F %H:%M'
for pair in wds:statcan-build-wds census:statcan-build-census; do
  name=${pair%%:*} unit=${pair#*:} b=$D/$name-full-1
  total=$(wc -l < "$D/full-$name-pids.txt")
  done_=$(find "$b/reports" -name '*.json' 2>/dev/null | wc -l)
  ok=$(grep -l '"status": "ok"' "$b"/reports/*.json 2>/dev/null | wc -l)
  state=$(systemctl --user show "$unit" -p ActiveState --value)
  [ -f "$b/build_manifest.json" ] && state="finished"
  printf '%-7s %5d / %d tables done (%d ok, %d failed)  service: %s\n' "$name" "$done_" "$total" "$ok" "$((done_ - ok))" "$state"
  for f in "$b"/obs/*.tmp; do [ -e "$f" ] && printf '        building %s  (%s so far)\n' "$(basename "$f" .parquet.tmp)" "$(du -h "$f" | cut -f1)"; done
done
echo "free on SSD: $(findmnt -n -o AVAIL --target /run/media/hemanth/Kingston)"
