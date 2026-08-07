// Slack plugin module implements target parsing behavior.
import {
  buildMessagingTarget,
  ensureTargetId,
  parseMentionPrefixOrAtUserTarget,
  requireTargetKind,
  type MessagingTarget,
  type MessagingTargetKind,
  type MessagingTargetParseOptions,
} from "openclaw/plugin-sdk/channel-targets";

export type SlackTargetKind = MessagingTargetKind;

export type SlackTarget = MessagingTarget & {
  /** Enterprise Grid workspace that owns this Slack target. */
  workspaceId?: string;
};

export type SlackTargetParseOptions = MessagingTargetParseOptions;

// Letter-leading folded IDs are indistinguishable from supported channel names.
// Doctor reports that ambiguity; runtime repairs only the digit-leading form.
const SLACK_CHANNEL_API_ID_RE = /^[CDG][0-9][A-Z0-9]{7,}$/i;
const SLACK_USER_API_ID_RE = /^[UW][A-Z0-9]{8,}$/i;
const SLACK_WORKSPACE_ID_RE = /^T[A-Z0-9]+$/i;
const SLACK_WORKSPACE_TARGET_RE = /^(?:workspace|team):([^:]+):(.+)$/i;

export function normalizeSlackWorkspaceId(raw: string | undefined | null): string | undefined {
  const workspaceId = raw?.trim();
  if (!workspaceId) {
    return undefined;
  }
  if (!SLACK_WORKSPACE_ID_RE.test(workspaceId)) {
    throw new Error('Slack workspaceId must be a workspace ID starting with "T".');
  }
  return workspaceId.toUpperCase();
}

export function formatSlackWorkspaceTarget(workspaceId: string, target: string): string {
  const normalizedWorkspaceId = normalizeSlackWorkspaceId(workspaceId);
  if (!normalizedWorkspaceId) {
    throw new Error("Slack workspaceId is required.");
  }
  const parsedTarget = parseSlackTarget(target);
  if (!parsedTarget) {
    throw new Error("Slack target is required.");
  }
  if (parsedTarget.workspaceId && parsedTarget.workspaceId !== normalizedWorkspaceId) {
    throw new Error("Slack workspaceId conflicts with the workspace-qualified target.");
  }
  return `workspace:${normalizedWorkspaceId}:${parsedTarget.kind}:${parsedTarget.id}`;
}

function isUnambiguousSlackUserId(rawId: string): boolean {
  const id = rawId.trim();
  return /^[UW][A-Z0-9]+$/.test(id) || /^[uw][0-9][a-z0-9]{7,}$/.test(id);
}

/** Restores API casing for unambiguous normalized Slack conversation IDs. */
export function canonicalizeSlackApiTargetId(
  kind: SlackTargetKind,
  rawId: string,
  rawTarget?: string,
): string {
  const id = rawId.trim();
  if (kind === "channel" && rawTarget?.trim().startsWith("#")) {
    return id;
  }
  const idPattern = kind === "user" ? SLACK_USER_API_ID_RE : SLACK_CHANNEL_API_ID_RE;
  return idPattern.test(id) ? id.toUpperCase() : id;
}

export function parseSlackTarget(
  raw: string,
  options: SlackTargetParseOptions = {},
): SlackTarget | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const workspaceMatch = SLACK_WORKSPACE_TARGET_RE.exec(trimmed);
  if (workspaceMatch) {
    const workspaceId = normalizeSlackWorkspaceId(workspaceMatch[1]);
    const nested = parseSlackTarget(workspaceMatch[2], options);
    if (!workspaceId || !nested) {
      throw new Error("Slack workspace-qualified targets require a workspace and target.");
    }
    if (nested.workspaceId && nested.workspaceId !== workspaceId) {
      throw new Error("Nested Slack workspace-qualified targets are not supported.");
    }
    return {
      ...nested,
      raw: trimmed,
      normalized: `workspace:${workspaceId.toLowerCase()}:${nested.normalized}`,
      workspaceId,
    };
  }
  if (/^(?:workspace|team):/i.test(trimmed)) {
    throw new Error(
      "Slack workspace-qualified targets use workspace:<workspaceId>:channel:<channelId> or workspace:<workspaceId>:user:<userId>.",
    );
  }
  const userTarget = parseMentionPrefixOrAtUserTarget({
    raw: trimmed,
    mentionPattern: /^<@([A-Z0-9]+)>$/i,
    prefixes: [
      { prefix: "user:", kind: "user" },
      { prefix: "channel:", kind: "channel" },
      { prefix: "slack:", kind: "user" },
    ],
    atUserPattern: /^[A-Z0-9]+$/i,
    atUserErrorMessage: "Slack DMs require a user id (use user:<id> or <@id>)",
  });
  if (userTarget) {
    return userTarget;
  }
  if (trimmed.startsWith("#")) {
    const candidate = trimmed.slice(1).trim();
    const id = ensureTargetId({
      candidate,
      pattern: /^[A-Z0-9]+$/i,
      errorMessage: "Slack channels require a channel id (use channel:<id>)",
    });
    return buildMessagingTarget("channel", id, trimmed);
  }
  if (isUnambiguousSlackUserId(trimmed)) {
    return buildMessagingTarget("user", trimmed, trimmed);
  }
  if (options.defaultKind) {
    return buildMessagingTarget(options.defaultKind, trimmed, trimmed);
  }
  return buildMessagingTarget("channel", trimmed, trimmed);
}

export function resolveSlackChannelId(raw: string): string {
  const target = parseSlackTarget(raw, { defaultKind: "channel" });
  const channelId = requireTargetKind({ platform: "Slack", target, kind: "channel" });
  return canonicalizeSlackApiTargetId("channel", channelId, raw);
}

export function normalizeSlackMessagingTarget(raw: string): string | undefined {
  return parseSlackTarget(raw, { defaultKind: "channel" })?.normalized;
}

export function slackTargetsMatch(left: string, right: string): boolean {
  const leftTarget = parseSlackTarget(left, { defaultKind: "channel" });
  const rightTarget = parseSlackTarget(right, { defaultKind: "channel" });
  if (!leftTarget || !rightTarget) {
    return false;
  }
  if (
    leftTarget.workspaceId &&
    rightTarget.workspaceId &&
    leftTarget.workspaceId !== rightTarget.workspaceId
  ) {
    return false;
  }
  return (
    leftTarget.kind === rightTarget.kind &&
    leftTarget.id.toLowerCase() === rightTarget.id.toLowerCase()
  );
}

export function looksLikeSlackTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  if (/^<@([A-Z0-9]+)>$/i.test(trimmed)) {
    return true;
  }
  if (/^(user|channel):/i.test(trimmed)) {
    return true;
  }
  if (/^slack:/i.test(trimmed)) {
    return true;
  }
  if (/^(?:workspace|team):/i.test(trimmed)) {
    return true;
  }
  if (/^[@#]/.test(trimmed)) {
    return true;
  }
  return /^[CUWGD][A-Z0-9]{8,}$/i.test(trimmed);
}
