// Slack plugin module owns admission for exported/direct delivery paths.
import type { ResolvedSlackAccount } from "./accounts.js";
import { normalizeSlackWorkspaceId } from "./target-parsing.js";

export function assertSlackDirectSendAllowed(
  account: ResolvedSlackAccount,
  workspaceId?: string,
): void {
  const normalizedWorkspaceId = normalizeSlackWorkspaceId(workspaceId);
  if (account.config.enterpriseOrgInstall === true && !normalizedWorkspaceId) {
    throw new Error("unsupported_enterprise_slack_delivery");
  }
  if (account.config.enterpriseOrgInstall !== true && normalizedWorkspaceId) {
    throw new Error("unexpected_enterprise_slack_workspace");
  }
}
