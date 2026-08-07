#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

export const GATEWAY_NODE_COMPAT_SCHEMA = "openclaw.gateway-node-compat/v1";

const MAX_INPUT_BYTES = 64 * 1024;
const SOURCE_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ACTIONS_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/u;
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/u;

const NODE_KINDS = new Set(["android", "ios", "linux", "macos", "windows"]);
const MOBILE_NODE_KINDS = new Set(["android", "ios"]);
const ARCHITECTURES = new Set(["arm64", "x64"]);
export const GATEWAY_NODE_COMPAT_CASE_CONTRACTS = Object.freeze(
  [
    ["baseline-gateway-baseline-node", "passed"],
    ["baseline-gateway-candidate-node", "passed"],
    ["baseline-gateway-disjoint-node", "protocol-mismatch"],
    ["candidate-gateway-baseline-node", "passed"],
    ["candidate-gateway-candidate-node", "passed"],
    ["candidate-gateway-disjoint-node", "protocol-mismatch"],
  ].map(([direction, outcome]) => Object.freeze({ direction, outcome })),
);
const CASE_CONTRACTS_BY_DIRECTION = new Map(
  GATEWAY_NODE_COMPAT_CASE_CONTRACTS.map((contract) => [contract.direction, contract]),
);
const OUTCOMES = new Set(GATEWAY_NODE_COMPAT_CASE_CONTRACTS.map((contract) => contract.outcome));
const NODE_CLIENT_IDS = new Map([
  ["android", "openclaw-android"],
  ["ios", "openclaw-ios"],
  ["linux", "node-host"],
  ["macos", "openclaw-macos"],
  ["windows", "node-host"],
]);
const DEVICE_INFO_SYSTEM_NAMES = new Map([
  ["android", "Android"],
  ["ios", "iOS"],
]);

function hasControlCharacter(value) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertExactKeys(value, label, requiredKeys) {
  const allowedKeys = new Set(requiredKeys);
  for (const key of requiredKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      throw new Error(`${label}.${key} is required`);
    }
    if (!descriptor.enumerable) {
      throw new Error(`${label}.${key} must be enumerable`);
    }
    if (!("value" in descriptor)) {
      throw new Error(`${label}.${key} must be a JSON data property`);
    }
    if (
      descriptor.value === undefined ||
      typeof descriptor.value === "function" ||
      typeof descriptor.value === "symbol" ||
      typeof descriptor.value === "bigint"
    ) {
      throw new Error(`${label}.${key} must be JSON representable`);
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new Error(`${label}.${String(key)} is not allowed`);
    }
  }
}

function requireString(value, label, maxLength) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    throw new Error(`${label} must be a bounded non-control string`);
  }
  return value;
}

function requireEnum(value, label, allowedValues) {
  const normalized = requireString(value, label, 128);
  if (!allowedValues.has(normalized)) {
    throw new Error(`${label} is unsupported`);
  }
  return normalized;
}

function requirePattern(value, label, pattern, maxLength) {
  const normalized = requireString(value, label, maxLength);
  if (!pattern.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function requireArtifactName(value, label) {
  const artifactName = requireString(value, label, 255);
  if (
    artifactName === "." ||
    artifactName === ".." ||
    artifactName.includes("/") ||
    artifactName.includes("\\")
  ) {
    throw new Error(`${label} must be a basename`);
  }
  return artifactName;
}

function requirePathSegment(value, label, maxLength = 100) {
  const segment = requireString(value, label, maxLength);
  if (
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    !PATH_SEGMENT_PATTERN.test(segment)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return segment;
}

function requireRepository(value) {
  const repository = requireString(value, "producer.repository", 201);
  const segments = repository.split("/");
  if (segments.length !== 2) {
    throw new Error("producer.repository is invalid");
  }
  requirePathSegment(segments[0], "producer.repository owner");
  requirePathSegment(segments[1], "producer.repository name");
  return repository;
}

function requireWorkflowPath(value) {
  const workflowPath = requireString(value, "producer.workflowPath", 255);
  if (workflowPath.includes("\\")) {
    throw new Error("producer.workflowPath is invalid");
  }
  const segments = workflowPath.split("/");
  if (
    segments.length < 3 ||
    segments[0] !== ".github" ||
    segments[1] !== "workflows" ||
    !/\.ya?ml$/u.test(segments.at(-1) ?? "")
  ) {
    throw new Error("producer.workflowPath is invalid");
  }
  for (let index = 2; index < segments.length; index += 1) {
    requirePathSegment(segments[index], `producer.workflowPath segment ${index - 1}`, 128);
  }
  return workflowPath;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function requireCanonicalTimestamp(value, label) {
  const timestamp = requireString(value, label, 32);
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== timestamp) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return parsed.valueOf();
}

function assertSerializedSize(serialized) {
  if (Buffer.byteLength(serialized, "utf8") > MAX_INPUT_BYTES) {
    throw new Error(`gateway-node compatibility evidence exceeds ${MAX_INPUT_BYTES} bytes`);
  }
}

function assertInputSize(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("gateway-node compatibility evidence must be JSON serializable");
  }
  if (serialized === undefined) {
    throw new Error("gateway-node compatibility evidence must be JSON serializable");
  }
  assertSerializedSize(serialized);
}

function validateActionsArtifact(value, label) {
  const artifact = requireObject(value, label);
  assertExactKeys(artifact, label, ["id", "name", "digest", "sizeBytes", "runId", "runAttempt"]);
  requirePositiveInteger(artifact.id, `${label}.id`);
  requireArtifactName(artifact.name, `${label}.name`);
  requirePattern(artifact.digest, `${label}.digest`, ACTIONS_DIGEST_PATTERN, 71);
  requirePositiveInteger(artifact.sizeBytes, `${label}.sizeBytes`);
  requirePattern(artifact.runId, `${label}.runId`, POSITIVE_DECIMAL_PATTERN, 32);
  requirePositiveInteger(artifact.runAttempt, `${label}.runAttempt`);
}

function validatePackagedArtifact(value, label) {
  const artifact = requireObject(value, label);
  assertExactKeys(artifact, label, ["version", "sourceSha", "name", "sha256", "actionsArtifact"]);
  requireString(artifact.version, `${label}.version`, 128);
  requirePattern(artifact.sourceSha, `${label}.sourceSha`, SOURCE_SHA_PATTERN, 40);
  requireArtifactName(artifact.name, `${label}.name`);
  requirePattern(artifact.sha256, `${label}.sha256`, SHA256_PATTERN, 64);
  validateActionsArtifact(artifact.actionsArtifact, `${label}.actionsArtifact`);
}

function validateInstalledRuntime(value, label) {
  const runtime = requireObject(value, label);
  assertExactKeys(runtime, label, ["version", "sourceSha", "packageSha256", "identitySha256"]);
  requireString(runtime.version, `${label}.version`, 128);
  requirePattern(runtime.sourceSha, `${label}.sourceSha`, SOURCE_SHA_PATTERN, 40);
  requirePattern(runtime.packageSha256, `${label}.packageSha256`, SHA256_PATTERN, 64);
  requirePattern(runtime.identitySha256, `${label}.identitySha256`, SHA256_PATTERN, 64);
}

function validateRuntimeBinding(value, label) {
  const subject = requireObject(value, label);
  assertExactKeys(subject, label, ["packagedArtifact", "installedRuntime"]);
  validatePackagedArtifact(subject.packagedArtifact, `${label}.packagedArtifact`);
  validateInstalledRuntime(subject.installedRuntime, `${label}.installedRuntime`);
  if (subject.installedRuntime.version !== subject.packagedArtifact.version) {
    throw new Error(`${label}.installedRuntime.version must match packaged artifact version`);
  }
  if (subject.installedRuntime.sourceSha !== subject.packagedArtifact.sourceSha) {
    throw new Error(`${label}.installedRuntime.sourceSha must match packaged artifact sourceSha`);
  }
  if (subject.installedRuntime.packageSha256 !== subject.packagedArtifact.sha256) {
    throw new Error(`${label}.installedRuntime.packageSha256 must match packaged artifact sha256`);
  }
}

function validateNode(value) {
  const node = requireObject(value, "node");
  assertExactKeys(node, "node", [
    "kind",
    "architecture",
    "protocolClientId",
    "packagedArtifact",
    "installedRuntime",
  ]);
  const kind = requireEnum(node.kind, "node.kind", NODE_KINDS);
  const architecture = requireEnum(node.architecture, "node.architecture", ARCHITECTURES);
  const expectedClientId = NODE_CLIENT_IDS.get(kind);
  if (node.protocolClientId !== expectedClientId) {
    throw new Error(`${kind} nodes require protocol client ${expectedClientId}`);
  }
  validateRuntimeBinding(
    {
      packagedArtifact: node.packagedArtifact,
      installedRuntime: node.installedRuntime,
    },
    "node",
  );
  return { architecture, kind };
}

function validateConnection(value) {
  const connection = requireObject(value, "connection");
  assertExactKeys(connection, "connection", ["transport", "role", "mode"]);
  if (connection.transport !== "gateway-websocket") {
    throw new Error("connection.transport must be gateway-websocket");
  }
  if (connection.role !== "node") {
    throw new Error("connection.role must be node");
  }
  if (connection.mode !== "node") {
    throw new Error("connection.mode must be node");
  }
}

function validateProtocol(value) {
  const protocol = requireObject(value, "protocol");
  assertExactKeys(protocol, "protocol", [
    "gatewayProtocolVersion",
    "gatewayAcceptedNodeMin",
    "protocolClientAdvertisedMin",
    "protocolClientAdvertisedMax",
    "helloProtocol",
  ]);
  const gatewayProtocolVersion = requirePositiveInteger(
    protocol.gatewayProtocolVersion,
    "protocol.gatewayProtocolVersion",
  );
  const gatewayAcceptedNodeMin = requirePositiveInteger(
    protocol.gatewayAcceptedNodeMin,
    "protocol.gatewayAcceptedNodeMin",
  );
  const protocolClientAdvertisedMin = requirePositiveInteger(
    protocol.protocolClientAdvertisedMin,
    "protocol.protocolClientAdvertisedMin",
  );
  const protocolClientAdvertisedMax = requirePositiveInteger(
    protocol.protocolClientAdvertisedMax,
    "protocol.protocolClientAdvertisedMax",
  );
  if (
    gatewayAcceptedNodeMin !== gatewayProtocolVersion &&
    gatewayAcceptedNodeMin !== gatewayProtocolVersion - 1
  ) {
    throw new Error(
      "protocol.gatewayAcceptedNodeMin must equal protocol.gatewayProtocolVersion or its N-1 floor",
    );
  }
  if (protocolClientAdvertisedMin > protocolClientAdvertisedMax) {
    throw new Error(
      "protocol.protocolClientAdvertisedMin must not exceed protocol.protocolClientAdvertisedMax",
    );
  }
  if (protocol.helloProtocol !== null) {
    requirePositiveInteger(protocol.helloProtocol, "protocol.helloProtocol");
  }
  return {
    gatewayAcceptedNodeMin,
    gatewayProtocolVersion,
    protocolClientAdvertisedMax,
    protocolClientAdvertisedMin,
  };
}

function validateSystemWhichParams(value) {
  const params = requireObject(value, "operation.params");
  assertExactKeys(params, "operation.params", ["bins"]);
  if (!Array.isArray(params.bins) || params.bins.length === 0 || params.bins.length > 32) {
    throw new Error("operation.params.bins must contain 1 to 32 requested binaries");
  }
  const bins = new Set();
  for (const [index, bin] of params.bins.entries()) {
    const normalized = requirePathSegment(bin, `operation.params.bins.${index}`, 128);
    if (bins.has(normalized)) {
      throw new Error("operation.params.bins must not contain duplicates");
    }
    bins.add(normalized);
  }
  return bins;
}

function validateSystemWhichResult(value, requestedBins) {
  const result = requireObject(value, "operation.result");
  assertExactKeys(result, "operation.result", ["bins"]);
  const bins = requireObject(result.bins, "operation.result.bins");
  const entries = Object.entries(bins);
  if (entries.length === 0 || entries.length > 32) {
    throw new Error("operation.result.bins must contain 1 to 32 resolved binaries");
  }
  for (const [bin, resolvedPath] of entries) {
    requirePathSegment(bin, `operation.result.bins.${bin}`, 128);
    if (!requestedBins.has(bin)) {
      throw new Error(`operation.result.bins.${bin} was not requested`);
    }
    requireString(resolvedPath, `operation.result.bins.${bin}`, 4096);
  }
}

function validateDeviceInfoParams(value) {
  const params = requireObject(value, "operation.params");
  assertExactKeys(params, "operation.params", []);
}

function validateDeviceInfoResult(value, nodeKind) {
  const result = requireObject(value, "operation.result");
  assertExactKeys(result, "operation.result", ["systemName", "systemVersion"]);
  const systemName = requireString(result.systemName, "operation.result.systemName", 128);
  const expectedSystemName = DEVICE_INFO_SYSTEM_NAMES.get(nodeKind);
  if (systemName !== expectedSystemName) {
    throw new Error(`${nodeKind} nodes require operation.result.systemName ${expectedSystemName}`);
  }
  requireString(result.systemVersion, "operation.result.systemVersion", 128);
}

function validateOperation(value, nodeKind) {
  const operation = requireObject(value, "operation");
  assertExactKeys(operation, "operation", ["method", "command", "params", "ok", "result"]);
  if (operation.method !== "node.invoke") {
    throw new Error("operation.method must be node.invoke");
  }
  if (operation.ok !== true) {
    throw new Error("operation.ok must be true");
  }

  if (MOBILE_NODE_KINDS.has(nodeKind)) {
    if (operation.command !== "device.info") {
      throw new Error(`${nodeKind} nodes require operation.command device.info`);
    }
    validateDeviceInfoParams(operation.params);
    validateDeviceInfoResult(operation.result, nodeKind);
    return;
  }

  if (operation.command !== "system.which") {
    throw new Error(`${nodeKind} nodes require operation.command system.which`);
  }
  const requestedBins = validateSystemWhichParams(operation.params);
  validateSystemWhichResult(operation.result, requestedBins);
}

function validateResult(value) {
  const result = requireObject(value, "result");
  const outcome = requireEnum(result.outcome, "result.outcome", OUTCOMES);
  if (outcome === "passed") {
    assertExactKeys(result, "result", ["outcome", "startedAt", "completedAt"]);
  } else {
    assertExactKeys(result, "result", [
      "outcome",
      "failureCode",
      "failurePhase",
      "startedAt",
      "completedAt",
    ]);
  }
  const startedAt = requireCanonicalTimestamp(result.startedAt, "result.startedAt");
  const completedAt = requireCanonicalTimestamp(result.completedAt, "result.completedAt");
  if (completedAt < startedAt) {
    throw new Error("result.completedAt must not precede result.startedAt");
  }
  return outcome;
}

function validateProducer(value) {
  const producer = requireObject(value, "producer");
  assertExactKeys(producer, "producer", [
    "repository",
    "workflowPath",
    "workflowSha",
    "runId",
    "runAttempt",
    "job",
  ]);
  requireRepository(producer.repository);
  requireWorkflowPath(producer.workflowPath);
  requirePattern(producer.workflowSha, "producer.workflowSha", SOURCE_SHA_PATTERN, 40);
  requirePattern(producer.runId, "producer.runId", POSITIVE_DECIMAL_PATTERN, 32);
  requirePositiveInteger(producer.runAttempt, "producer.runAttempt");
  requireString(producer.job, "producer.job", 128);
}

export function buildGatewayNodeCompatCaseId({ architecture, direction, kind }) {
  return `${kind}-${architecture}-${direction}`;
}

function validateCaseContract(evidence, node, outcome) {
  const caseId = requireString(evidence.caseId, "caseId", 128);
  const direction = requireString(evidence.direction, "direction", 128);
  const contract = CASE_CONTRACTS_BY_DIRECTION.get(direction);
  if (!contract) {
    throw new Error("direction is unsupported");
  }
  const expectedCaseId = buildGatewayNodeCompatCaseId({
    architecture: node.architecture,
    direction: contract.direction,
    kind: node.kind,
  });
  if (caseId !== expectedCaseId) {
    throw new Error(`caseId must be ${expectedCaseId} for direction ${contract.direction}`);
  }
  if (outcome !== contract.outcome) {
    throw new Error(`${contract.direction} requires result.outcome ${contract.outcome}`);
  }
  return contract;
}

function validateOutcomeCoupling(evidence, protocol, outcome, nodeKind) {
  // Gateway admission accepts the current protocol or the explicit N-1 node
  // floor. These are two supported versions, not a continuous numeric range.
  const advertisesAcceptedProtocol =
    (protocol.protocolClientAdvertisedMin <= protocol.gatewayProtocolVersion &&
      protocol.protocolClientAdvertisedMax >= protocol.gatewayProtocolVersion) ||
    (protocol.protocolClientAdvertisedMin <= protocol.gatewayAcceptedNodeMin &&
      protocol.protocolClientAdvertisedMax >= protocol.gatewayAcceptedNodeMin);

  if (outcome === "passed") {
    if (!advertisesAcceptedProtocol) {
      throw new Error(
        "passed evidence requires the advertised protocol range to include an accepted Gateway protocol",
      );
    }
    if (evidence.protocol.helloProtocol !== protocol.gatewayProtocolVersion) {
      throw new Error("passed evidence requires helloProtocol to equal gatewayProtocolVersion");
    }
    validateOperation(evidence.operation, nodeKind);
    return;
  }

  if (evidence.protocol.helloProtocol !== null) {
    throw new Error("protocol-mismatch evidence requires helloProtocol to be null");
  }
  if (evidence.operation !== null) {
    throw new Error("protocol-mismatch evidence requires operation to be null");
  }
  if (evidence.result.failureCode !== "PROTOCOL_MISMATCH") {
    throw new Error("protocol-mismatch evidence requires failureCode PROTOCOL_MISMATCH");
  }
  if (evidence.result.failurePhase !== "connect") {
    throw new Error("protocol-mismatch evidence requires failurePhase connect");
  }
  if (advertisesAcceptedProtocol) {
    throw new Error(
      "protocol-mismatch evidence requires the advertised protocol range to exclude accepted Gateway protocols",
    );
  }
}

/**
 * Validates one immutable, observed Gateway WebSocket node compatibility result.
 *
 * Artifact/run provenance is recorded here and independently verified by the
 * release aggregator. Outcome authority comes from the observed invoke or
 * structured connect rejection, never inferred protocol-range overlap.
 */
export function validateGatewayNodeCompatEvidence(value) {
  assertInputSize(value);
  const evidence = requireObject(value, "gateway-node compatibility evidence");
  assertExactKeys(evidence, "gateway-node compatibility evidence", [
    "schema",
    "caseId",
    "direction",
    "connection",
    "gateway",
    "node",
    "protocol",
    "operation",
    "result",
    "producer",
  ]);
  if (evidence.schema !== GATEWAY_NODE_COMPAT_SCHEMA) {
    throw new Error("gateway-node compatibility evidence schema is unsupported");
  }
  validateConnection(evidence.connection);
  validateRuntimeBinding(evidence.gateway, "gateway");
  const node = validateNode(evidence.node);
  const protocol = validateProtocol(evidence.protocol);
  const outcome = validateResult(evidence.result);
  validateProducer(evidence.producer);
  validateCaseContract(evidence, node, outcome);
  validateOutcomeCoupling(evidence, protocol, outcome, node.kind);
  assertSerializedSize(serializeCanonicalEvidence(evidence));
  return evidence;
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

function serializeCanonicalEvidence(value) {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

export function canonicalizeGatewayNodeCompatEvidence(value) {
  const evidence = validateGatewayNodeCompatEvidence(value);
  return serializeCanonicalEvidence(evidence);
}

function readEvidenceFile(filePath) {
  const pathStat = lstatSync(filePath);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error("gateway-node compatibility evidence input must be a regular file");
  }
  if (pathStat.size > MAX_INPUT_BYTES) {
    throw new Error(`gateway-node compatibility evidence exceeds ${MAX_INPUT_BYTES} bytes`);
  }

  // Nonblocking, no-follow open closes the race where the checked path is
  // replaced with a FIFO or symlink before the descriptor is acquired.
  const descriptor = openSync(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new Error("gateway-node compatibility evidence input must be a regular file");
    }
    if (stat.size > MAX_INPUT_BYTES) {
      throw new Error(`gateway-node compatibility evidence exceeds ${MAX_INPUT_BYTES} bytes`);
    }
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let totalBytes = 0;
    while (totalBytes < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, totalBytes, buffer.length - totalBytes, null);
      if (bytesRead === 0) {
        break;
      }
      totalBytes += bytesRead;
    }
    if (totalBytes > MAX_INPUT_BYTES) {
      throw new Error(`gateway-node compatibility evidence exceeds ${MAX_INPUT_BYTES} bytes`);
    }
    const input = buffer.subarray(0, totalBytes);
    let decoded;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
    } catch {
      throw new Error("gateway-node compatibility evidence must be valid UTF-8");
    }
    if (!Buffer.from(decoded, "utf8").equals(input)) {
      throw new Error("gateway-node compatibility evidence must be canonical UTF-8");
    }
    return JSON.parse(decoded);
  } finally {
    closeSync(descriptor);
  }
}

function writeEvidenceFileAtomically(filePath, content) {
  const directory = path.dirname(path.resolve(filePath));
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let descriptor;
  try {
    descriptor = openSync(tempPath, "wx", 0o600);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tempPath, filePath);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    rmSync(tempPath, { force: true });
  }
}

function parseCanonicalizeArgs(args) {
  let input;
  let output;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--input" && input === undefined) {
      input = args[++index];
    } else if (argument === "--output" && output === undefined) {
      output = args[++index];
    } else {
      throw new Error(`unknown or incomplete argument: ${argument}`);
    }
  }
  if (!input || !output) {
    throw new Error("canonicalize requires --input <file> --output <file>");
  }
  return { input, output };
}

async function main(args) {
  const [command, ...commandArgs] = args;
  if (command === "validate" && commandArgs.length === 1) {
    validateGatewayNodeCompatEvidence(readEvidenceFile(commandArgs[0]));
    console.log("valid");
    return;
  }
  if (command === "canonicalize") {
    const { input, output } = parseCanonicalizeArgs(commandArgs);
    const evidence = readEvidenceFile(input);
    const canonical = canonicalizeGatewayNodeCompatEvidence(evidence);
    writeEvidenceFileAtomically(output, canonical);
    return;
  }
  throw new Error(
    "usage: gateway-node-compat-evidence.mjs validate <file> | canonicalize --input <file> --output <file>",
  );
}

function formatCliError(error) {
  const message = error instanceof Error ? error.message : String(error);
  let formatted = "";
  // Validation errors can echo hostile JSON keys, so strip terminal controls before stderr.
  for (const character of message) {
    const codePoint = character.codePointAt(0) ?? 0;
    const replacement =
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
        ? " "
        : character;
    if (formatted.length + replacement.length > 512) {
      break;
    }
    formatted += replacement;
  }
  return formatted;
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  await main(process.argv.slice(2)).catch((/** @type {unknown} */ error) => {
    console.error(formatCliError(error));
    process.exitCode = 1;
  });
}
