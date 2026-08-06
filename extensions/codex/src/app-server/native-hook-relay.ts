/**
 * Bridges Codex native hook callbacks into OpenClaw's native hook relay so
 * app-server tool events can still run OpenClaw policy and diagnostics.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  registerNativeHookRelay,
  type BeforeToolCallFailureDisposition,
  type EmbeddedRunAttemptParams,
  type NativeHookRelayEvent,
  type NativeHookRelayRegistrationHandle,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { emitTrustedDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  addTimerTimeoutGraceMs,
  finiteSecondsToTimerSafeMilliseconds,
} from "openclaw/plugin-sdk/number-runtime";
import type { PluginHookToolContext } from "openclaw/plugin-sdk/types";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { resolveCodexToolAbortTerminalReason } from "./dynamic-tool-execution.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import type { JsonObject, JsonValue } from "./protocol.js";

/** Codex hook events that can be registered through OpenClaw's native relay. */
export const CODEX_NATIVE_HOOK_RELAY_EVENTS: readonly NativeHookRelayEvent[] = [
  "pre_tool_use",
  "post_tool_use",
  "permission_request",
  "before_agent_finalize",
] as const;

const CODEX_NATIVE_HOOK_RELAY_EVENTS_WITH_APP_SERVER_APPROVALS =
  CODEX_NATIVE_HOOK_RELAY_EVENTS.filter((event) => event !== "permission_request");
const CODEX_NATIVE_HOOK_RELAY_MIN_TTL_MS = 30 * 60_000;
/** Extra relay lifetime after the expected turn budget, preventing late hook drops. */
export const CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS = 5 * 60_000;
const CODEX_NATIVE_HOOK_RELAY_COMMAND_MIN_PARENT_MARGIN_MS = 250;
const CODEX_NATIVE_HOOK_RELAY_COMMAND_MAX_PARENT_MARGIN_MS = 1_000;
// The relay starts a niced Node subprocess, so busy hosts can exceed the former
// five-second relay timeout before policy and task-mirroring work completes.
const CODEX_NATIVE_HOOK_RELAY_DEFAULT_TIMEOUT_SEC = 10;
const CODEX_NATIVE_HOOK_RELAY_UNREGISTER_GRACE_MS = 10_000;
const CODEX_NATIVE_HOOK_RELAY_UNREGISTER_EXTRA_GRACE_MS = 5_000;

const CODEX_HOOK_MATCHER_NAMES_BY_TOOL_ID: Readonly<Record<string, readonly string[]>> = {
  exec: ["Bash", "exec", "exec_command"],
  apply_patch: ["apply_patch", "Write", "Edit"],
  spawn_agent: ["spawn_agent", "Agent"],
};

type CodexHookEventName = "PreToolUse" | "PostToolUse" | "PermissionRequest" | "Stop";

export type CodexNativePreToolUseFailure = {
  toolName: string;
  toolCallId: string;
  disposition: Exclude<BeforeToolCallFailureDisposition, "blocked">;
  durationMs: number;
};

/**
 * A ref-counted view of one relay route. `unregister` is intentionally absent:
 * the route outlives any single holder, so callers drop their own claim instead.
 */
export type CodexNativeHookRelayLease = Omit<NativeHookRelayRegistrationHandle, "unregister"> & {
  /** Returns the claim's release callback, or undefined when the route cannot be claimed. */
  acquireChild: (childThreadId: string) => (() => void) | undefined;
  releaseParent: (options?: { delay?: boolean }) => void;
};

type CodexNativeHookRelayParams = {
  options:
    | {
        enabled?: boolean;
        ttlMs?: number;
        gatewayTimeoutMs?: number;
        hookTimeoutSec?: number;
      }
    | undefined;
  generation?: string;
  events: readonly NativeHookRelayEvent[];
  agentId: string | undefined;
  sessionId: string;
  sessionKey: string | undefined;
  config: EmbeddedRunAttemptParams["config"];
  runId: string;
  channelId?: string;
  requester?: NonNullable<PluginHookToolContext["requester"]>;
  approvalContext?: Parameters<typeof registerNativeHookRelay>[0]["approvalContext"];
  attemptTimeoutMs: number;
  startupTimeoutMs: number;
  turnStartTimeoutMs: number;
  loopDetectionPreToolUseRelay: boolean;
  signal: AbortSignal;
  onPreToolUseFailure: (failure: CodexNativePreToolUseFailure) => void | Promise<void>;
};

/** Defers relay unregister so late native hook subprocesses can still resolve. */
function scheduleCodexNativeHookRelayUnregister(params: {
  relay: Pick<NativeHookRelayRegistrationHandle, "unregister">;
  hookTimeoutSec?: number;
  beforeUnregister?: () => void;
}): () => void {
  let pending: { timeout: ReturnType<typeof setTimeout>; unregister: () => void } | undefined;
  const unregister = () => {
    if (!pending) {
      return;
    }
    const current = pending;
    pending = undefined;
    if (!nativeHookRelayUnregisterQueue.delete(current)) {
      return;
    }
    params.beforeUnregister?.();
    params.relay.unregister();
  };
  const timeout = setTimeout(
    unregister,
    resolveCodexNativeHookRelayUnregisterGraceMs(params.hookTimeoutSec),
  );
  pending = { timeout, unregister };
  nativeHookRelayUnregisterQueue.add(pending);
  timeout.unref();
  return () => {
    if (!pending) {
      return;
    }
    const current = pending;
    pending = undefined;
    if (nativeHookRelayUnregisterQueue.delete(current)) {
      clearTimeout(current.timeout);
    }
  };
}

/** Computes the delayed unregister window from Codex's hook timeout. */
function resolveCodexNativeHookRelayUnregisterGraceMs(hookTimeoutSec: number | undefined): number {
  const hookTimeoutMs =
    finiteSecondsToTimerSafeMilliseconds(normalizeHookTimeoutSec(hookTimeoutSec)) ?? 0;
  return Math.max(
    CODEX_NATIVE_HOOK_RELAY_UNREGISTER_GRACE_MS,
    addTimerTimeoutGraceMs(hookTimeoutMs, CODEX_NATIVE_HOOK_RELAY_UNREGISTER_EXTRA_GRACE_MS) ?? 0,
  );
}

/** Records a native pre-tool failure that Codex does not project as a tool item. */
export function emitCodexNativePreToolUseFailureDiagnostic(params: {
  agentId: string | undefined;
  sessionId: string;
  sessionKey: string | undefined;
  runId: string;
  signal?: AbortSignal;
  failure: CodexNativePreToolUseFailure;
  terminalReason?: CodexNativePreToolUseFailure["disposition"];
  sourceTimestampMs?: number;
}): void {
  emitTrustedDiagnosticEvent({
    type: "tool.execution.error",
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    runId: params.runId,
    toolName: params.failure.toolName,
    toolCallId: params.failure.toolCallId,
    durationMs: params.failure.durationMs,
    errorCategory: "before_tool_call",
    terminalReason:
      params.terminalReason ??
      (params.signal?.aborted
        ? resolveCodexToolAbortTerminalReason(params.signal)
        : params.failure.disposition),
    ...(params.sourceTimestampMs !== undefined
      ? { sourceTimestampMs: params.sourceTimestampMs }
      : {}),
  });
}

/** Registers an OpenClaw native hook relay for a Codex app-server turn. */
export function createCodexNativeHookRelay(
  params: CodexNativeHookRelayParams,
): CodexNativeHookRelayLease | undefined {
  if (params.options?.enabled === false) {
    return undefined;
  }
  const generation = params.generation?.trim() || randomUUID();
  const attempt: CodexNativeHookRelayAttempt = { ...params, generation };
  const relayId = buildCodexNativeHookRelayId({
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    generation,
  });
  // A spawned Codex worker keeps the hook command frozen at spawn, and Codex
  // ignores resume overrides for an already-loaded thread. So the route for one
  // generation must survive the attempt that created it: the next attempt adopts
  // it under the same id instead of minting a replacement its workers cannot name.
  const adopted = codexNativeHookRelayOwners.get(relayId);
  if (adopted?.adoptAttempt(attempt)) {
    return adopted.handle;
  }
  // No live owner for this generation: the new route claims the map entry itself.
  return new CodexNativeHookRelayRoute(attempt, relayId).handle;
}

function registerCodexNativeHookRelay(
  params: CodexNativeHookRelayAttempt,
  relayId: string,
  options: {
    ttlMs: number;
    signal: AbortSignal;
    onPreToolUseFailure: CodexNativeHookRelayParams["onPreToolUseFailure"];
  },
): NativeHookRelayRegistrationHandle {
  return registerNativeHookRelay({
    provider: "codex",
    relayId,
    generation: params.generation,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.config ? { config: params.config } : {}),
    runId: params.runId,
    ...(params.channelId ? { channelId: params.channelId } : {}),
    ...(params.requester ? { requester: params.requester } : {}),
    ...(params.approvalContext ? { approvalContext: params.approvalContext } : {}),
    allowedEvents: params.events,
    preToolUseLoopDetection: params.loopDetectionPreToolUseRelay,
    ttlMs: options.ttlMs,
    signal: options.signal,
    onPreToolUseFailure: options.onPreToolUseFailure,
    command: {
      // Hook relay subprocesses are observational for most tool events; keep
      // them lower priority so they do not compete with the active reply turn.
      nice: 10,
      timeoutMs: params.options?.gatewayTimeoutMs,
    },
  });
}

type CodexNativeHookRelayAttempt = CodexNativeHookRelayParams & { generation: string };

/**
 * Every (re-)registration states both facts explicitly: whose cancellation reaches
 * in-flight hook work, and which sink receives pre-tool failures. `failureSink` is
 * required so a rebind can never silently re-attach a retired attempt's projector.
 */
type CodexNativeHookRelayRegistrationOptions = {
  attemptScoped?: boolean;
  failureSink: CodexNativeHookRelayParams["onPreToolUseFailure"] | undefined;
};

/** Strips the raw registration's `unregister`; route lifetime is ref-counted, not caller-owned. */
function toCodexNativeHookRelayLeaseFields(
  relay: NativeHookRelayRegistrationHandle,
): Omit<NativeHookRelayRegistrationHandle, "unregister"> {
  const { unregister: _unregister, ...fields } = relay;
  return fields;
}

class CodexNativeHookRelayRoute {
  readonly handle: CodexNativeHookRelayLease;

  private parentActive = true;
  private readonly childThreadIds = new Set<string>();
  private readonly relayId: string;
  private relay: NativeHookRelayRegistrationHandle;
  private ttlMs = 0;
  private hookTimeoutSec: number | undefined;
  private readonly lifetimeAbortController = new AbortController();
  // Present while the registration is attempt-scoped; only a route-scoped rebind
  // clears it. Aborted solely by the attempt-abort listener, which releaseParent
  // detaches together with the parent claim.
  private attemptScopedAbortController: AbortController | undefined;
  private failureSink: CodexNativeHookRelayParams["onPreToolUseFailure"] | undefined;
  private detachAttemptAbort: (() => void) | undefined;
  private renewalTimer: ReturnType<typeof setTimeout> | undefined;
  private cancelPendingUnregister: (() => void) | undefined;
  private released = false;
  // The lease methods stay identity-stable across attempts so an adopted route
  // keeps serving handles that earlier attempts and the subagent monitor hold.
  private readonly leaseMethods = {
    renew: (ttlMs?: number) => this.renew(ttlMs),
    acquireChild: (childThreadId: string) => this.acquireChild(childThreadId),
    releaseParent: (options?: { delay?: boolean }) => this.releaseParent(options),
  };

  constructor(
    private currentAttempt: CodexNativeHookRelayAttempt,
    relayId: string,
  ) {
    this.relayId = relayId;
    this.relay = this.registerAttempt(currentAttempt, {
      failureSink: currentAttempt.onPreToolUseFailure,
    });
    this.handle = { ...toCodexNativeHookRelayLeaseFields(this.relay), ...this.leaseMethods };
    // Own the map entry before wiring the abort listener: an already-aborted attempt
    // releases the route synchronously, and a released route must evict itself here
    // instead of leaving a corpse every later attempt would adopt.
    codexNativeHookRelayOwners.set(relayId, this);
    this.attachAttemptAbort(currentAttempt.signal);
  }

  /**
   * Re-points a live route at the current attempt without changing its relay id.
   */
  adoptAttempt(attempt: CodexNativeHookRelayAttempt): boolean {
    // Asserts the owner-map invariant `finalizeState` maintains: a released route
    // always evicts its own entry, so an adoptable owner is always live. Kept as a
    // fail-closed guard because adopting a corpse silently unclaims every worker.
    if (this.released) {
      return false;
    }
    this.cancelPendingUnregister?.();
    this.cancelPendingUnregister = undefined;
    this.parentActive = true;
    this.rebindRegistration(attempt, { failureSink: attempt.onPreToolUseFailure });
    this.attachAttemptAbort(attempt.signal);
    return true;
  }

  private rebindRegistration(
    attempt: CodexNativeHookRelayAttempt,
    options: CodexNativeHookRelayRegistrationOptions,
  ): void {
    this.currentAttempt = attempt;
    this.relay = this.registerAttempt(attempt, options);
    Object.assign(this.handle, toCodexNativeHookRelayLeaseFields(this.relay), this.leaseMethods);
  }

  /** Rebinds the relay registration to this attempt's requester, run and failure sink. */
  private registerAttempt(
    attempt: CodexNativeHookRelayAttempt,
    options: CodexNativeHookRelayRegistrationOptions,
  ): NativeHookRelayRegistrationHandle {
    this.ttlMs = resolveCodexNativeHookRelayTtlMs({
      explicitTtlMs: attempt.options?.ttlMs,
      attemptTimeoutMs: attempt.attemptTimeoutMs,
      startupTimeoutMs: attempt.startupTimeoutMs,
      turnStartTimeoutMs: attempt.turnStartTimeoutMs,
    });
    this.hookTimeoutSec = attempt.options?.hookTimeoutSec;
    this.failureSink = options.failureSink;
    const attemptScopedAbortController =
      options.attemptScoped === false ? undefined : new AbortController();
    this.attemptScopedAbortController = attemptScopedAbortController;
    const detachedFailureSink = (failure: CodexNativePreToolUseFailure) =>
      emitCodexNativePreToolUseFailureDiagnostic({
        agentId: attempt.agentId,
        sessionId: attempt.sessionId,
        sessionKey: attempt.sessionKey,
        runId: attempt.runId,
        failure,
      });
    return registerCodexNativeHookRelay(attempt, this.relayId, {
      ttlMs: this.ttlMs,
      // Core reads this signal per invocation to cancel in-flight hook work and
      // pending approval waits, so a cancelled attempt must reach its own prompts.
      // The route mirrors the attempt through its own controller rather than
      // composing `attempt.signal` directly: signal ownership follows the parent
      // claim, and a retired attempt must never reach a surviving worker again.
      signal: attemptScopedAbortController
        ? AbortSignal.any([
            this.lifetimeAbortController.signal,
            attemptScopedAbortController.signal,
          ])
        : this.lifetimeAbortController.signal,
      onPreToolUseFailure: (failure) => (this.failureSink ?? detachedFailureSink)(failure),
    });
  }

  /**
   * An aborted run must still cancel its own in-flight hook work, so the abort
   * drops the parent claim immediately. Workers keep the route alive through
   * their own claims; the route only aborts once nothing holds it.
   */
  private attachAttemptAbort(signal: AbortSignal): void {
    this.detachAttemptAbort?.();
    const onAbort = () => {
      this.attemptScopedAbortController?.abort(signal.reason);
      this.releaseParent();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    this.detachAttemptAbort = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) {
      onAbort();
    }
  }

  private hasClaims(): boolean {
    return this.parentActive || this.childThreadIds.size > 0;
  }

  private renew(ttlMs?: number): void {
    if (this.released || !this.hasClaims()) {
      return;
    }
    this.relay.renew(ttlMs);
    this.handle.expiresAtMs = this.relay.expiresAtMs;
  }

  private acquireChild(childThreadIdInput: string): (() => void) | undefined {
    const childThreadId = childThreadIdInput.trim();
    // A released route grants nothing. Report that instead of handing back a no-op
    // release, so the caller retries against the live successor route rather than
    // latching a corpse that leaves the worker permanently unclaimable.
    if (!childThreadId || this.released || this.childThreadIds.has(childThreadId)) {
      return undefined;
    }
    this.cancelPendingUnregister?.();
    this.cancelPendingUnregister = undefined;
    this.childThreadIds.add(childThreadId);
    this.scheduleRenewal();
    let acquired = true;
    return () => {
      if (!acquired) {
        return;
      }
      acquired = false;
      this.childThreadIds.delete(childThreadId);
      if (this.childThreadIds.size === 0) {
        this.clearRenewal();
        if (!this.parentActive) {
          this.requestFinalRelease(true);
        }
      }
    };
  }

  private releaseParent(options: { delay?: boolean } = {}): void {
    if (!this.parentActive || this.released) {
      return;
    }
    this.parentActive = false;
    // Descendants inherit the hook command, but not the parent's turn lifetime.
    // Drop attempt-local projection; reportFailure falls back to its route-scoped diagnostic.
    this.failureSink = undefined;
    // The parent claim owned the attempt-scoped signal. Dropping the listener here is
    // what keeps a retiring attempt's later cancellation — user abort, gateway abort,
    // attempt timeout, or a mid-attempt generation rotation — from cancelling the hook
    // work of workers that outlived it. `adoptAttempt` re-arms this for the next attempt.
    this.detachAttemptAbort?.();
    this.detachAttemptAbort = undefined;
    if (this.childThreadIds.size === 0) {
      this.requestFinalRelease(options.delay === true);
      return;
    }
    // An abort already fired through the composite signal, so this registration can no
    // longer serve the surviving workers: re-register the same relay id under a
    // route-only signal, which their spawn-frozen hook command still names. A parent
    // that retired without aborting keeps its registration; re-registering there would
    // drop live workers' pending approvals and the relay's allow-always window.
    if (this.attemptScopedAbortController?.signal.aborted) {
      this.rebindRegistration(this.currentAttempt, {
        attemptScoped: false,
        failureSink: undefined,
      });
    }
  }

  private requestFinalRelease(delay: boolean): void {
    if (this.released || this.hasClaims()) {
      return;
    }
    if (!delay) {
      this.releaseNow("codex_native_hook_relay_released");
      return;
    }
    if (this.cancelPendingUnregister) {
      return;
    }
    this.cancelPendingUnregister = scheduleCodexNativeHookRelayUnregister({
      relay: { unregister: () => this.relay.unregister() },
      hookTimeoutSec: this.hookTimeoutSec,
      beforeUnregister: () => {
        this.cancelPendingUnregister = undefined;
        this.lifetimeAbortController.abort("codex_native_hook_relay_released");
        this.finalizeState();
      },
    });
  }

  private scheduleRenewal(): void {
    if (this.renewalTimer || this.released || this.childThreadIds.size === 0) {
      return;
    }
    const delayMs = Math.max(1, Math.min(5 * 60_000, Math.floor(this.ttlMs / 2)));
    this.renewalTimer = setTimeout(() => {
      this.renewalTimer = undefined;
      if (this.released || this.childThreadIds.size === 0) {
        return;
      }
      this.renew(this.ttlMs);
      this.scheduleRenewal();
    }, delayMs);
    this.renewalTimer.unref();
  }

  private clearRenewal(): void {
    if (!this.renewalTimer) {
      return;
    }
    clearTimeout(this.renewalTimer);
    this.renewalTimer = undefined;
  }

  private releaseNow(reason: string): void {
    this.cancelPendingUnregister?.();
    this.cancelPendingUnregister = undefined;
    this.lifetimeAbortController.abort(reason);
    this.relay.unregister();
    this.finalizeState();
  }

  private finalizeState(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    this.parentActive = false;
    this.clearRenewal();
    this.detachAttemptAbort?.();
    this.detachAttemptAbort = undefined;
    this.failureSink = undefined;
    this.childThreadIds.clear();
    if (codexNativeHookRelayOwners.get(this.relayId) === this) {
      codexNativeHookRelayOwners.delete(this.relayId);
    }
  }

  dispose(): void {
    if (this.released) {
      return;
    }
    this.releaseNow("codex_native_hook_relay_disposed");
  }
}

const codexNativeHookRelayOwners = new Map<string, CodexNativeHookRelayRoute>();

export function clearCodexNativeHookRelayOwnersForTests(): void {
  for (const owner of codexNativeHookRelayOwners.values()) {
    owner.dispose();
  }
  codexNativeHookRelayOwners.clear();
}

export const codexNativeHookRelayLeaseTesting = {
  ownerCount: () => codexNativeHookRelayOwners.size,
};

/** Selects the native hook events Codex should install for the current approval mode. */
export function resolveCodexNativeHookRelayEvents(params: {
  configuredEvents?: readonly NativeHookRelayEvent[];
  appServer: Pick<CodexAppServerRuntimeOptions, "approvalPolicy">;
}): readonly NativeHookRelayEvent[] {
  if (params.configuredEvents?.length) {
    return params.configuredEvents;
  }
  // Codex emits PermissionRequest before the app-server approval reviewer has
  // resolved the command. In native approval modes, let Codex's app-server
  // approval bridge own the real escalation instead of surfacing a stale
  // pre-guardian OpenClaw plugin approval prompt.
  return params.appServer.approvalPolicy === "never"
    ? CODEX_NATIVE_HOOK_RELAY_EVENTS
    : CODEX_NATIVE_HOOK_RELAY_EVENTS_WITH_APP_SERVER_APPROVALS;
}

/** Derives the native hook relay TTL from the turn budget unless explicitly configured. */
export function resolveCodexNativeHookRelayTtlMs(params: {
  explicitTtlMs: number | undefined;
  attemptTimeoutMs: number;
  startupTimeoutMs: number;
  turnStartTimeoutMs: number;
}): number {
  if (params.explicitTtlMs !== undefined) {
    return params.explicitTtlMs;
  }
  const relayBudgetMs =
    params.attemptTimeoutMs +
    params.startupTimeoutMs +
    params.turnStartTimeoutMs +
    CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS;
  return Math.max(CODEX_NATIVE_HOOK_RELAY_MIN_TTL_MS, Math.floor(relayBudgetMs));
}

/** Builds the relay id every worker of one inherited hook generation names. */
function buildCodexNativeHookRelayId(params: {
  agentId: string | undefined;
  sessionId: string;
  sessionKey: string | undefined;
  generation: string;
}): string {
  const hash = createHash("sha256");
  hash.update("openclaw:codex:native-hook-relay:v2");
  hash.update("\0");
  hash.update(params.agentId?.trim() || "");
  hash.update("\0");
  hash.update(params.sessionKey?.trim() || params.sessionId);
  hash.update("\0");
  hash.update(params.generation);
  return `codex-${hash.digest("hex").slice(0, 40)}`;
}

const CODEX_HOOK_EVENT_BY_NATIVE_EVENT: Record<NativeHookRelayEvent, CodexHookEventName> = {
  pre_tool_use: "PreToolUse",
  post_tool_use: "PostToolUse",
  permission_request: "PermissionRequest",
  before_agent_finalize: "Stop",
};

const CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT: Record<NativeHookRelayEvent, string> = {
  pre_tool_use: "pre_tool_use",
  post_tool_use: "post_tool_use",
  permission_request: "permission_request",
  before_agent_finalize: "stop",
};

const CODEX_SESSION_FLAGS_HOOK_SOURCE_PATHS = [
  "/<session-flags>/config.toml",
  "<session-flags>/config.toml",
] as const;

/** Builds the Codex config overlay that installs trusted command hooks for relay events. */
export function buildCodexNativeHookRelayConfig(params: {
  relay: Pick<
    NativeHookRelayRegistrationHandle,
    "shouldRelayEvent" | "toolMatcherForEvent" | "commandForEvent"
  >;
  events?: readonly NativeHookRelayEvent[];
  hookTimeoutSec?: number;
  clearOmittedEvents?: boolean;
  loopDetectionPreToolUseRelay: boolean;
}): JsonObject {
  const events = params.events?.length ? params.events : CODEX_NATIVE_HOOK_RELAY_EVENTS;
  const selectedEvents = new Set<NativeHookRelayEvent>(events);
  const config: JsonObject = {
    "features.hooks": true,
  };
  const hookState: JsonObject = {};
  for (const event of CODEX_NATIVE_HOOK_RELAY_EVENTS) {
    const codexEvent = CODEX_HOOK_EVENT_BY_NATIVE_EVENT[event];
    const selected = selectedEvents.has(event);
    const shouldRelay = params.relay.shouldRelayEvent(event);
    // The no-policy marker is part of the shipped Codex fallback contract.
    // Only the Codex-owned loop relay opt-out may omit it.
    const selectedNoopPreToolUse =
      selected && event === "pre_tool_use" && !shouldRelay && params.loopDetectionPreToolUseRelay;
    if (!selected || (!shouldRelay && !selectedNoopPreToolUse)) {
      if (selected || params.clearOmittedEvents) {
        config[`hooks.${codexEvent}`] = [] satisfies JsonValue;
      }
      if (params.clearOmittedEvents) {
        for (const sourcePath of CODEX_SESSION_FLAGS_HOOK_SOURCE_PATHS) {
          hookState[`${sourcePath}:${CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT[event]}:0:0`] = {
            enabled: false,
          } satisfies JsonValue;
        }
      }
      continue;
    }
    const timeout = normalizeHookTimeoutSec(params.hookTimeoutSec);
    const command = params.relay.commandForEvent(event, {
      timeoutMs: resolveCodexNativeHookRelayCommandTimeoutMs(timeout),
    });
    const matcher = selectedNoopPreToolUse
      ? undefined
      : buildCodexNativeToolMatcher(params.relay.toolMatcherForEvent(event));
    config[`hooks.${codexEvent}`] = [
      {
        ...(matcher ? { matcher } : {}),
        hooks: [
          {
            type: "command",
            command,
            timeout,
            async: false,
            statusMessage: "OpenClaw native hook relay",
          },
        ],
      },
    ] satisfies JsonValue;
    const state = {
      enabled: true,
      trusted_hash: codexCommandHookTrustedHash({
        event,
        command,
        matcher,
        timeout,
        statusMessage: "OpenClaw native hook relay",
      }),
    };
    for (const sourcePath of CODEX_SESSION_FLAGS_HOOK_SOURCE_PATHS) {
      hookState[`${sourcePath}:${CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT[event]}:0:0`] =
        state satisfies JsonValue;
    }
  }
  config["hooks.state"] = hookState;
  return config;
}

/** Builds a Codex config overlay that disables native hooks and clears hook arrays. */
export function buildCodexNativeHookRelayDisabledConfig(): JsonObject {
  return {
    "features.hooks": false,
    "hooks.PreToolUse": [],
    "hooks.PostToolUse": [],
    "hooks.PermissionRequest": [],
    "hooks.Stop": [],
  };
}

function normalizeHookTimeoutSec(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : CODEX_NATIVE_HOOK_RELAY_DEFAULT_TIMEOUT_SEC;
}

function resolveCodexNativeHookRelayCommandTimeoutMs(hookTimeoutSec: number | undefined): number {
  const parentTimeoutMs =
    finiteSecondsToTimerSafeMilliseconds(normalizeHookTimeoutSec(hookTimeoutSec)) ?? 5_000;
  const parentMarginMs = Math.min(
    CODEX_NATIVE_HOOK_RELAY_COMMAND_MAX_PARENT_MARGIN_MS,
    Math.max(CODEX_NATIVE_HOOK_RELAY_COMMAND_MIN_PARENT_MARGIN_MS, Math.floor(parentTimeoutMs / 5)),
  );
  return Math.max(1, parentTimeoutMs - parentMarginMs);
}

function buildCodexNativeToolMatcher(toolNames: readonly string[] | undefined): string | undefined {
  if (toolNames === undefined) {
    return undefined;
  }
  if (toolNames.length === 0) {
    throw new TypeError("Codex native hook matcher requires at least one tool name");
  }
  const nativeNames = new Set<string>();
  let hasCustomToolName = false;
  for (const toolName of toolNames) {
    const canonicalToolName = toolName.trim();
    if (!canonicalToolName || canonicalToolName === "*") {
      throw new TypeError("Codex native hook matcher requires canonical OpenClaw tool ids");
    }
    const nativeAliases = CODEX_HOOK_MATCHER_NAMES_BY_TOOL_ID[canonicalToolName];
    if (!nativeAliases) {
      hasCustomToolName = true;
    }
    for (const nativeName of nativeAliases ?? [canonicalToolName]) {
      nativeNames.add(nativeName);
    }
  }
  const sortedNames = Array.from(nativeNames).toSorted();
  if (!hasCustomToolName && sortedNames.every((toolName) => /^[A-Za-z0-9_]+$/.test(toolName))) {
    return sortedNames.join("|");
  }
  const escapedNames = sortedNames.map((toolName) =>
    toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return `(?i)^(?:${escapedNames.join("|")})$`;
}

function codexCommandHookTrustedHash(params: {
  event: NativeHookRelayEvent;
  command: string;
  matcher?: string;
  timeout: number;
  statusMessage: string;
}): string {
  // Keep the match-all matcher omitted rather than null. Codex app-server
  // converts JSON null to an empty TOML string before hashing, which changes the
  // trust identity even though both forms match all tools.
  const identity = {
    event_name: CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT[params.event],
    ...(params.matcher ? { matcher: params.matcher } : {}),
    hooks: [
      {
        async: false,
        command: params.command,
        statusMessage: params.statusMessage,
        timeout: params.timeout,
        type: "command",
      },
    ],
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(sortJsonValue(identity)))
    .digest("hex");
  return `sha256:${hash}`;
}

function sortJsonValue(value: JsonValue): JsonValue {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  const sorted: JsonObject = {};
  for (const [key, entry] of Object.entries(value).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    sorted[key] = sortJsonValue(entry);
  }
  return sorted;
}
