// Codex tests cover native hook relay ownership across parent and child lifecycles.
import path from "node:path";
import {
  abortAgentHarnessRun,
  invokeNativeHookRelay,
  nativeHookRelayTesting,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createEmptyPluginRegistry,
  createMockPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import {
  codexNativeHookRelayLeaseTesting,
  createCodexNativeHookRelay,
  type CodexNativePreToolUseFailure,
} from "./native-hook-relay.js";
import type { CodexServerNotification } from "./protocol.js";
import {
  createParams,
  createStartedThreadHarness,
  extractGenerationFromThreadRequest,
  extractRelayIdFromThreadRequest,
  fastWait,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();
afterEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));

const flushRelayCleanup = () => nativeHookRelayUnregisterQueue.flush();

function createDirectRelay(
  ttlMs: number,
  options: {
    signal?: AbortSignal;
    generation?: string;
    onPreToolUseFailure?: (failure: CodexNativePreToolUseFailure) => void;
  } = {},
) {
  const params = createParams(
    path.join(tempDir, "direct-relay-session.jsonl"),
    path.join(tempDir, "direct-relay-workspace"),
  );
  const relay = createCodexNativeHookRelay({
    options: { enabled: true, ttlMs },
    ...(options.generation ? { generation: options.generation } : {}),
    events: ["pre_tool_use"],
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    config: params.config,
    runId: params.runId,
    attemptTimeoutMs: 5_000,
    startupTimeoutMs: 5_000,
    turnStartTimeoutMs: 5_000,
    loopDetectionPreToolUseRelay: true,
    signal: options.signal ?? new AbortController().signal,
    onPreToolUseFailure: options.onPreToolUseFailure ?? vi.fn(),
  });
  if (!relay) {
    throw new Error("Expected native hook relay");
  }
  return relay;
}

/**
 * Codex never emits ThreadStarted for a spawned sub-agent: the spawn is announced
 * only as a `started` subAgentActivity item on the spawning thread, whose
 * `params.threadId` identifies the spawner.
 */
function spawned(
  spawnerThreadId: string,
  spawnedThreadId: string,
  kind: "started" | "interacted" | "interrupted" = "started",
): CodexServerNotification {
  return {
    method: "item/completed",
    params: {
      threadId: spawnerThreadId,
      item: {
        id: `${spawnedThreadId}-activity`,
        type: "subAgentActivity",
        agentThreadId: spawnedThreadId,
        agentPath: spawnedThreadId,
        kind,
      },
    },
  };
}

function threadStatusChanged(
  threadId: string,
  type: "idle" | "notLoaded" | "active",
): CodexServerNotification {
  return { method: "thread/status/changed", params: { threadId, status: { type } } };
}

function childTurnStarted(childThreadId: string, turnId: string): CodexServerNotification {
  return {
    method: "turn/started",
    params: {
      threadId: childThreadId,
      turn: { id: turnId, status: "inProgress", items: [], error: null },
    },
  };
}

function childTurnCompleted(params: {
  childThreadId: string;
  turnId: string;
  status: "completed" | "interrupted";
}): CodexServerNotification {
  return {
    method: "turn/completed",
    params: {
      threadId: params.childThreadId,
      turn: {
        id: params.turnId,
        status: params.status,
        items:
          params.status === "completed"
            ? [
                {
                  id: `${params.turnId}-final`,
                  type: "agentMessage",
                  phase: "final_answer",
                  text: "child done",
                },
              ]
            : [],
        error: null,
      },
    },
  };
}

function invokeChildTool(params: {
  relayId: string;
  generation: string;
  toolCallId: string;
  command?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
}) {
  return invokeNativeHookRelay({
    provider: "codex",
    relayId: params.relayId,
    generation: params.generation,
    requireGeneration: true,
    event: "pre_tool_use",
    rawPayload: {
      hook_event_name: "PreToolUse",
      tool_name: params.toolName ?? "Bash",
      tool_use_id: params.toolCallId,
      tool_input: params.toolInput ?? { command: params.command ?? "pwd" },
    },
  });
}

function getRoute(harness: ReturnType<typeof createStartedThreadHarness>) {
  const request = harness.requests.find((entry) => entry.method === "thread/start");
  return {
    relayId: extractRelayIdFromThreadRequest(request?.params),
    generation: extractGenerationFromThreadRequest(request?.params),
  };
}

describe("Codex native hook relay lifecycle", () => {
  it("renews child ownership and cancels cleanup for a late child claim", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const relay = createDirectRelay(100);
    const releaseChild = relay.acquireChild("child-thread");
    relay.releaseParent({ delay: true });
    const firstExpiry = nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(
      relay.relayId,
    )?.expiresAtMs;
    if (firstExpiry === undefined) {
      throw new Error("Expected relay registration");
    }
    await vi.advanceTimersByTimeAsync(51);
    const secondExpiry = nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(
      relay.relayId,
    )?.expiresAtMs;
    if (secondExpiry === undefined) {
      throw new Error("Expected renewed relay registration");
    }
    expect(secondExpiry).toBeGreaterThan(firstExpiry);
    await vi.advanceTimersByTimeAsync(51);
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relay.relayId)?.expiresAtMs,
    ).toBeGreaterThan(secondExpiry);
    releaseChild?.();
    await vi.advanceTimersByTimeAsync(15_001);
    expect(codexNativeHookRelayLeaseTesting.ownerCount()).toBe(0);

    const lateRelay = createDirectRelay(60_000);
    lateRelay.releaseParent({ delay: true });
    const releaseLateChild = lateRelay.acquireChild("late-child");
    flushRelayCleanup();
    await vi.advanceTimersByTimeAsync(15_001);
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(lateRelay.relayId),
    ).toBeDefined();
    releaseLateChild?.();
    await vi.advanceTimersByTimeAsync(15_001);
    expect(codexNativeHookRelayLeaseTesting.ownerCount()).toBe(0);
  });

  it("keeps policy enforcement alive after the parent completes", async () => {
    const beforeToolCall = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ block: true, blockReason: "blocked after parent completion" });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(
      createParams(
        path.join(tempDir, "parent-complete.jsonl"),
        path.join(tempDir, "parent-complete-workspace"),
      ),
      { nativeHookRelay: { enabled: true, events: ["pre_tool_use"], ttlMs: 40_000 } },
    );
    await harness.waitForMethod("turn/start");
    const route = getRoute(harness);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await harness.notify(spawned("thread-1", "child-thread"));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    await vi.advanceTimersByTimeAsync(15_001);
    await expect(
      invokeChildTool({
        ...route,
        toolCallId: "child-mcp-after-parent",
        toolName: "mcp__filesystem__read_text_file",
        toolInput: { path: "README.md" },
      }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
    const denied = await invokeChildTool({
      ...route,
      toolCallId: "child-deny-after-parent",
      command: "git push",
    });
    expect(JSON.parse(denied.stdout)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    await harness.notify(
      childTurnCompleted({
        childThreadId: "child-thread",
        turnId: "child-turn",
        status: "completed",
      }),
    );
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(route.relayId),
    ).toBeUndefined();
  });

  it("keeps child ownership after parent abort and releases on terminal", async () => {
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "abort.jsonl"), path.join(tempDir, "abort-workspace")),
      { nativeHookRelay: { enabled: true, events: ["pre_tool_use"] } },
    );
    await harness.waitForMethod("turn/start");
    const route = getRoute(harness);
    await harness.notify(spawned("thread-1", "child-after-abort"));
    expect(abortAgentHarnessRun("session-1")).toBe(true);
    expect(readAttemptTerminal(await run).aborted).toBe(true);
    await expect(
      invokeChildTool({ ...route, toolCallId: "child-after-abort", command: "pwd" }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
    await harness.notify(
      childTurnCompleted({
        childThreadId: "child-after-abort",
        turnId: "child-after-abort-turn",
        status: "completed",
      }),
    );
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(route.relayId),
    ).toBeUndefined();
  });

  it("releases a shared route only after the last child terminal", async () => {
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "multi.jsonl"), path.join(tempDir, "multi-workspace")),
      { nativeHookRelay: { enabled: true, events: ["pre_tool_use"] } },
    );
    await harness.waitForMethod("turn/start");
    const route = getRoute(harness);
    await harness.notify(spawned("thread-1", "child-a"));
    await harness.notify(spawned("thread-1", "child-b"));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    await harness.notify(
      childTurnCompleted({ childThreadId: "child-a", turnId: "turn-a", status: "completed" }),
    );
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(route.relayId),
    ).toBeDefined();
    await harness.notify(
      childTurnCompleted({ childThreadId: "child-b", turnId: "turn-b", status: "completed" }),
    );
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(route.relayId),
    ).toBeUndefined();
  });

  it("retains an interrupted child route until resumed terminal", async () => {
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(
      createParams(
        path.join(tempDir, "interrupted.jsonl"),
        path.join(tempDir, "interrupted-workspace"),
      ),
      { nativeHookRelay: { enabled: true, events: ["pre_tool_use"] } },
    );
    await harness.waitForMethod("turn/start");
    const route = getRoute(harness);
    await harness.notify(spawned("thread-1", "resumable-child"));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    await harness.notify(
      childTurnCompleted({
        childThreadId: "resumable-child",
        turnId: "interrupted-turn",
        status: "interrupted",
      }),
    );
    flushRelayCleanup();
    await expect(
      invokeChildTool({ ...route, toolCallId: "after-interrupt", command: "pwd" }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
    await harness.notify(childTurnStarted("resumable-child", "resumed-turn"));
    await harness.notify(
      childTurnCompleted({
        childThreadId: "resumable-child",
        turnId: "resumed-turn",
        status: "completed",
      }),
    );
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(route.relayId),
    ).toBeUndefined();
  });

  it("retains the route for a nested descendant after its spawner settles", async () => {
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "nested.jsonl"), path.join(tempDir, "nested-workspace")),
      { nativeHookRelay: { enabled: true, events: ["pre_tool_use"] } },
    );
    await harness.waitForMethod("turn/start");
    const route = getRoute(harness);
    await harness.notify(spawned("thread-1", "child-c"));
    await harness.notify(spawned("child-c", "grandchild-g"));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    await harness.notify(
      childTurnCompleted({ childThreadId: "child-c", turnId: "turn-c", status: "completed" }),
    );
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(route.relayId),
    ).toBeDefined();
    await expect(
      invokeChildTool({ ...route, toolCallId: "grandchild-tool", command: "pwd" }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
    // Codex reports `idle` after every completed turn of a still-loaded thread, so a
    // finished turn cannot end the claim: the spawner can message it again at will.
    await harness.notify(
      childTurnCompleted({ childThreadId: "grandchild-g", turnId: "turn-g", status: "completed" }),
    );
    await harness.notify(threadStatusChanged("grandchild-g", "idle"));
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(route.relayId),
    ).toBeDefined();
    await harness.notify(spawned("child-c", "grandchild-g", "interacted"));
    await harness.notify(childTurnStarted("grandchild-g", "turn-g2"));
    await expect(
      invokeChildTool({ ...route, toolCallId: "grandchild-tool-2", command: "pwd" }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
    await harness.notify(threadStatusChanged("grandchild-g", "notLoaded"));
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(route.relayId),
    ).toBeUndefined();
  });

  it("does not cache a route released inside its own constructor", () => {
    const cancelled = new AbortController();
    cancelled.abort("cancelled_before_start");
    const releasedRelay = createDirectRelay(60_000, {
      signal: cancelled.signal,
      generation: "poisoned-generation",
    });
    expect(codexNativeHookRelayLeaseTesting.ownerCount()).toBe(0);
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(releasedRelay.relayId),
    ).toBeUndefined();

    // The generation is persisted with the thread binding, so the next attempt asks
    // for this same relay id; it must get a live route, never the released one.
    const nextRelay = createDirectRelay(60_000, { generation: "poisoned-generation" });
    expect(nextRelay.relayId).toBe(releasedRelay.relayId);
    expect(codexNativeHookRelayLeaseTesting.ownerCount()).toBe(1);
    const releaseWorker = nextRelay.acquireChild("worker-1");
    nextRelay.releaseParent();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(nextRelay.relayId),
    ).toBeDefined();
    releaseWorker?.();
    flushRelayCleanup();
    expect(codexNativeHookRelayLeaseTesting.ownerCount()).toBe(0);
  });

  it("detaches the cancelled attempt's failure sink from surviving workers", async () => {
    const attempt = new AbortController();
    const attemptFailureSink = vi.fn();
    const relay = createDirectRelay(60_000, {
      signal: attempt.signal,
      generation: "detached-sink-generation",
      onPreToolUseFailure: attemptFailureSink,
    });
    const releaseWorker = relay.acquireChild("worker-1");
    const reportFailure = (toolCallId: string) =>
      nativeHookRelayTesting
        .getNativeHookRelayRegistrationForTests(relay.relayId)
        ?.onPreToolUseFailure?.({
          toolName: "exec",
          toolCallId,
          disposition: "failed",
          durationMs: 5,
        });
    await reportFailure("parent-denied");
    expect(attemptFailureSink).toHaveBeenCalledTimes(1);

    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribeDiagnostics = onInternalDiagnosticEvent((event) =>
      diagnosticEvents.push(event),
    );
    try {
      attempt.abort("cancelled");
      await reportFailure("worker-denied-after-abort");
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    } finally {
      unsubscribeDiagnostics();
    }

    // The attempt is retired: its projector closure must never see worker failures,
    // and the denial still ends in a route-scoped diagnostic rather than nothing.
    expect(attemptFailureSink).toHaveBeenCalledTimes(1);
    expect(diagnosticEvents).toContainEqual(
      expect.objectContaining({
        type: "tool.execution.error",
        toolCallId: "worker-denied-after-abort",
        terminalReason: "failed",
      }),
    );

    releaseWorker?.();
    flushRelayCleanup();
    expect(codexNativeHookRelayLeaseTesting.ownerCount()).toBe(0);
  });

  it("keeps a retired attempt's later cancellation off surviving workers", async () => {
    const attempt = new AbortController();
    const relay = createDirectRelay(60_000, {
      signal: attempt.signal,
      generation: "retired-attempt-generation",
    });
    const releaseWorker = relay.acquireChild("worker-1");
    // Normal cleanup: the parent retires while the worker still claims the route and
    // the attempt has not been cancelled yet.
    relay.releaseParent({ delay: true });

    // A user cancel, gateway abort, attempt timeout, or a rotated generation can abort
    // that retired attempt afterwards; the worker's hooks must not fail closed.
    attempt.abort("cancelled_after_cleanup");
    const registration = nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(
      relay.relayId,
    );
    expect(registration).toBeDefined();
    expect(registration?.signal?.aborted).toBe(false);
    await expect(
      invokeChildTool({
        relayId: relay.relayId,
        generation: "retired-attempt-generation",
        toolCallId: "worker-tool-after-retired-attempt-abort",
      }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });

    releaseWorker?.();
    flushRelayCleanup();
    expect(codexNativeHookRelayLeaseTesting.ownerCount()).toBe(0);
  });

  it("scopes hook cancellation to the live attempt while workers hold the route", () => {
    const attempt = new AbortController();
    const relay = createDirectRelay(60_000, {
      signal: attempt.signal,
      generation: "attempt-scoped-generation",
    });
    const registrationSignal = () =>
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relay.relayId)?.signal;
    const attemptScopedSignal = registrationSignal();
    expect(attemptScopedSignal?.aborted).toBe(false);
    const releaseWorker = relay.acquireChild("worker-1");

    // Cancelling the run cancels the parent's own in-flight hook work, including a
    // pending approval wait, without cancelling the surviving worker's hooks.
    attempt.abort("cancelled");
    expect(attemptScopedSignal?.aborted).toBe(true);
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relay.relayId),
    ).toBeDefined();
    expect(registrationSignal()?.aborted).toBe(false);

    releaseWorker?.();
    flushRelayCleanup();
    expect(codexNativeHookRelayLeaseTesting.ownerCount()).toBe(0);
  });

  it("releases descendant claims when the app-server client closes", async () => {
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(
      createParams(
        path.join(tempDir, "nested-close.jsonl"),
        path.join(tempDir, "nested-close-workspace"),
      ),
      { nativeHookRelay: { enabled: true, events: ["pre_tool_use"] } },
    );
    await harness.waitForMethod("turn/start");
    const route = getRoute(harness);
    await harness.notify(spawned("thread-1", "close-child"));
    await harness.notify(spawned("close-child", "close-grandchild"));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    await harness.notify(
      childTurnCompleted({ childThreadId: "close-child", turnId: "turn-c", status: "completed" }),
    );
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(route.relayId),
    ).toBeDefined();
    harness.close();
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(route.relayId),
    ).toBeUndefined();
  });

  it("keeps a turn-1 worker relaying across a turn-2 attempt on the same client", async () => {
    const sessionFile = path.join(tempDir, "same-generation.jsonl");
    const workspaceDir = path.join(tempDir, "same-generation-workspace");
    // Production reuses one pooled app-server client and one subagent monitor
    // across turns, so both attempts must run against the same harness client.
    const harness = createStartedThreadHarness(async (method, params) =>
      method === "thread/resume"
        ? threadStartResult((params as { threadId?: string })?.threadId ?? "thread-1")
        : undefined,
    );
    const firstRun = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
    });
    await harness.waitForMethod("turn/start");
    const firstRoute = getRoute(harness);
    await harness.notify(spawned("thread-1", "first-turn-child"));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await firstRun;

    const secondParams = createParams(sessionFile, workspaceDir);
    secondParams.runId = "run-2";
    const secondRun = runCodexAppServerAttempt(secondParams, {
      nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
    });
    await vi.waitFor(
      () =>
        expect(harness.requests.filter((entry) => entry.method === "turn/start")).toHaveLength(2),
      fastWait,
    );
    // Warm reuse never re-sends the hook config, so the live worker still runs
    // turn 1's command: turn 2 must adopt that route rather than mint a new one.
    expect(codexNativeHookRelayLeaseTesting.ownerCount()).toBe(1);
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(firstRoute.relayId)?.runId,
    ).toBe("run-2");
    await expect(
      invokeChildTool({ ...firstRoute, toolCallId: "worker-during-turn-2", command: "pwd" }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await secondRun;
    flushRelayCleanup();
    await expect(
      invokeChildTool({ ...firstRoute, toolCallId: "worker-after-turn-2", command: "pwd" }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });

    await harness.notify(
      childTurnCompleted({
        childThreadId: "first-turn-child",
        turnId: "first-turn-child-terminal",
        status: "completed",
      }),
    );
    flushRelayCleanup();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(firstRoute.relayId),
    ).toBeUndefined();
  });
});
