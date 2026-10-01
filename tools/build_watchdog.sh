#!/usr/bin/env bash
# Watchdog for the full builds (wds-full-1, census-full-1). Run every 10 minutes by a bb automation.
# Silent when healthy. Fixes routine problems itself (restarts a stopped build with --resume, at most once an hour
# per build). Messages the bb thread $STATCAN_THREAD only when something needs judgment, once per distinct problem.
set -uo pipefail
export XDG_RUNTIME_DIR=/run/user/$(id -u)
REPO=/home/hemanth/Projects/statcan
D=/run/media/hemanth/Kingston/statcan-derived
THREAD=${STATCAN_THREAD:-thr_tpuw5pk89x}
STATE=$HOME/.cache/statcan-watchdog
mkdir -p "$STATE"
now=$(date +%s)
problems=()
fixed=()

notify_once() {  # key, message: tell the thread unless this exact key was already sent
  local key=$1 msg=$2
  [ -f "$STATE/sent-$key" ] && return
  touch "$STATE/sent-$key"
  problems+=("$msg")
}

unit_state() { systemctl --user show "$1" -p ActiveState --value 2>/dev/null; }
unit_result() { systemctl --user show "$1" -p Result --value 2>/dev/null; }

restart() {  # unit, script, memory: restart a stopped build, at most once an hour
  local unit=$1 script=$2 mem=$3 stamp="$STATE/restart-$1"
  if [ -f "$stamp" ] && [ $((now - $(stat -c %Y "$stamp"))) -lt 3600 ]; then
    notify_once "$unit-restart-loop-$(date +%Y%m%d%H)" "$unit stopped again ($(unit_result "$unit")) within an hour of an automatic restart. Not restarting. Needs a look."
    return
  fi
  touch "$stamp"
  systemctl --user reset-failed "$unit" 2>/dev/null
  if systemd-run --user --unit "$unit" --working-directory "$REPO" -p MemoryMax="$mem" -p MemorySwapMax=1G \
      -p OOMScoreAdjust=800 -p Nice=10 -p "StandardOutput=append:$4" -p "StandardError=append:$4" "$script" >/dev/null 2>&1; then
    fixed+=("restarted $unit with --resume (it had stopped: $5)")
  else
    notify_once "$unit-restart-failed-$(date +%Y%m%d%H)" "$unit had stopped ($5) and the automatic restart failed."
  fi
}

# 1. The SSD must be mounted. Nothing else can be checked or fixed without it.
if ! findmnt -n -o UUID --target /run/media/hemanth/Kingston 2>/dev/null | grep -q 72D0-2131; then
  notify_once "ssd-missing-$(date +%Y%m%d%H)" "SSD 72D0-2131 is not mounted. Builds cannot run."
else
  # 2. Builds: done means build_manifest.json exists. Otherwise the build's unit must be running.
  for b in wds census; do
    dir=$D/$b-full-1
    if [ -f "$dir/build_manifest.json" ]; then
      notify_once "$b-finished" "Build $b-full-1 finished. $(python3 -c "import json;print(json.load(open('$dir/build_manifest.json'))['summary'])"). Next: review failures, then normalize."
      continue
    fi
    if [ $b = wds ]; then unit=statcan-build-wds-phase2; script=$D/wds-phase2.sh; mem=9G; else unit=statcan-build-census; script=$D/census-run.sh; mem=6G; fi
    state=$(unit_state $unit)
    if [ "$state" != active ] && [ "$state" != activating ]; then
      restart $unit "$script" $mem "$D/$b-full-1.log" "${state:-missing}/$(unit_result $unit)"
    fi
    # 3. Stall: no new finished table and no growing output file for 90 minutes.
    count=$(find "$dir/reports" -name '*.json' 2>/dev/null | wc -l)
    bytes=$(du -sb "$dir/obs" 2>/dev/null | cut -f1)
    sig="$count:$bytes"
    if [ "$(cat "$STATE/$b-sig" 2>/dev/null)" != "$sig" ]; then
      echo "$sig" > "$STATE/$b-sig"
    elif [ $((now - $(stat -c %Y "$STATE/$b-sig"))) -gt 5400 ]; then
      notify_once "$b-stall-$count" "$b-full-1 has made no progress for 90+ minutes ($count tables done, output not growing)."
    fi
    # 4. New failures since the last report.
    failed=$(grep -L '"status": "ok"' "$dir"/reports/*.json 2>/dev/null | wc -l)
    last=$(cat "$STATE/$b-failed" 2>/dev/null || echo 0)
    if [ "$failed" -ge $((last + 10)) ]; then
      echo "$failed" > "$STATE/$b-failed"
      notify_once "$b-failed-$failed" "$b-full-1 now has $failed failed tables (was $last). Check whether a new parser issue appeared."
    fi
  done
  # 5. Disk and memory.
  free_gib=$(( $(findmnt -n -b -o AVAIL --target /run/media/hemanth/Kingston) / 1073741824 ))
  [ "$free_gib" -lt 160 ] && notify_once "disk-$((free_gib / 10))" "SSD free space is ${free_gib} GiB (build reserve is 150)."
fi
avail_mib=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
[ "$avail_mib" -lt 1500 ] && notify_once "memory-$(date +%Y%m%d%H)" "Laptop memory is low: ${avail_mib} MiB available."

if [ ${#problems[@]} -gt 0 ]; then
  msg="[build watchdog $(date '+%H:%M')] Needs attention:"$'\n'"$(printf -- '- %s\n' "${problems[@]}")"
  [ ${#fixed[@]} -gt 0 ] && msg+=$'\n'"Already fixed:"$'\n'"$(printf -- '- %s\n' "${fixed[@]}")"
  msg+=$'\n'"Status:"$'\n'"$("$REPO/tools/build_status.sh" 2>&1)"
  printf '%s\n' "$msg" | bb thread tell "$THREAD" --mode auto --message-file - >/dev/null 2>&1
  printf '%s\n' "$msg"
elif [ ${#fixed[@]} -gt 0 ]; then
  printf -- '- %s\n' "${fixed[@]}"  # recorded in the automation run log; no agent wake for routine fixes
fi
