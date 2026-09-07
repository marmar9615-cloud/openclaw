#!/bin/bash
set -u
proof_runner=<HOME>/Desktop/oss/<WORKTREE>/proof-122981-run.sh
proof_dir=<HOME>/Desktop/oss/handoff/hunt-0904/oc-c1/p122981
for proof_kind in full isolated cpu; do
  proof_n=10
  if [ "$proof_kind" = cpu ]; then proof_n=5; fi
  for ((proof_i=1; proof_i<=proof_n; proof_i++)); do
    proof_id="probe-$proof_kind-$proof_i"
    if [ "$proof_kind" = isolated ]; then
      bash "$proof_runner" "$proof_id" env "P122981_RUN_ID=$proof_id" node scripts/run-vitest.mjs src/gateway/gateway.test.ts -t 'does not reload workspace plugins when POST /tools/invoke rebuilds tools for the same workspace'
    elif [ "$proof_kind" = cpu ]; then
      bash "$proof_runner" "$proof_id" env "P122981_RUN_ID=$proof_id" bash "$proof_dir/proof-cpu.sh" node scripts/run-vitest.mjs src/gateway/gateway.test.ts
    else
      bash "$proof_runner" "$proof_id" env "P122981_RUN_ID=$proof_id" node scripts/run-vitest.mjs src/gateway/gateway.test.ts
    fi
    proof_rc=$?
    printf 'batch id=%s exit=%s\n' "$proof_id" "$proof_rc"
  done
done
