import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  consumeOneTimeObserverCredential,
  normalizeMismatch,
  validateDisjointObserverConnect,
  validateObserverConnectCredential,
  validateObservedIdentity,
} from "../../scripts/gateway-node-compat-case.ts";
import {
  buildCaseContainerArgs,
  buildCases,
  isCurrentRunArtifact,
  mergeActionsWorkflowJobPages,
  parseCaseResult,
  resolveGatewayNodeCompatProducerJobName,
  sha256RuntimeTree,
  validateCaseProtocolContract,
} from "../../scripts/lib/cross-os-release-checks/gateway-node-compat.ts";
import { runManagedContainer } from "../../scripts/lib/cross-os-release-checks/managed-container.ts";

const validObservation = {
  clientMin: 1,
  clientMax: 2,
  helloProtocol: null,
  identity: {
    clientId: "node-host",
    mode: "node",
    platform: "linux",
    role: "node",
  },
  protocolError: null,
};

describe("Gateway/node Linux compatibility producer", () => {
  it.each(["x64", "arm64"] as const)("defines all six %s contracts", (architecture) => {
    const cases = buildCases(architecture);
    expect(cases).toHaveLength(6);
    expect(new Set(cases.map((entry) => entry.caseId)).size).toBe(6);
    expect(cases.map((entry) => [entry.direction, entry.outcome])).toEqual([
      ["candidate-gateway-candidate-node", "passed"],
      ["candidate-gateway-baseline-node", "passed"],
      ["baseline-gateway-candidate-node", "passed"],
      ["baseline-gateway-baseline-node", "passed"],
      ["candidate-gateway-disjoint-node", "protocol-mismatch"],
      ["baseline-gateway-disjoint-node", "protocol-mismatch"],
    ]);
    expect(cases.every((entry) => entry.caseId.startsWith(`linux-${architecture}-`))).toBe(true);
  });

  it("requires artifacts from the current workflow run attempt", () => {
    const producer = { runId: "123", runAttempt: 2 };
    expect(isCurrentRunArtifact({ runId: "123", runAttempt: 2 }, producer)).toBe(true);
    expect(isCurrentRunArtifact({ runId: "122", runAttempt: 2 }, producer)).toBe(false);
    expect(isCurrentRunArtifact({ runId: "123", runAttempt: 1 }, producer)).toBe(false);
  });

  it("accepts only the direct and Full Release producer job identities", () => {
    expect(resolveGatewayNodeCompatProducerJobName("prepare")).toBe("prepare");
    expect(resolveGatewayNodeCompatProducerJobName("cross_os_release_checks / prepare")).toBe(
      "cross_os_release_checks / prepare",
    );
    for (const value of [
      "release / cross_os_release_checks / prepare",
      "other / prepare",
      "cross_os_release_checks / prepare ",
    ]) {
      expect(() => resolveGatewayNodeCompatProducerJobName(value)).toThrow();
    }
  });

  it("builds an unprivileged isolated case container with read-only runtimes", () => {
    const args = buildCaseContainerArgs({
      architecture: "arm64",
      caseDir: "/tmp/case",
      inputPath: "/tmp/case/input.json",
      preparedDir: "/tmp/prepared",
    });
    expect(args).toContain("none");
    expect(args).toContain("--read-only");
    expect(args).toContain("--cpus");
    expect(args).toContain("--memory");
    expect(args).toContain("--pids-limit");
    expect(args).toContain("ALL");
    expect(args.filter((entry) => entry === "--cap-add")).toHaveLength(5);
    expect(args).toContain("SETUID");
    expect(args).toContain("SETGID");
    expect(args).toContain("DAC_OVERRIDE");
    expect(args).toContain("CHOWN");
    expect(args).toContain("KILL");
    expect(args).toContain("no-new-privileges:true");
    expect(args).toContain("type=bind,src=/tmp/prepared,dst=/runtimes,readonly");
    expect(args.some((entry) => entry.endsWith("dst=/node_modules/ws,readonly"))).toBe(true);
    expect(args).toContain("0:0");
    expect(args).toContain("OPENCLAW_GATEWAY_NODE_ARCH=arm64");
    expect(args.join(" ")).not.toMatch(/TOKEN|SECRET|KEY/u);
  });

  it("prepares host-cleanable runtimes without root-owned bind-mount files", () => {
    const source = readFileSync(
      "scripts/lib/cross-os-release-checks/gateway-node-compat.ts",
      "utf8",
    );
    expect(source).toContain("process.getuid?.()");
    expect(source).toContain("require an unprivileged runner");
    expect(source).toContain("npm_config_cache=/tmp/npm-cache");
  });

  it("separates package-controlled processes from the trusted observer output owner", () => {
    const source = readFileSync("scripts/gateway-node-compat-case.ts", "utf8");
    expect(source).toContain("const GATEWAY_UID = 65532");
    expect(source).toContain("const NODE_UID = 65533");
    expect(source).toContain("uid: GATEWAY_UID");
    expect(source).toContain('runtimeEnv("node", node.binDir, token, NODE_UID, NODE_GID)');
    expect(source).toMatch(/children,\s+NODE_UID,\s+NODE_GID/u);
    expect(source).toContain("chownSync(home, uid, gid)");
    expect(source).toContain("CLI_OUTPUT_LIMIT_BYTES");
    expect(source.match(/mode: 0o644/g)).toHaveLength(2);
    expect(source).not.toContain('requireFromRuntime("ws")');
    expect(source.indexOf("const bootstrapNode = startNode()")).toBeLessThan(
      source.indexOf("const gatewayChild = start("),
    );
  });

  it("binds each observed node session to the bootstrapped device's one-time signature", () => {
    const gatewayToken = "gateway-token";
    const nonce = "observer-nonce";
    const signedAt = 1234;
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicKeyRaw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const deviceId = "expected-device";
    const payload = [
      "v3",
      deviceId,
      "node-host",
      "node",
      "node",
      "",
      String(signedAt),
      gatewayToken,
      nonce,
      "linux",
      "",
    ].join("|");
    const signature = sign(null, Buffer.from(payload), privateKey).toString("base64url");
    const connect = {
      id: "connect-1",
      method: "connect",
      params: {
        auth: { token: gatewayToken },
        client: { id: "node-host", mode: "node", platform: "linux" },
        device: {
          id: deviceId,
          nonce,
          publicKey: publicKeyRaw.toString("base64url"),
          signature,
          signedAt,
        },
        maxProtocol: 4,
        minProtocol: 3,
        role: "node",
        scopes: [],
      },
    };
    const usedSignatures = new Set<string>();
    const captured = validateObserverConnectCredential(connect, {
      gatewayToken,
      nonce,
      usedSignatures,
    });
    expect(captured.device).toEqual({
      id: deviceId,
      publicKey: publicKeyRaw.toString("base64url"),
    });
    expect(() =>
      validateObserverConnectCredential(connect, {
        expectedDevice: captured.device,
        gatewayToken,
        nonce,
        usedSignatures,
      }),
    ).toThrow(/reused/u);
    expect(() =>
      validateObserverConnectCredential(
        {
          ...connect,
          params: {
            ...connect.params,
            device: { ...connect.params.device, id: "forged-device" },
          },
        },
        {
          expectedDevice: captured.device,
          gatewayToken,
          nonce,
          usedSignatures: new Set(),
        },
      ),
    ).toThrow(/unexpected device identity/u);
  });

  it("authorizes exactly one supervisor-created disjoint protocol probe", () => {
    const credential = "one-time-observer-credential";
    expect(consumeOneTimeObserverCredential(credential, credential)).toBeUndefined();
    expect(() => consumeOneTimeObserverCredential(credential, undefined)).toThrow(/reused/u);
    expect(() => consumeOneTimeObserverCredential("forged", credential)).toThrow(/unauthorized/u);

    const frame = {
      id: "disjoint-connect",
      method: "connect",
      params: {
        auth: { token: "gateway-token" },
        client: { id: "node-host", mode: "node", platform: "linux" },
        maxProtocol: 2,
        minProtocol: 1,
        role: "node",
      },
    };
    expect(validateDisjointObserverConnect(frame, "gateway-token")).toMatchObject({
      clientMin: 1,
      clientMax: 2,
      identity: {
        clientId: "node-host",
        mode: "node",
        platform: "linux",
        role: "node",
      },
    });
    expect(() =>
      validateDisjointObserverConnect(
        {
          ...frame,
          params: { ...frame.params, maxProtocol: 3 },
        },
        "gateway-token",
      ),
    ).toThrow(/invalid disjoint protocol probe/u);
  });

  it("accepts the pinned baseline's exact legacy 1..2 mismatch", () => {
    expect(
      normalizeMismatch(
        {
          ...validObservation,
          protocolError: { details: { expectedProtocol: 3 } },
        },
        "2026.5.7",
      ),
    ).toEqual({
      code: "PROTOCOL_MISMATCH",
      clientMinProtocol: 1,
      clientMaxProtocol: 2,
      expectedProtocol: 3,
    });
  });

  it("accepts a structured Gateway mismatch and rejects an overstated range", () => {
    const protocolError = {
      details: {
        code: "PROTOCOL_MISMATCH",
        clientMinProtocol: 1,
        clientMaxProtocol: 2,
        expectedProtocol: 4,
      },
    };
    expect(normalizeMismatch({ ...validObservation, protocolError })).toMatchObject({
      expectedProtocol: 4,
    });
    expect(() =>
      normalizeMismatch({
        ...validObservation,
        clientMin: 2,
        protocolError,
      }),
    ).toThrow(/exact protocol range 1\.\.2/u);
    expect(() =>
      normalizeMismatch({
        ...validObservation,
        protocolError: { details: { expectedProtocol: 3 } },
      }),
    ).toThrow(/structured PROTOCOL_MISMATCH/u);
    expect(() =>
      normalizeMismatch({
        ...validObservation,
        protocolError: {
          details: {
            code: "PROTOCOL_MISMATCH",
            clientMinProtocol: 1,
            clientMaxProtocol: 2,
            expectedProtocol: 2,
          },
        },
      }),
    ).toThrow(/structured PROTOCOL_MISMATCH/u);
    expect(() =>
      normalizeMismatch(
        {
          ...validObservation,
          protocolError: { details: { expectedProtocol: 4 } },
        },
        "2026.5.7",
      ),
    ).toThrow(/structured PROTOCOL_MISMATCH/u);
  });

  it("requires the observer's Linux node identity", () => {
    expect(validateObservedIdentity(validObservation)).toBe(validObservation);
    expect(() =>
      validateObservedIdentity({
        ...validObservation,
        identity: { ...validObservation.identity, role: "operator" },
      }),
    ).toThrow(/Linux node-host/u);
  });

  it("approves device pairing before node pairing", () => {
    const source = readFileSync("scripts/gateway-node-compat-case.ts", "utf8");
    expect(source.indexOf('"devices", "list"')).toBeLessThan(source.indexOf('"nodes", "pending"'));
    expect(source).toContain("entry.nodeId === deviceId");
    expect(source).toContain("entry.nodeId === params.caseId");
    expect(source.indexOf('"devices", "approve"')).toBeLessThan(
      source.indexOf("nodeChild = params.startNode()"),
    );
    expect(source).toContain("Multiple device pairings matched ${params.caseId}.");
    expect(source).toContain('return [...args, "--json", "--url", url, "--token", token]');
  });

  it("rejects case output with a forged connect identity", () => {
    expect(() =>
      parseCaseResult(
        Buffer.from(
          JSON.stringify({
            architecture: "x64",
            observation: {
              ...validObservation,
              identity: { ...validObservation.identity, clientId: "forged" },
            },
          }),
        ),
        "x64",
      ),
    ).toThrow(/Linux node-host/u);
  });

  it("rejects evidence from a different container architecture", () => {
    expect(() =>
      parseCaseResult(
        Buffer.from(JSON.stringify({ architecture: "x64", observation: validObservation })),
        "arm64",
      ),
    ).toThrow(/container architecture/u);
  });

  it("requires the exact candidate, baseline, and disjoint protocol tuples", () => {
    for (const [gateway, node, clientMax, helloProtocol] of [
      ["candidate", "candidate", 4, 4],
      ["candidate", "baseline", 3, 3],
      ["baseline", "candidate", 4, 3],
      ["baseline", "baseline", 3, 3],
    ] as const) {
      const passed = {
        observation: {
          ...validObservation,
          clientMin: 3,
          clientMax,
          helloProtocol,
        },
      };
      expect(validateCaseProtocolContract({ gateway, node, outcome: "passed" }, passed)).toBe(
        passed,
      );
    }
    expect(() =>
      validateCaseProtocolContract(
        { gateway: "candidate", node: "candidate", outcome: "passed" },
        {
          observation: {
            ...validObservation,
            clientMax: 4,
            clientMin: 2,
            helloProtocol: 4,
          },
        },
      ),
    ).toThrow(/exact protocol contract/u);
    expect(() =>
      validateCaseProtocolContract(
        { gateway: "candidate", node: "baseline", outcome: "passed" },
        {
          observation: {
            ...validObservation,
            clientMin: 3,
            clientMax: 3,
            helloProtocol: 4,
          },
        },
      ),
    ).toThrow(/exact protocol contract/u);
    expect(
      validateCaseProtocolContract(
        { gateway: "baseline", node: "candidate", outcome: "protocol-mismatch" },
        {
          mismatch: { expectedProtocol: 3 },
          observation: { ...validObservation },
        },
      ),
    ).toMatchObject({ mismatch: { expectedProtocol: 3 } });
    expect(() =>
      validateCaseProtocolContract(
        { gateway: "candidate", node: "candidate", outcome: "protocol-mismatch" },
        {
          mismatch: { expectedProtocol: 3 },
          observation: { ...validObservation },
        },
      ),
    ).toThrow(/exact 1\.\.2 contract/u);
  });

  it("merges bounded Actions job pages with stable totals and unique ids", () => {
    const firstPage = {
      total_count: 101,
      jobs: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })),
    };
    const secondPage = { total_count: 101, jobs: [{ id: 101 }] };
    expect(mergeActionsWorkflowJobPages([firstPage, secondPage])).toMatchObject({
      total_count: 101,
      jobs: expect.arrayContaining([{ id: 1 }, { id: 101 }]),
    });
    expect(() =>
      mergeActionsWorkflowJobPages([
        firstPage,
        { total_count: 102, jobs: [{ id: 101 }, { id: 102 }] },
      ]),
    ).toThrow(/unstable/u);
    expect(() =>
      mergeActionsWorkflowJobPages([firstPage, { total_count: 101, jobs: [{ id: 100 }] }]),
    ).toThrow(/duplicate/u);
  });

  it.each([
    ["success", 0],
    ["nonzero", 7],
  ] as const)("removes the managed container after %s", async (_label, runStatus) => {
    const calls: string[][] = [];
    await runManagedContainer({
      args: ["image", "true"],
      logPath: join(process.cwd(), ".local", `managed-container-${runStatus}.log`),
      name: `openclaw-managed-test-${runStatus}`,
      timeoutMs: 1_000,
      runCommand: async ({ args }) => {
        calls.push(args ?? []);
        if (args?.[0] === "run") {
          return runStatus;
        }
        return 0;
      },
    }).catch((error: unknown) => {
      if (runStatus === 0) {
        throw error;
      }
    });
    expect(calls.find((args) => args[0] === "run")?.slice(0, 7)).toEqual([
      "run",
      "--name",
      `openclaw-managed-test-${runStatus}`,
      "--rm",
      "--log-driver",
      "none",
      "image",
    ]);
    expect(calls.some((args) => args[0] === "rm" && args[1] === "--force")).toBe(true);
    expect(calls.some((args) => args[0] === "ps" && args.includes("--quiet"))).toBe(true);
  });

  it("removes the managed container after a real runner SIGTERM", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "openclaw-managed-container-sigterm-"));
    const binDir = join(dir, "bin");
    const callsPath = join(dir, "calls.log");
    const readyPath = join(dir, "ready");
    const dockerPath = join(binDir, "docker");
    const helperUrl = pathToFileURL(
      resolve("scripts/lib/cross-os-release-checks/managed-container.ts"),
    ).href;
    mkdirSync(binDir);
    writeFileSync(
      dockerPath,
      `#!/bin/sh
set -eu
case "$1" in
  run)
    echo ready >"$OPENCLAW_TEST_READY"
    trap 'exit 143' TERM INT HUP
    while :; do sleep 1; done
    ;;
  rm|ps)
    echo "$1" >>"$OPENCLAW_TEST_CALLS"
    exit 0
    ;;
  *)
    exit 2
    ;;
esac
`,
      "utf8",
    );
    chmodSync(dockerPath, 0o755);
    const runnerScript = `
import { runManagedContainer } from ${JSON.stringify(helperUrl)};
await runManagedContainer({
  args: ["image", "true"],
  logPath: ${JSON.stringify(join(dir, "managed.log"))},
  name: "openclaw-managed-test-real-sigterm",
  timeoutMs: 60_000,
});
`;
    const runner = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", runnerScript],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          OPENCLAW_TEST_CALLS: callsPath,
          OPENCLAW_TEST_READY: readyPath,
        },
        stdio: "ignore",
      },
    );
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !readOptional(readyPath)) {
        await delay(25);
      }
      expect(readOptional(readyPath)).toBe("ready\n");
      runner.kill("SIGTERM");
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => rejectPromise(new Error("runner did not exit")), 10_000);
        runner.once("close", () => {
          clearTimeout(timer);
          resolvePromise();
        });
      });
      expect(readOptional(callsPath).trim().split("\n")).toEqual(["rm", "ps"]);
    } finally {
      if (runner.exitCode === null) {
        runner.kill("SIGKILL");
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes the managed container after timeout", async () => {
    const calls: string[][] = [];
    await expect(
      runManagedContainer({
        args: ["image", "true"],
        logPath: join(process.cwd(), ".local", "managed-container-timeout.log"),
        name: "openclaw-managed-test-timeout",
        timeoutMs: 1,
        runCommand: async ({ args }) => {
          calls.push(args ?? []);
          if (args?.[0] === "run") {
            throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
          }
          return 0;
        },
      }),
    ).rejects.toThrow(/failed/u);
    expect(calls.some((args) => args[0] === "rm" && args[1] === "--force")).toBe(true);
  });

  it("fails when container cleanup cannot be verified", async () => {
    await expect(
      runManagedContainer({
        args: ["image", "true"],
        logPath: join(process.cwd(), ".local", "managed-container-probe.log"),
        name: "openclaw-managed-test-probe",
        timeoutMs: 1_000,
        runCommand: async ({ args }) => (args?.[0] === "ps" ? 125 : 0),
      }),
    ).rejects.toThrow(/cleanup could not be verified/u);
  });

  it("consumes current-run artifacts without repacking or re-uploading them", () => {
    const workflow = parse(
      readFileSync(".github/workflows/openclaw-cross-os-release-checks-reusable.yml", "utf8"),
    ) as {
      on: {
        workflow_call: { inputs: Record<string, Record<string, unknown>> };
        workflow_dispatch: { inputs: Record<string, Record<string, unknown>> };
      };
      jobs: Record<
        string,
        {
          "continue-on-error"?: string;
          if?: string;
          "runs-on": string;
          steps: Array<Record<string, unknown>>;
          strategy: { matrix: { architecture: string[] } };
        }
      >;
    };
    const job = workflow.jobs.gateway_node_linux_compat;
    const prepare = workflow.jobs.prepare;
    expect(job.if).toBe("needs.prepare.outputs.gateway_node_compat_enabled == 'true'");
    expect(job["continue-on-error"]).toBe("${{ inputs.advisory }}");
    expect(job.strategy.matrix.architecture).toEqual(["x64", "arm64"]);
    expect(job["runs-on"]).toContain("ubuntu-24.04-arm");
    const installIndex = job.steps.findIndex(
      (step) => step.name === "Install trusted observer dependencies",
    );
    const producerIndex = job.steps.findIndex(
      (step) => step.name === "Produce six canonical compatibility cases",
    );
    expect(installIndex).toBeGreaterThan(-1);
    expect(installIndex).toBeLessThan(producerIndex);
    expect(job.steps[installIndex]?.run).toBe(
      "pnpm install --frozen-lockfile --prefer-offline --ignore-scripts",
    );
    const serialized = JSON.stringify(job);
    const executionSteps = JSON.stringify(
      job.steps.filter((step) => !String(step.uses).startsWith("actions/upload-artifact")),
    );
    expect(serialized).toContain("actions/download-artifact");
    expect(executionSteps).not.toContain("actions/upload-artifact");
    expect(executionSteps).not.toContain("npm pack");
    const producer = job.steps.find(
      (step) => step.name === "Produce six canonical compatibility cases",
    );
    expect(producer?.run).not.toContain("${{ needs.prepare.outputs");
    expect(producer?.env).not.toHaveProperty("GH_TOKEN");
    expect(producer?.env).toHaveProperty(
      "GATEWAY_NODE_COMPAT_EXPECTED_ARCH",
      "${{ matrix.architecture }}",
    );
    expect(producer?.env).toHaveProperty(
      "GATEWAY_NODE_COMPAT_PRODUCER_JOB_NAME",
      "${{ inputs.gateway_node_compat_producer_job_name }}",
    );
    expect(producer?.run).toContain(
      '--gateway-node-compat-producer-job-name "$GATEWAY_NODE_COMPAT_PRODUCER_JOB_NAME"',
    );
    expect(producer?.run).toContain('--candidate-workflow-jobs-metadata "$ROOT/metadata/jobs"');
    const provenance = job.steps.find(
      (step) => step.name === "Capture current-run artifact provenance",
    );
    expect(provenance?.run).toContain("for page in $(seq 1 10)");
    expect(provenance?.run).toContain("per_page=100&page=${page}");
    expect(provenance?.run).toContain("collected == total_count");
    const matrix = prepare.steps.find((step) => step.name === "Resolve runner matrix");
    expect(matrix?.run).toContain("--resolve-gateway-node-compat-selection true");
    expect(matrix?.run).toContain("--resolve-cross-os-release-checks-selection true");
    expect(matrix?.run).toContain("cross_os_release_checks_enabled=");
    expect(matrix?.run).toContain("gateway_node_compat_enabled=");
    expect(workflow.jobs.cross_os_release_checks.if).toBe(
      "needs.prepare.outputs.cross_os_release_checks_enabled == 'true'",
    );
    for (const trigger of ["workflow_call", "workflow_dispatch"] as const) {
      expect(workflow.on[trigger].inputs.gateway_node_compat_producer_job_name).toMatchObject({
        default: "prepare",
        type: "string",
      });
    }
    const diagnostics = job.steps.find(
      (step) => step.name === "Upload Gateway/node compatibility diagnostics",
    );
    expect(diagnostics?.if).toBe("${{ failure() }}");
    const evidenceUpload = job.steps.find(
      (step) => step.name === "Upload Gateway/node compatibility evidence",
    );
    expect(evidenceUpload?.with).toHaveProperty(
      "name",
      "openclaw-gateway-node-linux-compat-${{ matrix.architecture }}-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    for (const name of [
      "Pack Gateway compatibility baseline",
      "Upload Gateway compatibility baseline",
    ]) {
      expect(prepare.steps.find((step) => step.name === name)?.if).toBeUndefined();
    }

    const releaseWorkflow = parse(
      readFileSync(".github/workflows/openclaw-release-checks.yml", "utf8"),
    ) as {
      jobs: Record<string, { with?: Record<string, unknown> }>;
    };
    expect(
      releaseWorkflow.jobs.cross_os_release_checks.with?.gateway_node_compat_producer_job_name,
    ).toBe("cross_os_release_checks / prepare");
  });

  it("does not load Gateway compatibility dependencies for non-compat modes", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-gateway-node-loader-"));
    try {
      const loaderPath = join(dir, "reject-gateway-compat-loader.mjs");
      writeFileSync(
        loaderPath,
        `export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith("/gateway-node-compat.ts")) {
    throw new Error("Gateway compatibility module loaded outside compatibility mode");
  }
  return nextResolve(specifier, context);
}
`,
        "utf8",
      );
      const result = spawnSync(
        process.execPath,
        [
          "--loader",
          loaderPath,
          "scripts/openclaw-cross-os-release-checks.ts",
          "--resolve-matrix",
          "true",
          "--mode",
          "fresh",
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      expect(result.stderr).not.toContain(
        "Gateway compatibility module loaded outside compatibility mode",
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ include: expect.any(Array) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hashes the complete installed runtime tree deterministically", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-runtime-tree-"));
    try {
      mkdirSync(join(dir, "dist"));
      writeFileSync(join(dir, "openclaw.mjs"), "launcher\n");
      writeFileSync(join(dir, "dist", "runtime.js"), "one\n");
      const first = sha256RuntimeTree(dir);
      expect(sha256RuntimeTree(dir)).toBe(first);
      writeFileSync(join(dir, "dist", "runtime.js"), "two\n");
      expect(sha256RuntimeTree(dir)).not.toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function readOptional(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
