#!/bin/bash
set -u
for proof_iteration in 1 2 3 4 5; do
  /bin/bash <HOME>/Desktop/oss/<WORKTREE>/proof-122981-run.sh "unpatched-$proof_iteration" node scripts/run-vitest.mjs src/gateway/gateway.test.ts
  proof_rc=$?
  printf 'iteration=%s exit=%s\n' "$proof_iteration" "$proof_rc"
done
