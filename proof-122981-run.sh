#!/bin/bash
set -u
cd <HOME>/Desktop/oss/<WORKTREE> || exit 90
export GIT_NO_LAZY_FETCH=1
export GIT_ALLOW_PROTOCOL=file
proof_dir=<HOME>/Desktop/oss/handoff/hunt-0904/oc-c1/p122981
proof_label=$1
shift
if [ -e "$proof_dir/$proof_label.exit" ] || [ -e "$proof_dir/$proof_label.log" ]; then
  echo "Refusing to overwrite existing evidence: $proof_label"
  exit 91
fi
printf '%q ' "$@" > "$proof_dir/$proof_label.command"
printf '\n' >> "$proof_dir/$proof_label.command"
while true; do
  proof_busy=$(pgrep -fl '(vitest|run-tsgo|tsgolint|oxlint|run-lint|scripts/ui\.js|check-max-lines|check-assertion|madge|qa suite)' | grep -v '<WORKTREE>/' | grep -v pgrep)
  if [ -z "$proof_busy" ]; then
    date -u '+%Y-%m-%dT%H:%M:%SZ gate clear' >> "$proof_dir/$proof_label.gate.log"
    break
  fi
  date -u '+%Y-%m-%dT%H:%M:%SZ waiting' >> "$proof_dir/$proof_label.gate.log"
  printf '%s\n' "$proof_busy" >> "$proof_dir/$proof_label.gate.log"
  sleep 15
done
date -u '+%Y-%m-%dT%H:%M:%SZ' > "$proof_dir/$proof_label.started"
"$@" > "$proof_dir/$proof_label.log" 2>&1
proof_rc=$?
printf '%s\n' "$proof_rc" > "$proof_dir/$proof_label.exit"
date -u '+%Y-%m-%dT%H:%M:%SZ' > "$proof_dir/$proof_label.finished"
printf '%s exit=%s\n' "$proof_label" "$proof_rc"
tail -n 12 "$proof_dir/$proof_label.log"
exit "$proof_rc"
