#!/bin/bash
set -u
proof_cpu_pids=()
proof_sample_pid=
proof_cpu_cleanup() {
  if [ -n "$proof_sample_pid" ]; then
    kill "$proof_sample_pid" 2>/dev/null || true
    wait "$proof_sample_pid" 2>/dev/null || true
  fi
  for proof_pid in "${proof_cpu_pids[@]}"; do kill "$proof_pid" 2>/dev/null || true; done
  for proof_pid in "${proof_cpu_pids[@]}"; do wait "$proof_pid" 2>/dev/null || true; done
  for proof_pid in "${proof_cpu_pids[@]}"; do
    if kill -0 "$proof_pid" 2>/dev/null; then
      printf 'CPU cleanup FAILED pid=%s\n' "$proof_pid"
    else
      printf 'CPU cleanup confirmed pid=%s\n' "$proof_pid"
    fi
  done
}
trap proof_cpu_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
proof_cores=$(sysctl -n hw.logicalcpu)
printf 'CPU load: %s yes processes, one per logical core\n' "$proof_cores"
for ((proof_i=0; proof_i<proof_cores; proof_i++)); do
  yes > /dev/null &
  proof_cpu_pids+=("$!")
done
proof_pid_csv=$(IFS=,; echo "${proof_cpu_pids[*]}")
(
  proof_sleep_pid=
  trap 'if [ -n "$proof_sleep_pid" ]; then kill "$proof_sleep_pid" 2>/dev/null || true; wait "$proof_sleep_pid" 2>/dev/null || true; fi; exit 0' TERM INT
  while true; do
    date -u '+%Y-%m-%dT%H:%M:%SZ CPU sample'
    ps -p "$proof_pid_csv" -o pid=,pcpu=,comm=
    sleep 10 &
    proof_sleep_pid=$!
    wait "$proof_sleep_pid"
    proof_sleep_pid=
  done
) &
proof_sample_pid=$!
"$@"
proof_test_rc=$?
printf 'CPU test exit=%s\n' "$proof_test_rc"
exit "$proof_test_rc"
