#!/usr/bin/env bash
# winvm-runner.sh [--once]: winvm's runner for ci.yml's Native Windows install (README "Windows runner (winvm)").
# Runs on the maintainer's PC, beside the `winvm` command, as user unit ovis-winvm-runner. Each round, one job:
#   1. takes the winvm lease and keeps it while it runs: a lane that holds the VM keeps the runner off (CI then takes
#      windows-latest), and a lane that wants the VM stops this unit first;
#   2. waits until no other repository's runner in the VM is in a job, then `winvm reset` and `winvm start`: every job
#      starts from the snapshot, and nothing of the last one is left;
#   3. copies the newest actions/runner package and this folder's winvm-*.ps1 into the VM, and registers one ephemeral
#      runner (labels self-hosted, self-hosted-ovis-win) in the VM's desktop session through Invoke-InSession, as the
#      Windows checks need; the registration token goes over ssh's stdin into a file the VM script deletes;
#   4. while that runner listens, writes the Unix time into the repository variable CI_WINVM_READY every minute, which
#      ci-runner-route.sh reads: a job routes here only while that mark is under three minutes old. A job's start sets
#      it to 0, so the next pull request takes windows-latest instead of waiting for this one.
# An idle runner is recycled after 100 minutes (Invoke-InSession ends its task after two hours), and a stop waits for a
# job in progress; both first clear the mark, then wait four minutes for a job a route sent just before.
# --once: one round, then the same cleanup as a stop.
set -uo pipefail
REPO=${OVIS_WINVM_REPO:-devswha/ovis}
NAME=ovis-winvm
LEASE=ci-winvm-runner
VAR=CI_WINVM_READY
HERE=$(cd "$(dirname "$0")" && pwd)
CACHE=${XDG_CACHE_HOME:-$HOME/.cache}/winvm-runner
VM_DIR='C:\ProgramData\winvm\ovis-runner'
IDLE_LIMIT=6000
DRAIN=240
once=0
[ "${1:-}" = --once ] && once=1
mkdir -p "$CACHE"
RUN=$(mktemp -d "$CACHE/run.XXXXXX")
log() { echo "$(date -Is) $*"; }
mark() { gh variable set "$VAR" --repo "$REPO" --body "$1" >/dev/null 2>&1 || log "could not set $VAR to $1"; }
vm() { ssh -o BatchMode=yes -o ConnectTimeout=10 winvm "$@" 2>/dev/null; }
stopping() { [ -e "$RUN/stop" ]; }
pause() { local i; for ((i = 0; i < $1; i++)); do stopping && return 1; sleep 1; done; }

# the newest actions/runner for Windows x64 in the cache; prints its version
runner_package() {
  local tag version file
  tag=$(gh api repos/actions/runner/releases/latest --jq .tag_name) || return 1
  version=${tag#v}
  file=$CACHE/actions-runner-win-x64-$version.zip
  if [ ! -f "$file" ]; then
    curl -fsSL -o "$file.part" "https://github.com/actions/runner/releases/download/$tag/actions-runner-win-x64-$version.zip" || return 1
    mv "$file.part" "$file"
    find "$CACHE" -name 'actions-runner-win-x64-*.zip' ! -name "${file##*/}" -delete
  fi
  echo "$version"
}

# another repository's runner in the VM (kept in its snapshot) may be in a job: a reset now would kill it
wait_other_jobs() {
  local count waited=0
  [ "$(winvm status | head -1)" = running ] || return 0
  while count=$(vm '@(Get-Process Runner.Worker -ErrorAction SilentlyContinue).Count') && [ "${count//[[:space:]]/}" != 0 ]; do
    if (( waited % 300 == 0 )); then log "a runner in the VM is in a job ($count); waiting before the reset"; fi
    if (( waited >= 3600 )); then log "still in a job after an hour; resetting anyway"; return 0; fi
    sleep 30; waited=$((waited + 30))
  done
}

# while the runner listens: the mark every minute, the lease renewed; an idle runner is recycled, a stop drains it
heartbeat() {
  local ssh_pid=$1 since=$SECONDS
  while kill -0 "$ssh_pid" 2>/dev/null; do
    if [ "$(cat "$RUN/state")" = listening ]; then
      if stopping || (( SECONDS - since > IDLE_LIMIT )); then
        mark 0
        echo draining >"$RUN/state"
        log "no new job routes here now; waiting ${DRAIN}s for one a route sent before"
        sleep "$DRAIN"
        if [ "$(cat "$RUN/state")" = draining ]; then
          log "no job came; ending this runner"
          kill "$ssh_pid" 2>/dev/null
        fi
        return
      fi
      mark "$(date +%s)"
      winvm lease "$LEASE" >/dev/null
    fi
    sleep 60
  done
}

round() {
  local version token ssh_pid beat_pid desktop=0
  local busy
  until busy=$(winvm lease "$LEASE"); do
    log "$busy"
    pause 60 || return 0
  done
  wait_other_jobs
  winvm reset >/dev/null && winvm start >/dev/null || { log "winvm reset/start failed"; return 1; }
  for _ in $(seq 100); do
    if vm "if (Get-Process explorer -IncludeUserName -ErrorAction SilentlyContinue | Where-Object UserName -like '*\\devswha') { 'UP' }" | grep -q UP; then desktop=1; break; fi
    sleep 3
  done
  (( desktop )) || { log "winvm's desktop session did not come up"; return 1; }
  version=$(runner_package) || { log "could not fetch the actions/runner package"; return 1; }
  vm "New-Item -ItemType Directory -Force -Path '$VM_DIR' | Out-Null" || { log "ssh winvm failed"; return 1; }
  scp -q -o BatchMode=yes "$CACHE/actions-runner-win-x64-$version.zip" "$HERE/winvm-runner.ps1" "$HERE/winvm-job-started.ps1" \
    "winvm:${VM_DIR//\\//}/" 2>/dev/null || { log "copying into winvm failed"; return 1; }
  token=$(gh api -X POST "repos/$REPO/actions/runners/registration-token" --jq .token) || { log "no registration token"; return 1; }
  printf '%s\n' "$token" | vm "pwsh -NoProfile -Command \"[Console]::In.ReadLine() | Set-Content -NoNewline -LiteralPath '$VM_DIR\\token'\"" \
    || { log "could not hand the token over"; return 1; }
  unset token
  echo starting >"$RUN/state"
  : >"$RUN/out"
  ssh -o BatchMode=yes winvm "pwsh -File C:\\ProgramData\\winvm\\Invoke-InSession.ps1 -Command '& $VM_DIR\\winvm-runner.ps1 -Version $version -Repository $REPO -Name $NAME'" \
    >"$RUN/out" 2>&1 </dev/null &
  ssh_pid=$!
  heartbeat "$ssh_pid" &
  beat_pid=$!
  while IFS= read -r line; do
    echo "winvm| $line"
    case $line in
      *"Listening for Jobs"*) echo listening >"$RUN/state"; mark "$(date +%s)"; log "runner $NAME listens (runner $version)" ;;
      *"Running job:"*) echo job >"$RUN/state"; mark 0 ;;
    esac
  done < <(tail -n +1 -f --pid="$ssh_pid" "$RUN/out")
  wait "$ssh_pid"
  log "runner $NAME ended ($?)"
  kill "$beat_pid" 2>/dev/null
  wait "$beat_pid" 2>/dev/null
  mark 0
}

# leaves the VM as a lane expects it: reset to the snapshot and running, no runner of this script registered, lease free
cleanup() {
  local id
  mark 0
  if [ "$(cut -d' ' -f1 "$HOME/.cache/winvm.lease" 2>/dev/null)" = "$LEASE" ]; then
    wait_other_jobs
    winvm reset >/dev/null && winvm start >/dev/null
    winvm release >/dev/null
  fi
  id=$(gh api "repos/$REPO/actions/runners" --paginate --jq ".runners[] | select(.name == \"$NAME\") | .id") \
    && for i in $id; do gh api -X DELETE "repos/$REPO/actions/runners/$i" >/dev/null; done
  rm -rf "$RUN"
  log "stopped"
}

# a stop never kills a job: it drains a listening runner (heartbeat) and waits for one in a job
trap 'touch "$RUN/stop"; log "stopping"' TERM INT
while :; do
  round || pause 60
  if (( once )) || stopping; then break; fi
done
cleanup
