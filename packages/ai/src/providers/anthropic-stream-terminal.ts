const ANTHROPIC_STREAM_INCOMPLETE_ERROR = "Anthropic stream ended before message_stop";

type AnthropicTerminalEvidence =
  | { state: "verified" }
  | {
      state: "unverified";
      reason: "compatible_clean_eof" | "compatible_structural_ambiguity";
    };

function requiresAnthropicMessageStop(params: {
  provider: string;
  endpointClass: string;
}): boolean {
  if (!params.endpointClass.trim() || params.endpointClass === "invalid") {
    return true;
  }
  if (params.endpointClass === "anthropic-public") {
    return true;
  }
  return params.endpointClass === "default";
}

export function createAnthropicStreamTerminalCompleteness(params: {
  compatibleCleanEof?: "before_message_start" | "structurally_complete";
  requireMessageStop: boolean;
}) {
  let sawMessageStop = false;
  let sawMappedStopReason = false;
  let sawStandaloneDone = false;
  let sawMessageStart = false;
  let sawCompletedContentBlock = false;
  let structurallyIncomplete = false;
  let structurallyAmbiguous = false;
  let phase: "before_start" | "blocks" | "message_delta" | "message_stop" = "before_start";
  const openContentBlocks = new Set<string>();
  const seenContentBlocks = new Set<string>();
  const contentBlockKey = (index: unknown): string | undefined =>
    typeof index === "number" && Number.isInteger(index) && index >= 0 ? String(index) : undefined;

  return {
    observeMessageStart(): void {
      if (phase !== "before_start" || sawMessageStart || sawStandaloneDone) {
        structurallyAmbiguous = true;
      }
      sawMessageStart = true;
      phase = "blocks";
    },
    observeContentBlockStart(index: unknown): void {
      const key = contentBlockKey(index);
      if (
        !key ||
        !sawMessageStart ||
        phase !== "blocks" ||
        openContentBlocks.has(key) ||
        seenContentBlocks.has(key)
      ) {
        structurallyAmbiguous = true;
      }
      if (key) {
        seenContentBlocks.add(key);
        openContentBlocks.add(key);
      }
    },
    observeContentBlockDelta(index: unknown): void {
      const key = contentBlockKey(index);
      if (!key || !sawMessageStart || phase !== "blocks" || !openContentBlocks.has(key)) {
        structurallyAmbiguous = true;
      }
    },
    observeContentBlockStop(index: unknown): void {
      const key = contentBlockKey(index);
      const valid =
        key !== undefined && sawMessageStart && phase === "blocks" && openContentBlocks.has(key);
      if (!valid) {
        structurallyAmbiguous = true;
      }
      if (key) {
        openContentBlocks.delete(key);
      }
      if (valid) {
        sawCompletedContentBlock = true;
      }
    },
    observeMessageDelta(): void {
      if (!sawMessageStart || phase !== "blocks" || openContentBlocks.size > 0) {
        structurallyAmbiguous = true;
      }
      phase = "message_delta";
    },
    observeStructuralIncomplete(): void {
      structurallyIncomplete = true;
    },
    observeMessageStop(): void {
      if (
        !sawMessageStart ||
        sawMessageStop ||
        (phase !== "blocks" && phase !== "message_delta") ||
        openContentBlocks.size > 0
      ) {
        structurallyAmbiguous = true;
      }
      sawMessageStop = true;
      phase = "message_stop";
    },
    observeMappedStopReason(reason: string): void {
      if (!sawMessageStart || phase !== "message_delta" || sawMessageStop) {
        structurallyAmbiguous = true;
      }
      if (reason.trim().length > 0) {
        sawMappedStopReason = true;
      }
    },
    observeStandaloneDone(): void {
      if (sawStandaloneDone || phase === "message_stop") {
        structurallyAmbiguous = true;
      }
      sawStandaloneDone = true;
    },
    assertComplete(): AnthropicTerminalEvidence {
      if (structurallyIncomplete || openContentBlocks.size > 0) {
        throw new Error(ANTHROPIC_STREAM_INCOMPLETE_ERROR);
      }
      const hasTerminalEvidence =
        sawMessageStop ||
        (!params.requireMessageStop && (sawMappedStopReason || sawStandaloneDone));
      const cleanEofAllowed =
        (params.compatibleCleanEof === "structurally_complete" &&
          sawMessageStart &&
          sawCompletedContentBlock) ||
        (!params.requireMessageStop &&
          params.compatibleCleanEof === "before_message_start" &&
          !sawMessageStart);
      if (!hasTerminalEvidence && !cleanEofAllowed) {
        throw new Error(ANTHROPIC_STREAM_INCOMPLETE_ERROR);
      }
      if (structurallyAmbiguous) {
        if (!params.requireMessageStop) {
          return { state: "unverified", reason: "compatible_structural_ambiguity" };
        }
        throw new Error(ANTHROPIC_STREAM_INCOMPLETE_ERROR);
      }
      if (cleanEofAllowed && !hasTerminalEvidence) {
        return { state: "unverified", reason: "compatible_clean_eof" };
      }
      return { state: "verified" };
    },
  };
}

export type AnthropicEndpointAuthoritySnapshot = {
  allowsCompatibleCleanEof: boolean;
  endpointClass?: string;
  requiresMessageStop: boolean;
  traceState: "exact" | "partial" | "unknown";
};

export function createAnthropicEndpointAuthority(params: {
  provider: string;
  resolveEndpointClass: (url?: string) => string;
}) {
  const provisionalEndpointClasses: string[] = [];
  const dispatchedAuthorities: Array<{
    attested: boolean;
    endpointClass?: string;
    origin?: string;
  }> = [];

  const resolveOrigin = (url: string): string | undefined => {
    try {
      const origin = new URL(url).origin;
      return origin === "null" ? undefined : origin;
    } catch {
      return undefined;
    }
  };

  return {
    observeProvisional(url?: string): void {
      try {
        provisionalEndpointClasses.push(params.resolveEndpointClass(url));
      } catch {
        provisionalEndpointClasses.push("");
      }
    },
    observePhysicalDispatch(url: string, options?: { attested?: boolean }): void {
      let endpointClass: string | undefined;
      try {
        endpointClass = params.resolveEndpointClass(url) || undefined;
      } catch {
        endpointClass = undefined;
      }
      const origin = resolveOrigin(url);
      dispatchedAuthorities.push({
        attested: options?.attested ?? true,
        ...(endpointClass ? { endpointClass } : {}),
        ...(origin ? { origin } : {}),
      });
    },
    snapshot(): AnthropicEndpointAuthoritySnapshot {
      const finalDispatched = dispatchedAuthorities.at(-1)?.endpointClass;
      const finalProvisional = provisionalEndpointClasses.at(-1);
      const endpointClass =
        dispatchedAuthorities.length > 0 ? finalDispatched : finalProvisional || undefined;
      const knownDispatchClasses = dispatchedAuthorities.flatMap((authority) =>
        authority.endpointClass ? [authority.endpointClass] : [],
      );
      const knownDispatchOrigins = dispatchedAuthorities.flatMap((authority) =>
        authority.origin ? [authority.origin] : [],
      );
      const hasUnknownDispatch = dispatchedAuthorities.some(
        (authority) => !authority.endpointClass || !authority.origin || !authority.attested,
      );
      const hasAuthorityConflict =
        new Set(knownDispatchClasses).size > 1 || new Set(knownDispatchOrigins).size > 1;
      const traceState =
        dispatchedAuthorities.length === 0
          ? endpointClass
            ? "partial"
            : "unknown"
          : hasUnknownDispatch || hasAuthorityConflict
            ? "partial"
            : endpointClass
              ? "exact"
              : "unknown";
      const endpointRequiresMessageStop =
        !endpointClass ||
        requiresAnthropicMessageStop({
          provider: params.provider,
          endpointClass,
        });
      return {
        allowsCompatibleCleanEof:
          !endpointRequiresMessageStop &&
          (traceState === "exact" || dispatchedAuthorities.length === 0),
        ...(endpointClass ? { endpointClass } : {}),
        requiresMessageStop: endpointRequiresMessageStop || traceState !== "exact",
        traceState,
      };
    },
  };
}
