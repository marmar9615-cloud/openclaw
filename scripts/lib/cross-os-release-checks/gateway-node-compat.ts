import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "../../../packages/normalization-core/src/record-coerce.ts";
import {
  buildGatewayNodeCompatCaseId,
  canonicalizeGatewayNodeCompatEvidence,
} from "../../gateway-node-compat-evidence.mjs";
import {
  readBoundedRegularFile,
  validateActionsArtifactBinding,
  validateActionsArtifactProducerJob,
  type ArtifactBinding,
} from "../actions-artifact-archive.mjs";
import type { ParsedArgs } from "./config.ts";
import { readInstalledMetadata } from "./install.ts";
import { runManagedContainer } from "./managed-container.ts";

const NODE_IMAGE =
  "node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d";
const WORKFLOW_PATH = ".github/workflows/openclaw-cross-os-release-checks-reusable.yml";
const PRODUCER_JOB_NAMES = new Set(["prepare", "cross_os_release_checks / prepare"]);
const ACTIONS_JOBS_PAGE_LIMIT = 10;
const ACTIONS_JOBS_PER_PAGE = 100;
const CASE_RUNNER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../gateway-node-compat-case.ts",
);

type RuntimeId = "baseline" | "candidate";
type Architecture = "arm64" | "x64";
type PackageSelection = {
  actionsArtifact: {
    id: number;
    name: string;
    digest: string;
    sizeBytes: number;
    runId: string;
    runAttempt: number;
  };
  fileName: string;
  sha256: string;
  sourceSha: string | null;
  tgzPath: string;
  version: string;
};
type RuntimeBinding = ReturnType<typeof readRuntimeBinding>;
type CompatCase = {
  caseId: string;
  direction: string;
  gateway: RuntimeId;
  node: RuntimeId;
  outcome: "passed" | "protocol-mismatch";
};

export async function runGatewayNodeCompatProducer(args: ParsedArgs, env = process.env) {
  const architecture = resolveArchitecture(process.arch);
  if (env.GATEWAY_NODE_COMPAT_EXPECTED_ARCH !== architecture) {
    throw new Error("Gateway/node compatibility runner architecture does not match its matrix.");
  }
  const outputDir = resolveRequiredPath(args, "gateway-node-compat-output-dir");
  mkdirSync(outputDir, { recursive: true });
  const candidate = readPackageSelection(args, "candidate");
  const baseline = readPackageSelection(args, "compat-baseline");
  if (baseline.version !== "2026.5.7") {
    throw new Error("Gateway/node compatibility baseline must be openclaw@2026.5.7.");
  }
  const producer = readProducer(env);
  const producerJobName = resolveGatewayNodeCompatProducerJobName(
    args["gateway-node-compat-producer-job-name"],
  );
  validateCurrentRunArtifact(candidate, args, "candidate", producer, producerJobName);
  validateCurrentRunArtifact(baseline, args, "compat-baseline", producer, producerJobName);

  const workDir = mkdtempSync(join(tmpdir(), "openclaw-gateway-node-compat-"));
  const preparedDir = join(workDir, "prepared");
  const casesDir = join(workDir, "cases");
  const logsDir = join(outputDir, "logs");
  mkdirSync(preparedDir, { recursive: true });
  try {
    await prepareRuntimes({
      baseline,
      candidate,
      logPath: join(logsDir, "prepare.log"),
      preparedDir,
    });
    const bindings = {
      baseline: readRuntimeBinding("baseline", preparedDir, baseline),
      candidate: readRuntimeBinding("candidate", preparedDir, candidate),
    };
    for (const compatCase of buildCases(architecture)) {
      const caseDir = join(casesDir, compatCase.caseId);
      mkdirSync(caseDir, { recursive: true });
      const inputPath = join(caseDir, "input.json");
      const resultPath = join(caseDir, "result.json");
      writeFileSync(inputPath, `${JSON.stringify(compatCase)}\n`, {
        encoding: "utf8",
        mode: 0o644,
      });
      await runManagedContainer({
        name: `openclaw-gateway-node-compat-${compatCase.caseId}-${randomBytes(6).toString("hex")}`,
        logPath: join(logsDir, `${compatCase.caseId}.log`),
        timeoutMs: 5 * 60_000,
        args: buildCaseContainerArgs({ architecture, caseDir, inputPath, preparedDir }),
      });
      const result = parseCaseResult(
        readBoundedRegularFile(resultPath, {
          label: `${compatCase.caseId} result`,
          maxBytes: 64 * 1024,
        }),
        architecture,
      );
      validateCaseProtocolContract(compatCase, result);
      const evidence = buildEvidence({
        architecture,
        bindings,
        compatCase,
        producer,
        result,
      });
      const serialized = canonicalizeGatewayNodeCompatEvidence(evidence);
      const destination = join(outputDir, `${compatCase.caseId}.json`);
      const temporary = `${destination}.tmp-${randomBytes(8).toString("hex")}`;
      writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, destination);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export function buildCases(
  architecture: Architecture = resolveArchitecture(process.arch),
): CompatCase[] {
  return (
    [
      ["candidate-gateway-candidate-node", "candidate", "candidate", "passed"],
      ["candidate-gateway-baseline-node", "candidate", "baseline", "passed"],
      ["baseline-gateway-candidate-node", "baseline", "candidate", "passed"],
      ["baseline-gateway-baseline-node", "baseline", "baseline", "passed"],
      ["candidate-gateway-disjoint-node", "candidate", "candidate", "protocol-mismatch"],
      ["baseline-gateway-disjoint-node", "baseline", "candidate", "protocol-mismatch"],
    ] as const
  ).map(([direction, gateway, node, outcome]) => ({
    caseId: buildGatewayNodeCompatCaseId({ architecture, direction, kind: "linux" }),
    direction,
    gateway,
    node,
    outcome,
  }));
}

function readPackageSelection(args: ParsedArgs, prefix: string): PackageSelection {
  const tgzPath = resolveRequiredPath(args, `${prefix}-tgz`);
  const metadata = readJsonFile(resolveRequiredPath(args, `${prefix}-artifact-metadata`));
  const artifact: Record<string, unknown> = isRecord(metadata) ? metadata : {};
  const id = requirePositiveInteger(artifact.id, `${prefix} artifact id`);
  const sizeBytes = requirePositiveInteger(artifact.size_in_bytes, `${prefix} artifact size`);
  const name = requireString(artifact.name, `${prefix} artifact name`);
  const digest = requirePattern(
    artifact.digest,
    `${prefix} artifact digest`,
    /^sha256:[a-f0-9]{64}$/u,
  );
  return {
    actionsArtifact: {
      id,
      name,
      digest,
      sizeBytes,
      runId: requirePattern(
        args[`${prefix}-artifact-run-id`],
        `${prefix} run id`,
        /^[1-9][0-9]*$/u,
      ),
      runAttempt: requirePositiveInteger(
        Number(args[`${prefix}-artifact-run-attempt`]),
        `${prefix} run attempt`,
      ),
    },
    fileName: basename(tgzPath),
    sha256: requirePattern(args[`${prefix}-sha256`], `${prefix} sha256`, /^[a-f0-9]{64}$/u),
    sourceSha:
      args[`${prefix}-source-sha`] === ""
        ? null
        : requirePattern(args[`${prefix}-source-sha`], `${prefix} source sha`, /^[a-f0-9]{40}$/u),
    tgzPath,
    version: requireString(args[`${prefix}-version`], `${prefix} version`),
  };
}

function readProducer(env: NodeJS.ProcessEnv) {
  return {
    repository: requirePattern(
      env.GITHUB_REPOSITORY,
      "GITHUB_REPOSITORY",
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
    ),
    workflowSha: requirePattern(
      env.GATEWAY_NODE_COMPAT_WORKFLOW_SHA,
      "GATEWAY_NODE_COMPAT_WORKFLOW_SHA",
      /^[a-f0-9]{40}$/u,
    ),
    runSha: requirePattern(env.GITHUB_SHA, "GITHUB_SHA", /^[a-f0-9]{40}$/u),
    runWorkflowPath: parseWorkflowPath(
      requireString(
        env.GATEWAY_NODE_COMPAT_RUN_WORKFLOW_REF,
        "GATEWAY_NODE_COMPAT_RUN_WORKFLOW_REF",
      ),
      requirePattern(
        env.GITHUB_REPOSITORY,
        "GITHUB_REPOSITORY",
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
      ),
    ),
    runId: requirePattern(env.GITHUB_RUN_ID, "GITHUB_RUN_ID", /^[1-9][0-9]*$/u),
    runAttempt: requirePositiveInteger(Number(env.GITHUB_RUN_ATTEMPT), "GITHUB_RUN_ATTEMPT"),
    job: requireString(env.GITHUB_JOB, "GITHUB_JOB"),
    workflowEvent: requireString(env.GITHUB_EVENT_NAME, "GITHUB_EVENT_NAME"),
    workflowHeadBranch: requireString(
      env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME,
      "GitHub head branch",
    ),
  };
}

function validateCurrentRunArtifact(
  selection: PackageSelection,
  args: ParsedArgs,
  prefix: string,
  producer: ReturnType<typeof readProducer>,
  producerJobName: string,
) {
  if (!isCurrentRunArtifact(selection.actionsArtifact, producer)) {
    throw new Error(`${prefix} artifact must come from the current workflow run attempt.`);
  }
  if (sha256File(selection.tgzPath) !== selection.sha256) {
    throw new Error(`${prefix} package SHA-256 mismatch.`);
  }
  const workflowRun = readJsonFile(resolveRequiredPath(args, `${prefix}-workflow-run-metadata`));
  const workflowJobs = readWorkflowJobsMetadata(
    resolveRequiredPath(args, `${prefix}-workflow-jobs-metadata`),
  );
  const expected: ArtifactBinding = {
    artifactDigest: `sha256:${requirePattern(
      args[`${prefix}-artifact-digest`],
      `${prefix} artifact digest`,
      /^[a-f0-9]{64}$/u,
    )}`,
    artifactId: selection.actionsArtifact.id,
    artifactName: selection.actionsArtifact.name,
    artifactSizeBytes: selection.actionsArtifact.sizeBytes,
    consumerRunAttempt: producer.runAttempt,
    producerJobName,
    repository: producer.repository,
    runStatePolicy: "same-run-producer-success",
    runAttempt: selection.actionsArtifact.runAttempt,
    runId: Number(selection.actionsArtifact.runId),
    workflowEvent: producer.workflowEvent,
    workflowHeadBranch: producer.workflowHeadBranch,
    workflowPath: producer.runWorkflowPath,
    workflowSha: producer.runSha,
  };
  validateActionsArtifactBinding({
    artifactMetadata: readJsonFile(resolveRequiredPath(args, `${prefix}-artifact-metadata`)),
    expected,
    workflowRun,
  });
  validateActionsArtifactProducerJob({ expected, workflowJobs });
}

export function resolveGatewayNodeCompatProducerJobName(value: unknown) {
  const producerJobName = requireString(value, "gateway-node-compat-producer-job-name");
  if (!PRODUCER_JOB_NAMES.has(producerJobName)) {
    throw new Error("Gateway/node compatibility producer job name is not approved.");
  }
  return producerJobName;
}

async function prepareRuntimes(params: {
  baseline: PackageSelection;
  candidate: PackageSelection;
  logPath: string;
  preparedDir: string;
}) {
  await runManagedContainer({
    name: `openclaw-gateway-node-compat-prepare-${process.pid}`,
    logPath: params.logPath,
    timeoutMs: 30 * 60_000,
    args: [
      "--network",
      "bridge",
      "--user",
      containerUser(),
      "--mount",
      `type=bind,src=${params.candidate.tgzPath},dst=/input/candidate.tgz,readonly`,
      "--mount",
      `type=bind,src=${params.baseline.tgzPath},dst=/input/baseline.tgz,readonly`,
      "--mount",
      `type=bind,src=${params.preparedDir},dst=/prepared`,
      NODE_IMAGE,
      "sh",
      "-euc",
      [
        "export HOME=/tmp npm_config_cache=/tmp/npm-cache",
        "npm install --global --prefix /prepared/candidate --ignore-scripts /input/candidate.tgz",
        "npm install --global --prefix /prepared/baseline --ignore-scripts /input/baseline.tgz",
      ].join("\n"),
    ],
  });
}

function readRuntimeBinding(id: RuntimeId, preparedDir: string, selection: PackageSelection) {
  const prefix = join(preparedDir, id);
  const installed = readInstalledMetadata(prefix);
  const sourceSha = selection.sourceSha ?? installed.commit;
  if (
    installed.version !== selection.version ||
    !sourceSha ||
    (selection.sourceSha !== null && installed.commit !== sourceSha)
  ) {
    throw new Error(`${id} installed runtime identity does not match its package tuple.`);
  }
  return {
    packagedArtifact: {
      version: selection.version,
      sourceSha,
      name: selection.fileName,
      sha256: selection.sha256,
      actionsArtifact: selection.actionsArtifact,
    },
    installedRuntime: {
      version: installed.version,
      sourceSha,
      packageSha256: selection.sha256,
      identitySha256: sha256RuntimeTree(prefix),
    },
  };
}

export function buildCaseContainerArgs(params: {
  architecture: Architecture;
  caseDir: string;
  inputPath: string;
  preparedDir: string;
}) {
  return [
    "--network",
    "none",
    "--read-only",
    "--cpus",
    "2",
    "--memory",
    "2g",
    "--memory-swap",
    "2g",
    "--pids-limit",
    "256",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "SETUID",
    "--cap-add",
    "SETGID",
    "--cap-add",
    "DAC_OVERRIDE",
    "--cap-add",
    "CHOWN",
    "--cap-add",
    "KILL",
    "--security-opt",
    "no-new-privileges:true",
    "--user",
    "0:0",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=256m",
    "--mount",
    `type=bind,src=${params.preparedDir},dst=/runtimes,readonly`,
    "--mount",
    `type=bind,src=${CASE_RUNNER_PATH},dst=/case.ts,readonly`,
    "--mount",
    `type=bind,src=${resolveTrustedWsPath()},dst=/node_modules/ws,readonly`,
    "--mount",
    `type=bind,src=${params.inputPath},dst=/input.json,readonly`,
    "--mount",
    `type=bind,src=${params.caseDir},dst=/out`,
    "--env",
    `OPENCLAW_GATEWAY_NODE_ARCH=${params.architecture}`,
    NODE_IMAGE,
    "node",
    "--experimental-strip-types",
    "/case.ts",
    "/input.json",
    "/out/result.json",
  ];
}

function resolveTrustedWsPath() {
  return dirname(createRequire(import.meta.url).resolve("ws/package.json"));
}

export function parseCaseResult(
  bytes: Buffer,
  expectedArchitecture: Architecture,
): Record<string, unknown> {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isRecord(value) || !isRecord(value.observation)) {
    throw new Error("Gateway/node compatibility case result is invalid.");
  }
  const identity = isRecord(value.observation.identity) ? value.observation.identity : {};
  if (value.architecture !== expectedArchitecture) {
    throw new Error("Case result does not match the container architecture.");
  }
  if (
    identity.role !== "node" ||
    identity.mode !== "node" ||
    identity.clientId !== "node-host" ||
    identity.platform !== "linux"
  ) {
    throw new Error("Observed connect identity is not a Linux node-host session.");
  }
  return value;
}

export function validateCaseProtocolContract(
  compatCase: Pick<CompatCase, "gateway" | "node" | "outcome">,
  result: Record<string, unknown>,
) {
  const observation = isRecord(result.observation) ? result.observation : {};
  const expectedGatewayProtocol = compatCase.gateway === "candidate" ? 4 : 3;
  if (compatCase.outcome === "protocol-mismatch") {
    const mismatch = isRecord(result.mismatch) ? result.mismatch : {};
    if (
      observation.clientMin !== 1 ||
      observation.clientMax !== 2 ||
      mismatch.expectedProtocol !== expectedGatewayProtocol
    ) {
      throw new Error("Disjoint compatibility case does not match the exact 1..2 contract.");
    }
    return result;
  }
  const expectedNodeRange = compatCase.node === "candidate" ? [3, 4] : [3, 3];
  const expectedNegotiatedProtocol =
    compatCase.gateway === "candidate" && compatCase.node === "candidate" ? 4 : 3;
  if (
    observation.clientMin !== expectedNodeRange[0] ||
    observation.clientMax !== expectedNodeRange[1] ||
    observation.helloProtocol !== expectedNegotiatedProtocol
  ) {
    throw new Error("Packaged compatibility case does not match its exact protocol contract.");
  }
  return result;
}

export function isCurrentRunArtifact(
  artifact: Pick<PackageSelection["actionsArtifact"], "runId" | "runAttempt">,
  producer: Pick<ReturnType<typeof readProducer>, "runId" | "runAttempt">,
) {
  return artifact.runId === producer.runId && artifact.runAttempt === producer.runAttempt;
}

function buildEvidence(params: {
  architecture: Architecture;
  bindings: Record<RuntimeId, RuntimeBinding>;
  compatCase: CompatCase;
  producer: ReturnType<typeof readProducer>;
  result: Record<string, unknown>;
}) {
  const observation = params.result.observation as Record<string, unknown>;
  const passed = params.compatCase.outcome === "passed";
  const mismatch: Record<string, unknown> = isRecord(params.result.mismatch)
    ? params.result.mismatch
    : {};
  const gatewayProtocolVersion = passed ? observation.helloProtocol : mismatch.expectedProtocol;
  if (!Number.isSafeInteger(gatewayProtocolVersion)) {
    throw new Error(`${params.compatCase.caseId} did not observe a Gateway protocol.`);
  }
  return {
    schema: "openclaw.gateway-node-compat/v1",
    caseId: params.compatCase.caseId,
    direction: params.compatCase.direction,
    connection: { transport: "gateway-websocket", role: "node", mode: "node" },
    gateway: params.bindings[params.compatCase.gateway],
    node: {
      kind: "linux",
      architecture: params.architecture,
      protocolClientId: "node-host",
      ...params.bindings[params.compatCase.node],
    },
    protocol: {
      gatewayProtocolVersion,
      gatewayAcceptedNodeMin: 3,
      protocolClientAdvertisedMin: observation.clientMin,
      protocolClientAdvertisedMax: observation.clientMax,
      helloProtocol: passed ? observation.helloProtocol : null,
    },
    operation: passed ? params.result.operation : null,
    result: passed
      ? {
          outcome: "passed",
          startedAt: params.result.startedAt,
          completedAt: params.result.completedAt,
        }
      : {
          outcome: "protocol-mismatch",
          failureCode: "PROTOCOL_MISMATCH",
          failurePhase: "connect",
          startedAt: params.result.startedAt,
          completedAt: params.result.completedAt,
        },
    producer: {
      repository: params.producer.repository,
      workflowPath: WORKFLOW_PATH,
      workflowSha: params.producer.workflowSha,
      runId: params.producer.runId,
      runAttempt: params.producer.runAttempt,
      job: params.producer.job,
    },
  };
}

function readJsonFile(path: string) {
  const bytes = readBoundedRegularFile(path, {
    label: basename(path),
    maxBytes: 2 * 1024 * 1024,
  });
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

function readWorkflowJobsMetadata(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) {
    return readJsonFile(path);
  }
  const entries = readdirSync(path).toSorted((left, right) => {
    const leftPage = Number(/^page-([1-9][0-9]*)\.json$/u.exec(left)?.[1] ?? 0);
    const rightPage = Number(/^page-([1-9][0-9]*)\.json$/u.exec(right)?.[1] ?? 0);
    return leftPage - rightPage;
  });
  if (
    entries.length < 1 ||
    entries.length > ACTIONS_JOBS_PAGE_LIMIT ||
    entries.some((entry, index) => entry !== `page-${index + 1}.json`)
  ) {
    throw new Error("Actions workflow job pages are missing, non-contiguous, or excessive.");
  }
  return mergeActionsWorkflowJobPages(entries.map((entry) => readJsonFile(join(path, entry))));
}

export function mergeActionsWorkflowJobPages(pages: unknown[]) {
  if (pages.length < 1 || pages.length > ACTIONS_JOBS_PAGE_LIMIT) {
    throw new Error("Actions workflow job page count is outside the approved range.");
  }
  let totalCount: number | undefined;
  const jobs: Record<string, unknown>[] = [];
  const ids = new Set<number>();
  for (const page of pages) {
    if (!isRecord(page) || !Number.isSafeInteger(page.total_count) || !Array.isArray(page.jobs)) {
      throw new Error("Actions workflow job page is invalid.");
    }
    const pageTotal = Number(page.total_count);
    if (
      pageTotal < 0 ||
      pageTotal > ACTIONS_JOBS_PAGE_LIMIT * ACTIONS_JOBS_PER_PAGE ||
      page.jobs.length > ACTIONS_JOBS_PER_PAGE ||
      (totalCount !== undefined && pageTotal !== totalCount)
    ) {
      throw new Error("Actions workflow job page total is unstable or outside the approved range.");
    }
    totalCount = pageTotal;
    for (const job of page.jobs) {
      if (!isRecord(job) || !Number.isSafeInteger(job.id) || Number(job.id) < 1) {
        throw new Error("Actions workflow job entry is invalid.");
      }
      const id = Number(job.id);
      if (ids.has(id)) {
        throw new Error("Actions workflow job inventory contains a duplicate job id.");
      }
      ids.add(id);
      jobs.push(job);
    }
  }
  if (totalCount === undefined || jobs.length !== totalCount) {
    throw new Error("Actions workflow jobs inventory is incomplete.");
  }
  return { total_count: totalCount, jobs };
}

function sha256File(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function sha256RuntimeTree(root: string) {
  const hash = createHash("sha256");
  const visit = (path: string) => {
    const relativePath = relative(root, path).split("\\").join("/");
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      hash.update(`directory\0${relativePath}\0`);
      for (const entry of readdirSync(path).toSorted((left, right) =>
        left.localeCompare(right, "en"),
      )) {
        visit(join(path, entry));
      }
      return;
    }
    if (stat.isSymbolicLink()) {
      hash.update(`symlink\0${relativePath}\0${readlinkSync(path)}\0`);
      return;
    }
    if (!stat.isFile()) {
      throw new Error(`Installed runtime contains unsupported entry: ${relativePath}`);
    }
    hash.update(`file\0${relativePath}\0${stat.mode & 0o777}\0${stat.size}\0`);
    hash.update(readFileSync(path));
    hash.update("\0");
  };
  visit(root);
  return hash.digest("hex");
}

function resolveRequiredPath(args: ParsedArgs, key: string) {
  return resolve(requireString(args[key], key));
}

function resolveArchitecture(value: string): Architecture {
  if (value === "x64" || value === "arm64") {
    return value;
  }
  throw new Error(`Gateway/node compatibility requires x64 or arm64, got ${value}.`);
}

function containerUser() {
  const uid = process.getuid?.() ?? 65532;
  const gid = process.getgid?.() ?? 65532;
  if (uid === 0 || gid === 0) {
    throw new Error("Gateway/node compatibility containers require an unprivileged runner.");
  }
  return `${uid}:${gid}`;
}

function requireString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty trimmed string.`);
  }
  return value;
}

function requirePattern(value: unknown, label: string, pattern: RegExp) {
  const normalized = requireString(value, label);
  if (!pattern.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function requirePositiveInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return Number(value);
}

function parseWorkflowPath(workflowRef: string, repository: string) {
  const prefix = `${repository}/`;
  const at = workflowRef.lastIndexOf("@");
  const path = at >= 0 ? workflowRef.slice(0, at) : workflowRef;
  if (!path.startsWith(prefix)) {
    throw new Error("GATEWAY_NODE_COMPAT_RUN_WORKFLOW_REF repository is invalid.");
  }
  const workflowPath = path.slice(prefix.length);
  if (!/^\.github\/workflows\/[A-Za-z0-9_./-]+\.ya?ml$/u.test(workflowPath)) {
    throw new Error("GATEWAY_NODE_COMPAT_RUN_WORKFLOW_REF path is invalid.");
  }
  return workflowPath;
}
