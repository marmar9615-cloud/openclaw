import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CONTRACT_PATH = "qa/contracts/gateway-node-platform-topologies.json";
const PLATFORM_ORDER = ["macos", "ios", "watchos", "android", "wearos", "windows"] as const;
const MAX_STRING_LENGTH = 180;

type JsonRecord = Record<string, unknown>;
type Platform = (typeof PLATFORM_ORDER)[number];
type ImplementationOwner = {
  repository: "openclaw/openclaw" | "openclaw/openclaw-windows-node";
  path: string | null;
};

const EXPECTED_IMPLEMENTATION_OWNERS: Record<Platform, readonly ImplementationOwner[]> = {
  macos: [
    {
      repository: "openclaw/openclaw",
      path: "apps/macos/Sources/OpenClaw/NodeMode/MacNodeModeCoordinator.swift",
    },
    {
      repository: "openclaw/openclaw",
      path: "apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayChannel.swift",
    },
  ],
  ios: [
    {
      repository: "openclaw/openclaw",
      path: "apps/ios/Sources/Model/NodeAppModel.swift",
    },
    {
      repository: "openclaw/openclaw",
      path: "apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayChannel.swift",
    },
  ],
  watchos: [
    {
      repository: "openclaw/openclaw",
      path: "apps/ios/WatchApp/Sources/WatchDirectNode.swift",
    },
    {
      repository: "openclaw/openclaw",
      path: "src/gateway/watch-node-http.ts",
    },
  ],
  android: [
    {
      repository: "openclaw/openclaw",
      path: "apps/android/app/src/main/java/ai/openclaw/app/gateway/GatewaySession.kt",
    },
  ],
  wearos: [
    {
      repository: "openclaw/openclaw",
      path: "apps/android/wear/src/main/java/ai/openclaw/wear/WearProxyClient.kt",
    },
    {
      repository: "openclaw/openclaw",
      path: "apps/android/app/src/main/java/ai/openclaw/app/wear/WearProxyBridge.kt",
    },
    {
      repository: "openclaw/openclaw",
      path: "apps/android/app/src/main/java/ai/openclaw/app/gateway/GatewaySession.kt",
    },
  ],
  windows: [{ repository: "openclaw/openclaw-windows-node", path: null }],
};

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function assertExactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  expect(Object.keys(value).toSorted(), `${label} keys`).toEqual([...expected].toSorted());
}

function assertBoundedString(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_STRING_LENGTH ||
    value.trim() !== value
  ) {
    throw new Error(`${label} must be a bounded trimmed string.`);
  }
}

function assertOwner(value: unknown, label: string): void {
  const owner = asRecord(value, label);
  assertExactKeys(owner, ["repository", "path"], label);
  assertBoundedString(owner.repository, `${label}.repository`);
  expect(["openclaw/openclaw", "openclaw/openclaw-windows-node"]).toContain(owner.repository);
  if (owner.repository === "openclaw/openclaw-windows-node") {
    expect(owner.path).toBeNull();
    return;
  }
  assertBoundedString(owner.path, `${label}.path`);
  expect(owner.path.startsWith("/")).toBe(false);
  expect(owner.path.includes("\\")).toBe(false);
  expect(owner.path.split("/")).not.toContain("");
  expect(owner.path.split("/")).not.toContain(".");
  expect(owner.path.split("/")).not.toContain("..");
  expect(() => execFileSync("git", ["cat-file", "-e", `HEAD:${owner.path}`])).not.toThrow();
}

function expectedTopology(platform: string): JsonRecord {
  if (platform === "watchos") {
    return {
      kind: "watch-http",
      gatewayNegotiator: "watchos",
      edges: [
        {
          from: "watchos",
          to: "gateway",
          transport: "bounded-https-challenge-connect-poll",
        },
      ],
    };
  }
  if (platform === "wearos") {
    return {
      kind: "wear-two-hop",
      gatewayNegotiator: "android-phone",
      edges: [
        {
          from: "wearos",
          to: "android-phone",
          transport: "wear-message-api-data-layer",
        },
        {
          from: "android-phone",
          to: "gateway",
          transport: "websocket",
        },
      ],
    };
  }
  return {
    kind: "direct-ws",
    gatewayNegotiator: platform,
    edges: [{ from: platform, to: "gateway", transport: "websocket" }],
  };
}

function validateInventory(value: unknown): JsonRecord {
  const inventory = asRecord(value, "platform topology inventory");
  assertExactKeys(inventory, ["kind", "platforms"], "platform topology inventory");
  expect(inventory.kind).toBe("openclaw.gateway-node-platform-topology-inventory");
  expect(Array.isArray(inventory.platforms)).toBe(true);
  const platforms = inventory.platforms as unknown[];
  expect(platforms).toHaveLength(PLATFORM_ORDER.length);

  const seenPlatforms = new Set<string>();
  platforms.forEach((rowValue, index) => {
    const row = asRecord(rowValue, `platforms[${index}]`);
    assertExactKeys(row, ["platform", "topology", "implementationOwners"], `platforms[${index}]`);
    const platform = PLATFORM_ORDER[index];
    expect(row.platform).toBe(platform);
    assertBoundedString(row.platform, `platforms[${index}].platform`);
    expect(seenPlatforms.has(row.platform)).toBe(false);
    seenPlatforms.add(row.platform);

    const topology = asRecord(row.topology, `${row.platform}.topology`);
    assertExactKeys(topology, ["kind", "gatewayNegotiator", "edges"], `${row.platform}.topology`);
    expect(topology).toEqual(expectedTopology(platform));

    expect(Array.isArray(row.implementationOwners)).toBe(true);
    const owners = row.implementationOwners as unknown[];
    owners.forEach((owner, ownerIndex) =>
      assertOwner(owner, `${row.platform}.implementationOwners[${ownerIndex}]`),
    );
    expect(owners).toEqual(EXPECTED_IMPLEMENTATION_OWNERS[platform]);
  });

  return inventory;
}

function readInventory(): { raw: string; value: JsonRecord } {
  const raw = readFileSync(CONTRACT_PATH, "utf8");
  expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(32 * 1024);
  return { raw, value: JSON.parse(raw) as JsonRecord };
}

function cloneInventory(): JsonRecord {
  return structuredClone(readInventory().value);
}

describe("Gateway/node platform topology inventory", () => {
  it("is canonical JSON with the exact six validated platform rows", () => {
    const { raw, value } = readInventory();
    expect(raw).toBe(`${JSON.stringify(value, null, 2)}\n`);
    expect(validateInventory(value)).toBe(value);
  });

  it("encodes direct, watch HTTP, and Wear two-hop topology truth", () => {
    const { platforms } = validateInventory(readInventory().value);
    const rows = platforms as JsonRecord[];
    expect(rows.map((row) => ({ platform: row.platform, topology: row.topology }))).toEqual(
      PLATFORM_ORDER.map((platform) => ({ platform, topology: expectedTopology(platform) })),
    );
  });

  it.each([
    [
      "unknown inventory field",
      (value: JsonRecord) => {
        value.proof = true;
      },
    ],
    [
      "missing platform",
      (value: JsonRecord) => {
        (value.platforms as unknown[]).pop();
      },
    ],
    [
      "duplicate platform",
      (value: JsonRecord) => {
        const rows = value.platforms as JsonRecord[];
        rows[1] = structuredClone(rows[0]);
      },
    ],
    [
      "unknown row field",
      (value: JsonRecord) => {
        (value.platforms as JsonRecord[])[0].coverage = [];
      },
    ],
    [
      "core-owned Windows implementation",
      (value: JsonRecord) => {
        (value.platforms as JsonRecord[])[5].implementationOwners = [
          { repository: "openclaw/openclaw", path: "src/node-host/runner.ts" },
        ];
      },
    ],
    [
      "duplicate implementation owner",
      (value: JsonRecord) => {
        const owners = (value.platforms as JsonRecord[])[0].implementationOwners as JsonRecord[];
        owners.push(structuredClone(owners[0]));
      },
    ],
    [
      "unrelated existing implementation owner",
      (value: JsonRecord) => {
        const owners = (value.platforms as JsonRecord[])[0].implementationOwners as JsonRecord[];
        owners[0] = {
          repository: "openclaw/openclaw",
          path: "apps/ios/Sources/Model/NodeAppModel.swift",
        };
      },
    ],
    [
      "reordered implementation owners",
      (value: JsonRecord) => {
        const owners = (value.platforms as JsonRecord[])[0].implementationOwners as JsonRecord[];
        owners.reverse();
      },
    ],
    [
      "Wear negotiating directly with Gateway",
      (value: JsonRecord) => {
        const topology = (value.platforms as JsonRecord[])[4].topology as JsonRecord;
        topology.gatewayNegotiator = "wearos";
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const value = cloneInventory();
    mutate(value);
    expect(() => validateInventory(value)).toThrow();
  });
});
