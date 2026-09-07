# PR #122981 exact-head proof report

## Verdict

Not observable at this head in 25 probe runs under these conditions; the deterministic claim should be withdrawn and the change described as hardening. Separately, all five unpatched full-file runs passed. Across all 30 test executions, every command exited 0.

The probe observed a lower pre-wait counter in **0/25** runs: 0/10 full-file, 0/10 isolated, and 0/5 CPU-loaded full-file. Every pair was 2 to 2. This is a bounded negative result, not proof that a timing race is impossible.

Exact head: `7d0098415ba17bf1f21af2cf6ff5977bb8415f86`, detached. Run date: 2026-09-07. Only worktree used: `<HOME>/Desktop/oss/<WORKTREE>`. No commit, remote Git operation, PR edit, comment, or re-review request was made. The requested PR-body read was read-only.

## Conditions and method

- macOS 27.0 / Darwin 27.0.0, ARM64, 10 logical and 10 physical cores, 32 GiB RAM; Node v26.5.0, pnpm 12.1.0, Vitest 4.1.11. Metadata is in [probe-audit.log](probe-audit.log); dependency installation is in [install.log](install.log).
- `pnpm install --frozen-lockfile` ran first with the normal inherited HOME and warm shared store, exit 0. No dependency versions or test timeout settings were changed.
- Every heavy command passed the supplied process gate before starting. Each run has a separate `.gate.log`, `.command`, `.log`, `.exit`, `.started`, and `.finished`. Exit status was captured immediately after the command, before any output filtering. Individual `.exit` files are authoritative; the batch shell's final exit is not an aggregate test verdict.
- The unpatched phase removed only the two comment lines, settlement await, and blank line. [unpatched.patch](unpatched.patch) and [unpatched-audit.log](unpatched-audit.log) document the single four-line deletion. The file was restored afterward with `git checkout -- src/gateway/gateway.test.ts`; `git diff --quiet` returned 0.
- The probe added code only inside the named test case. The audit removes those additions and compares the result byte-for-byte with HEAD. The existing fixture, HTTP request, and assertions were not changed. See [probe.patch](probe.patch) and [probe-audit.log](probe-audit.log).
- Immediately after the gateway helper's continuation ran, the probe called the existing `readCounterWithRetry`, recorded the returned counter and time, awaited `server.startupSettled`, then reused the original baseline read as the second sample. It appended one JSON line only after both observations, before the unchanged assertions/request. There were no artificial sleeps inside the probe.
- Pre-read ms is the time from the post-helper continuation to the first read's completion. Wait ms measures the settlement await. Sample-to-sample ms measures first-read completion through second-read completion, using the monotonic clock. ISO timestamps mark observation/continuation times, not exact registration times or exact promise-resolution instants. All table timestamps are UTC on 2026-09-07; full-precision values and all four timestamps are retained in [probe-samples.jsonl](probe-samples.jsonl).
- Runs were retained in execution order: 5 unpatched, 10 full-file probe, 10 isolated probe, 5 CPU-loaded probe. There were no discarded runs, retries replacing failures, missing samples, or duplicate sample IDs.
- The first unpatched command automatically built the E2E runtime. Its wrapper time includes that build; later commands used the resulting cache. Full-file runs selected 13 tests at this head, not the 16 shown in the older PR-body evidence. Isolated runs selected one test and skipped 12.

## Experiment 1: unpatched full file

Command for every row: `node scripts/run-vitest.mjs src/gateway/gateway.test.ts`.

| Run | Exit | Full-file result | Target case | Wrapper seconds |
|---|---:|---|---|---:|
| [unpatched-1](unpatched-1.log) | 0 | 13 passed | Passed | 362.24 |
| [unpatched-2](unpatched-2.log) | 0 | 13 passed | Passed | 28.46 |
| [unpatched-3](unpatched-3.log) | 0 | 13 passed | Passed | 30.04 |
| [unpatched-4](unpatched-4.log) | 0 | 13 passed | Passed | 36.24 |
| [unpatched-5](unpatched-5.log) | 0 | 13 passed | Passed | 32.32 |

Failure count: 0/5. There is no failing assertion text to report. In particular, these runs did not produce the claimed `expected 2 to be 1` failure. No counter probe was present in this phase.

## Experiment 2: pre-wait versus settled probe

| Condition | Passed runs | Samples | Pre lower / equal / higher | Pre min/max | Settled min/max | Sample-to-sample ms min/max |
|---|---:|---:|---|---|---|---|
| probe-full | 10/10 | 10 | 0 / 10 / 0 | 2 / 2 | 2 / 2 | 0.203 to 0.550 |
| probe-isolated | 10/10 | 10 | 0 / 10 / 0 | 2 / 2 | 2 / 2 | 139.218 to 168.930 |

### Full file

| Run | Exit | Pre | Settled | Pre-read ms | Wait ms | Sample-to-sample ms | Pre sample UTC | Settled sample UTC |
|---|---:|---:|---:|---:|---:|---:|---|---|
| [probe-full-1](probe-full-1.log) | 0 | 2 | 2 | 161.367 | 0.001 | 0.296 | 20:57:53.263Z | 20:57:53.263Z |
| [probe-full-2](probe-full-2.log) | 0 | 2 | 2 | 157.317 | 0.002 | 0.550 | 20:58:20.975Z | 20:58:20.976Z |
| [probe-full-3](probe-full-3.log) | 0 | 2 | 2 | 153.199 | 0.001 | 0.213 | 20:58:47.870Z | 20:58:47.870Z |
| [probe-full-4](probe-full-4.log) | 0 | 2 | 2 | 146.843 | 0.001 | 0.245 | 20:59:14.144Z | 20:59:14.144Z |
| [probe-full-5](probe-full-5.log) | 0 | 2 | 2 | 152.182 | 0.002 | 0.238 | 20:59:43.684Z | 20:59:43.684Z |
| [probe-full-6](probe-full-6.log) | 0 | 2 | 2 | 157.090 | 0.001 | 0.291 | 21:00:11.885Z | 21:00:11.886Z |
| [probe-full-7](probe-full-7.log) | 0 | 2 | 2 | 161.614 | 0.003 | 0.325 | 21:00:40.287Z | 21:00:40.287Z |
| [probe-full-8](probe-full-8.log) | 0 | 2 | 2 | 154.466 | 0.001 | 0.304 | 21:01:11.663Z | 21:01:11.663Z |
| [probe-full-9](probe-full-9.log) | 0 | 2 | 2 | 150.263 | 0.001 | 0.279 | 21:01:39.923Z | 21:01:39.923Z |
| [probe-full-10](probe-full-10.log) | 0 | 2 | 2 | 146.942 | 0.002 | 0.203 | 21:02:08.010Z | 21:02:08.010Z |

### Isolated case

The filter was the exact case title, shown in Appendix A. Each run passed one test with 12 skipped.

| Run | Exit | Pre | Settled | Pre-read ms | Wait ms | Sample-to-sample ms | Pre sample UTC | Settled sample UTC |
|---|---:|---:|---:|---:|---:|---:|---|---|
| [probe-isolated-1](probe-isolated-1.log) | 0 | 2 | 2 | 0.776 | 160.168 | 160.541 | 21:02:29.284Z | 21:02:29.445Z |
| [probe-isolated-2](probe-isolated-2.log) | 0 | 2 | 2 | 1.233 | 168.331 | 168.930 | 21:02:49.005Z | 21:02:49.174Z |
| [probe-isolated-3](probe-isolated-3.log) | 0 | 2 | 2 | 1.330 | 156.504 | 156.875 | 21:03:08.504Z | 21:03:08.661Z |
| [probe-isolated-4](probe-isolated-4.log) | 0 | 2 | 2 | 1.384 | 159.400 | 159.769 | 21:03:28.220Z | 21:03:28.379Z |
| [probe-isolated-5](probe-isolated-5.log) | 0 | 2 | 2 | 1.425 | 154.663 | 155.037 | 21:03:49.551Z | 21:03:49.706Z |
| [probe-isolated-6](probe-isolated-6.log) | 0 | 2 | 2 | 1.649 | 167.597 | 168.018 | 21:04:09.833Z | 21:04:10.001Z |
| [probe-isolated-7](probe-isolated-7.log) | 0 | 2 | 2 | 2.615 | 159.387 | 159.815 | 21:04:30.711Z | 21:04:30.871Z |
| [probe-isolated-8](probe-isolated-8.log) | 0 | 2 | 2 | 0.935 | 147.573 | 148.066 | 21:04:50.512Z | 21:04:50.660Z |
| [probe-isolated-9](probe-isolated-9.log) | 0 | 2 | 2 | 0.763 | 167.028 | 167.432 | 21:05:09.812Z | 21:05:09.980Z |
| [probe-isolated-10](probe-isolated-10.log) | 0 | 2 | 2 | 1.562 | 138.816 | 139.218 | 21:05:29.281Z | 21:05:29.420Z |

## Experiment 3: same probe with CPU contention

Ten `yes > /dev/null` processes were started, one per logical core, after the load gate cleared and before each full-file command. They remained running until that command finished. The script recorded their CPU use every ten seconds, then killed and waited for only its recorded PIDs. Its sampling subprocess and active sleep were also cleaned up. See [proof-cpu.sh](proof-cpu.sh) and each run log.

All five runs passed all 13 tests. Counter distribution: 0 lower, 5 equal, 0 higher. Pre min/max: 2/2. Settled min/max: 2/2. Sample-to-sample spread: 0.355 to 2.768 ms. Wrapper times were 53.05, 51.25, 50.34, 56.45, 51.39 seconds. Periodic CPU observations substantiate contention; they are not a claim of exact CI equivalence or identical utilization at every instant.

| Run | Exit | Pre | Settled | Pre-read ms | Wait ms | Sample-to-sample ms | Pre sample UTC | Settled sample UTC |
|---|---:|---:|---:|---:|---:|---:|---|---|
| [probe-cpu-1](probe-cpu-1.log) | 0 | 2 | 2 | 174.301 | 0.001 | 0.628 | 21:06:21.332Z | 21:06:21.333Z |
| [probe-cpu-2](probe-cpu-2.log) | 0 | 2 | 2 | 294.534 | 0.001 | 0.438 | 21:07:13.418Z | 21:07:13.418Z |
| [probe-cpu-3](probe-cpu-3.log) | 0 | 2 | 2 | 172.766 | 0.001 | 0.355 | 21:08:04.750Z | 21:08:04.750Z |
| [probe-cpu-4](probe-cpu-4.log) | 0 | 2 | 2 | 212.292 | 0.002 | 2.768 | 21:09:02.071Z | 21:09:02.074Z |
| [probe-cpu-5](probe-cpu-5.log) | 0 | 2 | 2 | 188.968 | 0.002 | 1.571 | 21:09:53.786Z | 21:09:53.788Z |

All 50 burner PIDs were confirmed stopped in the per-run logs and independently checked absent during the final audit.

## Interpretation and limits

The helper explicitly requests deferred sidecars at [gateway.test.ts:44](<HOME>/Desktop/oss/<WORKTREE>/src/gateway/gateway.test.ts:44). The scheduling code uses a 100 ms deferred turn at [server-startup-post-attach.ts:1372](<HOME>/Desktop/oss/<WORKTREE>/src/gateway/server-startup-post-attach.ts:1372), and returns a settlement promise joining sidecars and startup logging at [server-startup-post-attach.ts:1679](<HOME>/Desktop/oss/<WORKTREE>/src/gateway/server-startup-post-attach.ts:1679). This is a reason to await the startup boundary before choosing a test baseline. It is not a guarantee that a second registration must occur after the gateway helper returns in every run.

The existing [counter helper](<HOME>/Desktop/oss/<WORKTREE>/src/gateway/gateway.test.ts:79) returns the first finite counter, polling for up to 1,000 ms at a configured 50 ms interval if needed. It does not require a stable counter. The first read took 146.843 to 161.614 ms in full-file runs, 0.763 to 2.615 ms in isolation, and 172.766 to 294.534 ms under load. An earlier window can therefore be missed.

The isolated settlement awaits took 138.816 to 168.331 ms despite unchanged counters. Counter equality alone is not a complete settlement signal. The probe also adds an awaited evidence-file write before the HTTP request; its passing assertions are not timing-identical to uninstrumented runs. The five separate unpatched runs supply the uninstrumented comparison.

These observations are from one machine and runtime configuration. They do not establish current main behavior, reproduce the August experiment at `93cf912695`, identify registration callers by new tracing, or prove a race absent under all scheduling conditions.

The captured PR body still has deterministic-failure claims in **What Problem This Solves** and **User Impact**, plus historical ordering/timing claims in **Why This Change Was Made**. Replacing only Evidence would leave contradictory current-head claims elsewhere. The independent checker should review those sections as well. No remote wording was changed by this round.

## Draft replacement Evidence section

At head 7d0098415ba17bf1f21af2cf6ff5977bb8415f86 on September 7, 2026, all five full-file runs with the settlement wait removed passed, with 13 tests passing and exit 0 each time. A temporary probe sampled the registration counter before awaiting startup settlement and again afterward. All 10 full-file runs, 10 isolated-case runs, and 5 full-file runs with one CPU burner per logical core passed. Both samples were 2 in every run; 0 of 25 samples increased across settlement. These results were obtained on one 10-core ARM64 macOS machine. The existing counter-reading helper can wait for the file, so these observations do not exclude an earlier timing window or a race under other conditions. The deterministic failure was not reproduced at this head. This change should be described as startup-baseline hardening, not as a demonstrated deterministic-flake fix.

Draft length: 865 characters, excluding this label. Plain sentences; no em dashes, prohibited wording, model/tool attribution, reviewer names, home path, or machine name.

## Restoration and audit

`git checkout -- .` returned 0. The two temporary worktree helper scripts were moved into the evidence directory, not deleted. Final `git status --porcelain` was empty and `git diff --quiet` returned 0. HEAD remained the exact detached head above. The probe was not committed.

[final-audit.log](final-audit.log) verifies the exact head, no staged or unstaged tracked changes, permitted final status, the four-line baseline patch, 30 complete run records, 25 unique finite samples, and absent CPU burners. Dependencies and ignored build caches from the requested installation/test commands remain; no unrelated worktree was used.

| Setup / audit command | Exit | Evidence |
|---|---:|---|
| `git show 7d0098415ba17bf1f21af2cf6ff5977bb8415f86 --stat` | 0 | [head-stat.log](head-stat.log) |
| `gh pr view 122981 --repo openclaw/openclaw --json body --jq .body` | 0 | [pr-body.log](pr-body.log) |
| `pnpm install --frozen-lockfile` | 0 | [install.log](install.log) |
| `git checkout -- src/gateway/gateway.test.ts` | 0 | [baseline-restore.exit](baseline-restore.exit) |
| `git diff --quiet` after baseline restore | 0 | [baseline-restored-diff.exit](baseline-restored-diff.exit) |
| `node <HOME>/Desktop/oss/handoff/hunt-0904/oc-c1/p122981/audit-probe.mjs` | 0 | [probe-audit.log](probe-audit.log) |
| `git diff --check` with probe | 0 | [probe-diff-check.exit](probe-diff-check.exit) |
| `bash -n <HOME>/Desktop/oss/handoff/hunt-0904/oc-c1/p122981/proof-cpu.sh <HOME>/Desktop/oss/handoff/hunt-0904/oc-c1/p122981/proof-batch.sh` | 0 | [scripts-syntax.exit](scripts-syntax.exit) |
| `git checkout -- .` | 0 | [final-restore.exit](final-restore.exit) |
| `mv <HOME>/Desktop/oss/<WORKTREE>/proof-122981-run.sh <HOME>/Desktop/oss/<WORKTREE>/proof-122981-baseline.sh <HOME>/Desktop/oss/handoff/hunt-0904/oc-c1/p122981/` | 0 | [archive-helpers.exit](archive-helpers.exit) |
| `git status --porcelain` | 0 | [final-status.log](final-status.log) |
| `git diff --quiet` after final restore | 0 | [final-diff.exit](final-diff.exit) |
| `git rev-parse HEAD` | 0 | [final-head.log](final-head.log) |
| `node <HOME>/Desktop/oss/handoff/hunt-0904/oc-c1/p122981/audit-final.mjs` | 0 | [final-audit.log](final-audit.log) |
| `node <HOME>/Desktop/oss/handoff/hunt-0904/oc-c1/p122981/summarize.mjs` | 0 | [summary.json](summary.json) |

Broader `pnpm build && pnpm check && pnpm test` was not run: this was the requested bounded timing-evidence matrix, and there is no retained source change. The requested launcher performed its automatic runtime build. No terminal screenshot was captured; text logs and timestamped counter records are the evidence.

## Appendix A: every test command and exit

All commands ran from the single worktree above, with the normal inherited HOME. Absolute paths in this local report identify artifacts; the redacted copies replace the home directory and machine name. The CPU script wraps the same full-file command and returns its captured exit status.

| Run | Exact command | Exit |
|---|---|---:|
| [unpatched-1](unpatched-1.command) | `node scripts/run-vitest.mjs src/gateway/gateway.test.ts` | 0 |
| [unpatched-2](unpatched-2.command) | `node scripts/run-vitest.mjs src/gateway/gateway.test.ts` | 0 |
| [unpatched-3](unpatched-3.command) | `node scripts/run-vitest.mjs src/gateway/gateway.test.ts` | 0 |
| [unpatched-4](unpatched-4.command) | `node scripts/run-vitest.mjs src/gateway/gateway.test.ts` | 0 |
| [unpatched-5](unpatched-5.command) | `node scripts/run-vitest.mjs src/gateway/gateway.test.ts` | 0 |
| [probe-full-1](probe-full-1.command) | `env P122981_RUN_ID=probe-full-1 node scripts/run-vitest.mjs src/gateway/gateway.test.ts` | 0 |
| [probe-full-2](probe-full-2.command) | `env P122981_RUN_ID=probe-full-2 node scripts/run-vitest.mjs src/gateway/gateway.test.ts` | 0 |
| [probe-full-3](probe-full-3.command) | `env P122981_RUN_ID=probe-full-3 node scripts/run-vitest.mjs src/gateway/gateway.test.ts` | 0 |
| [probe-full-4](probe-full-4.command) | `env P122981_RUN_ID=probe-full-4 node scripts/run-vitest.mjs src/gateway/gateway.test.ts` | 0 |
| [probe-full-5](probe-full-5.command) | `env P122981_RUN_ID=probe-full-5 node scripts/run-vitest.mjs src/gateway/gateway.test.ts` | 0 |
| [probe-full-6](probe-full-6.command) | `env P122981_RUN_ID=probe-full-6 node scripts/run-vitest.mjs src/gateway/gateway.test.ts` | 0 |
| [probe-full-7](probe-full-7.command) | `env P122981_RUN_ID=probe-full-7 node scripts/run-vitest.mjs src/gateway/gateway.test.ts` | 0 |
| [probe-full-8](probe-full-8.command) | `env P122981_RUN_ID=probe-full-8 node scripts/run-vitest.mjs src/gateway/gateway.test.ts` | 0 |
| [probe-full-9](probe-full-9.command) | `env P122981_RUN_ID=probe-full-9 node scripts/run-vitest.mjs src/gateway/gateway.test.ts` | 0 |
| [probe-full-10](probe-full-10.command) | `env P122981_RUN_ID=probe-full-10 node scripts/run-vitest.mjs src/gateway/gateway.test.ts` | 0 |
| [probe-isolated-1](probe-isolated-1.command) | `env P122981_RUN_ID=probe-isolated-1 node scripts/run-vitest.mjs src/gateway/gateway.test.ts -t does\ not\ reload\ workspace\ plugins\ when\ POST\ /tools/invoke\ rebuilds\ tools\ for\ the\ same\ workspace` | 0 |
| [probe-isolated-2](probe-isolated-2.command) | `env P122981_RUN_ID=probe-isolated-2 node scripts/run-vitest.mjs src/gateway/gateway.test.ts -t does\ not\ reload\ workspace\ plugins\ when\ POST\ /tools/invoke\ rebuilds\ tools\ for\ the\ same\ workspace` | 0 |
| [probe-isolated-3](probe-isolated-3.command) | `env P122981_RUN_ID=probe-isolated-3 node scripts/run-vitest.mjs src/gateway/gateway.test.ts -t does\ not\ reload\ workspace\ plugins\ when\ POST\ /tools/invoke\ rebuilds\ tools\ for\ the\ same\ workspace` | 0 |
| [probe-isolated-4](probe-isolated-4.command) | `env P122981_RUN_ID=probe-isolated-4 node scripts/run-vitest.mjs src/gateway/gateway.test.ts -t does\ not\ reload\ workspace\ plugins\ when\ POST\ /tools/invoke\ rebuilds\ tools\ for\ the\ same\ workspace` | 0 |
| [probe-isolated-5](probe-isolated-5.command) | `env P122981_RUN_ID=probe-isolated-5 node scripts/run-vitest.mjs src/gateway/gateway.test.ts -t does\ not\ reload\ workspace\ plugins\ when\ POST\ /tools/invoke\ rebuilds\ tools\ for\ the\ same\ workspace` | 0 |
| [probe-isolated-6](probe-isolated-6.command) | `env P122981_RUN_ID=probe-isolated-6 node scripts/run-vitest.mjs src/gateway/gateway.test.ts -t does\ not\ reload\ workspace\ plugins\ when\ POST\ /tools/invoke\ rebuilds\ tools\ for\ the\ same\ workspace` | 0 |
| [probe-isolated-7](probe-isolated-7.command) | `env P122981_RUN_ID=probe-isolated-7 node scripts/run-vitest.mjs src/gateway/gateway.test.ts -t does\ not\ reload\ workspace\ plugins\ when\ POST\ /tools/invoke\ rebuilds\ tools\ for\ the\ same\ workspace` | 0 |
| [probe-isolated-8](probe-isolated-8.command) | `env P122981_RUN_ID=probe-isolated-8 node scripts/run-vitest.mjs src/gateway/gateway.test.ts -t does\ not\ reload\ workspace\ plugins\ when\ POST\ /tools/invoke\ rebuilds\ tools\ for\ the\ same\ workspace` | 0 |
| [probe-isolated-9](probe-isolated-9.command) | `env P122981_RUN_ID=probe-isolated-9 node scripts/run-vitest.mjs src/gateway/gateway.test.ts -t does\ not\ reload\ workspace\ plugins\ when\ POST\ /tools/invoke\ rebuilds\ tools\ for\ the\ same\ workspace` | 0 |
| [probe-isolated-10](probe-isolated-10.command) | `env P122981_RUN_ID=probe-isolated-10 node scripts/run-vitest.mjs src/gateway/gateway.test.ts -t does\ not\ reload\ workspace\ plugins\ when\ POST\ /tools/invoke\ rebuilds\ tools\ for\ the\ same\ workspace` | 0 |
| [probe-cpu-1](probe-cpu-1.command) | `env P122981_RUN_ID=probe-cpu-1 bash <HOME>/Desktop/oss/handoff/hunt-0904/oc-c1/p122981/proof-cpu.sh node scripts/run-vitest.mjs src/gateway/gateway.test.ts` | 0 |
| [probe-cpu-2](probe-cpu-2.command) | `env P122981_RUN_ID=probe-cpu-2 bash <HOME>/Desktop/oss/handoff/hunt-0904/oc-c1/p122981/proof-cpu.sh node scripts/run-vitest.mjs src/gateway/gateway.test.ts` | 0 |
| [probe-cpu-3](probe-cpu-3.command) | `env P122981_RUN_ID=probe-cpu-3 bash <HOME>/Desktop/oss/handoff/hunt-0904/oc-c1/p122981/proof-cpu.sh node scripts/run-vitest.mjs src/gateway/gateway.test.ts` | 0 |
| [probe-cpu-4](probe-cpu-4.command) | `env P122981_RUN_ID=probe-cpu-4 bash <HOME>/Desktop/oss/handoff/hunt-0904/oc-c1/p122981/proof-cpu.sh node scripts/run-vitest.mjs src/gateway/gateway.test.ts` | 0 |
| [probe-cpu-5](probe-cpu-5.command) | `env P122981_RUN_ID=probe-cpu-5 bash <HOME>/Desktop/oss/handoff/hunt-0904/oc-c1/p122981/proof-cpu.sh node scripts/run-vitest.mjs src/gateway/gateway.test.ts` | 0 |

## Evidence bundle

[summary.json](summary.json) contains each command, exit, relevant output lines, run start/finish timestamps, sample, distribution, and duplicate-ID check. [probe-samples.jsonl](probe-samples.jsonl) retains the raw counter measurements at full precision. The redacted directory also contains full logs, patches, run scripts, and audits. Raw local originals remain alongside that directory. Redaction replaces the current home directory and machine names and strips terminal color escapes; it is not a general secret-sanitization certification.

The testing and test-audit guidance kept the matrix on the real launcher and retained failures as evidence; documentation guidance kept observed results, limitations, and the proposed wording separate. This local audit does not replace the requested independent evidence check.

