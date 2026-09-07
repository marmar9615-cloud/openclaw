#!/bin/bash
set -u
cd <HOME>/Desktop/oss/<WORKTREE> || exit 90
export GIT_NO_LAZY_FETCH=1 GIT_ALLOW_PROTOCOL=file
proof_dir=<HOME>/Desktop/oss/handoff/hunt-0904/oc-c1/p122981
proof_check() {
  proof_label=$1
  shift
  printf '%q ' "$@" > "$proof_dir/$proof_label.command"
  printf '\n' >> "$proof_dir/$proof_label.command"
  "$@" > "$proof_dir/$proof_label.log" 2>&1
  proof_rc=$?
  printf '%s\n' "$proof_rc" > "$proof_dir/$proof_label.exit"
  printf '%s exit=%s\n' "$proof_label" "$proof_rc"
  return "$proof_rc"
}
proof_check final-restore git checkout -- . || exit $?
if [ -e "$proof_dir/proof-122981-run.sh" ] || [ -e "$proof_dir/proof-122981-baseline.sh" ]; then
  echo 'Refusing to overwrite archived helpers'
  exit 92
fi
proof_check archive-helpers mv <HOME>/Desktop/oss/<WORKTREE>/proof-122981-run.sh <HOME>/Desktop/oss/<WORKTREE>/proof-122981-baseline.sh "$proof_dir/" || exit $?
proof_check final-status git status --porcelain || exit $?
proof_check final-diff git diff --quiet || exit $?
proof_check final-head git rev-parse HEAD || exit $?
proof_check final-audit node "$proof_dir/audit-final.mjs" || exit $?
