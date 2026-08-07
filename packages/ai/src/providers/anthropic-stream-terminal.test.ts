import { describe, expect, it } from "vitest";
import {
  createAnthropicEndpointAuthority,
  createAnthropicStreamTerminalCompleteness,
} from "./anthropic-stream-terminal.js";

describe("Anthropic stream terminal authority", () => {
  it.each([
    {
      provider: "anthropic",
      endpointClass: "anthropic-public",
      expected: true,
    },
    {
      provider: "provider-alias",
      endpointClass: "anthropic-public",
      expected: true,
    },
    {
      provider: " Anthropic ",
      endpointClass: "default",
      expected: true,
    },
    {
      provider: "provider-alias",
      endpointClass: "default",
      expected: true,
    },
    {
      provider: "anthropic",
      endpointClass: "custom",
      expected: false,
    },
    {
      provider: "provider-alias",
      endpointClass: "custom",
      expected: false,
    },
  ])(
    "returns $expected for $provider on $endpointClass",
    ({ provider, endpointClass, expected }) => {
      const authority = createAnthropicEndpointAuthority({
        provider,
        resolveEndpointClass: () => endpointClass,
      });
      authority.observePhysicalDispatch("https://example.test");
      expect(authority.snapshot().requiresMessageStop).toBe(expected);
    },
  );

  it("requires strict terminal authority across same-class cross-origin redirects", () => {
    const authority = createAnthropicEndpointAuthority({
      provider: "anthropic",
      resolveEndpointClass: () => "custom",
    });
    authority.observePhysicalDispatch("https://first.example/v1/messages");
    authority.observePhysicalDispatch("https://second.example/v1/messages");

    expect(authority.snapshot()).toEqual({
      allowsCompatibleCleanEof: false,
      endpointClass: "custom",
      requiresMessageStop: true,
      traceState: "partial",
    });
  });

  it("retains exact authority across repeated same-origin dispatches", () => {
    const authority = createAnthropicEndpointAuthority({
      provider: "anthropic",
      resolveEndpointClass: () => "custom",
    });
    authority.observePhysicalDispatch("https://compatible.example/v1/messages");
    authority.observePhysicalDispatch("https://compatible.example/v1/messages?retry=1");

    expect(authority.snapshot()).toEqual({
      allowsCompatibleCleanEof: true,
      endpointClass: "custom",
      requiresMessageStop: false,
      traceState: "exact",
    });
  });

  it("keeps legacy physical observations partial without attested provenance", () => {
    const authority = createAnthropicEndpointAuthority({
      provider: "anthropic",
      resolveEndpointClass: () => "custom",
    });
    authority.observePhysicalDispatch("https://compatible.example/v1/messages", {
      attested: false,
    });

    expect(authority.snapshot()).toEqual({
      allowsCompatibleCleanEof: false,
      endpointClass: "custom",
      requiresMessageStop: true,
      traceState: "partial",
    });
  });

  it.each([
    { endpointClass: "custom", allowsCompatibleCleanEof: true },
    { endpointClass: "anthropic-public", allowsCompatibleCleanEof: false },
    { endpointClass: "", allowsCompatibleCleanEof: false },
  ])(
    "classifies provisional $endpointClass authority without relaxing message_stop",
    ({ endpointClass, allowsCompatibleCleanEof }) => {
      const authority = createAnthropicEndpointAuthority({
        provider: "anthropic",
        resolveEndpointClass: () => endpointClass,
      });
      authority.observeProvisional("https://example.test");

      expect(authority.snapshot()).toMatchObject({
        allowsCompatibleCleanEof,
        requiresMessageStop: true,
        traceState: endpointClass ? "partial" : "unknown",
      });
    },
  );

  it("accepts standalone DONE only for compatible endpoints", () => {
    const compatible = createAnthropicStreamTerminalCompleteness({
      requireMessageStop: false,
    });
    compatible.observeStandaloneDone();
    expect(() => compatible.assertComplete()).not.toThrow();

    const official = createAnthropicStreamTerminalCompleteness({
      requireMessageStop: true,
    });
    official.observeStandaloneDone();
    expect(() => official.assertComplete()).toThrow("ended before message_stop");
  });

  it("requires non-empty mapped stop reasons and rejects bare EOF", () => {
    const blankReason = createAnthropicStreamTerminalCompleteness({
      requireMessageStop: false,
    });
    blankReason.observeMappedStopReason("  ");
    expect(() => blankReason.assertComplete()).toThrow("ended before message_stop");

    const bareEof = createAnthropicStreamTerminalCompleteness({
      requireMessageStop: false,
    });
    expect(() => bareEof.assertComplete()).toThrow("ended before message_stop");
  });

  it("preserves structurally complete compatible clean EOF as unverified", () => {
    const compatible = createAnthropicStreamTerminalCompleteness({
      compatibleCleanEof: "structurally_complete",
      requireMessageStop: false,
    });
    compatible.observeMessageStart();
    compatible.observeContentBlockStart(0);
    compatible.observeContentBlockStop(0);

    expect(compatible.assertComplete()).toEqual({
      state: "unverified",
      reason: "compatible_clean_eof",
    });
  });

  it("allows explicitly trusted compatible clean EOF while message_stop remains strict", () => {
    const compatible = createAnthropicStreamTerminalCompleteness({
      compatibleCleanEof: "structurally_complete",
      requireMessageStop: true,
    });
    compatible.observeMessageStart();
    compatible.observeContentBlockStart(0);
    compatible.observeContentBlockStop(0);

    expect(compatible.assertComplete()).toEqual({
      state: "unverified",
      reason: "compatible_clean_eof",
    });
  });

  it("rejects compatible clean EOF after message_start alone", () => {
    const compatible = createAnthropicStreamTerminalCompleteness({
      compatibleCleanEof: "structurally_complete",
      requireMessageStop: false,
    });
    compatible.observeMessageStart();

    expect(() => compatible.assertComplete()).toThrow("ended before message_stop");
  });

  it.each(["message_stop", "mapped_stop_reason", "standalone_done"] as const)(
    "rejects %s when a content block remains open",
    (terminal) => {
      const compatible = createAnthropicStreamTerminalCompleteness({
        requireMessageStop: false,
      });
      compatible.observeContentBlockStart(0);
      if (terminal === "message_stop") {
        compatible.observeMessageStop();
      } else if (terminal === "mapped_stop_reason") {
        compatible.observeMappedStopReason("end_turn");
      } else {
        compatible.observeStandaloneDone();
      }
      expect(() => compatible.assertComplete()).toThrow("ended before message_stop");
    },
  );

  it.each([
    {
      name: "reused content block index",
      observe: (terminal: ReturnType<typeof createAnthropicStreamTerminalCompleteness>) => {
        terminal.observeMessageStart();
        terminal.observeContentBlockStart(0);
        terminal.observeContentBlockStop(0);
        terminal.observeContentBlockStart(0);
        terminal.observeContentBlockStop(0);
        terminal.observeMessageStop();
      },
    },
    {
      name: "message delta before block stop",
      observe: (terminal: ReturnType<typeof createAnthropicStreamTerminalCompleteness>) => {
        terminal.observeMessageStart();
        terminal.observeContentBlockStart(0);
        terminal.observeMessageDelta();
        terminal.observeContentBlockStop(0);
        terminal.observeMessageStop();
      },
    },
    {
      name: "block after message delta",
      observe: (terminal: ReturnType<typeof createAnthropicStreamTerminalCompleteness>) => {
        terminal.observeMessageStart();
        terminal.observeMessageDelta();
        terminal.observeContentBlockStart(0);
        terminal.observeContentBlockStop(0);
        terminal.observeMessageStop();
      },
    },
    {
      name: "duplicate message delta",
      observe: (terminal: ReturnType<typeof createAnthropicStreamTerminalCompleteness>) => {
        terminal.observeMessageStart();
        terminal.observeMessageDelta();
        terminal.observeMessageDelta();
        terminal.observeMessageStop();
      },
    },
    {
      name: "invalid content block index",
      observe: (terminal: ReturnType<typeof createAnthropicStreamTerminalCompleteness>) => {
        terminal.observeMessageStart();
        terminal.observeContentBlockStart("0");
        terminal.observeContentBlockStop("0");
        terminal.observeMessageStop();
      },
    },
  ])("rejects $name under strict authority and downgrades compatible authority", ({ observe }) => {
    const strict = createAnthropicStreamTerminalCompleteness({ requireMessageStop: true });
    observe(strict);
    expect(() => strict.assertComplete()).toThrow("ended before message_stop");

    const compatible = createAnthropicStreamTerminalCompleteness({ requireMessageStop: false });
    observe(compatible);
    expect(compatible.assertComplete()).toEqual({
      state: "unverified",
      reason: "compatible_structural_ambiguity",
    });
  });
});
