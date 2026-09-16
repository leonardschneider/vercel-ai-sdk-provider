import { describe, expect, test } from "vitest";
import { convertToAiSdkMessage } from "./convert-to-ai-sdk-message";

describe("convertToAiSdkMessage", () => {
  test("maps assistant messages to text parts", () => {
    const out = convertToAiSdkMessage([
      { type: "assistant", content: "hello", uuid: "u1" },
    ] as any);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("assistant");
    expect((out[0].parts[0] as any).text).toBe("hello");
  });

  test("maps reasoning messages to reasoning parts", () => {
    const out = convertToAiSdkMessage([
      { type: "reasoning", content: "thinking", uuid: "r1" },
    ] as any);
    expect((out[0].parts[0] as any).type).toBe("reasoning");
    expect((out[0].parts[0] as any).text).toBe("thinking");
  });

  test("a tool result upgrades its matching call in place", () => {
    const out = convertToAiSdkMessage([
      {
        type: "tool_call",
        toolCallId: "tc1",
        toolName: "search",
        toolInput: { q: "x" },
        uuid: "u1",
      },
      {
        type: "tool_result",
        toolCallId: "tc1",
        content: "found it",
        isError: false,
        uuid: "u2",
      },
    ] as any);
    // One message for the call; the result mutates it rather than adding one.
    expect(out).toHaveLength(1);
    const part = out[0].parts[0] as any;
    expect(part.type).toBe("tool-search");
    expect(part.state).toBe("output-available");
    expect(part.output).toBe("found it");
  });

  test("an errored tool result sets output-error with errorText", () => {
    const out = convertToAiSdkMessage([
      {
        type: "tool_call",
        toolCallId: "tc1",
        toolName: "search",
        toolInput: {},
        uuid: "u1",
      },
      {
        type: "tool_result",
        toolCallId: "tc1",
        content: "exploded",
        isError: true,
        uuid: "u2",
      },
    ] as any);
    const part = out[0].parts[0] as any;
    expect(part.state).toBe("output-error");
    expect(part.errorText).toBe("exploded");
    expect(part.output).toBeUndefined();
  });

  test("an orphan tool result still produces a message", () => {
    const out = convertToAiSdkMessage([
      {
        type: "tool_result",
        toolCallId: "nope",
        content: "orphan",
        isError: false,
        uuid: "u1",
      },
    ] as any);
    expect(out).toHaveLength(1);
    expect((out[0].parts[0] as any).toolCallId).toBe("nope");
  });

  test("does not cross-wire two different tool calls", () => {
    const out = convertToAiSdkMessage([
      { type: "tool_call", toolCallId: "a", toolName: "one", toolInput: {}, uuid: "u1" },
      { type: "tool_call", toolCallId: "b", toolName: "two", toolInput: {}, uuid: "u2" },
      { type: "tool_result", toolCallId: "b", content: "B", isError: false, uuid: "u3" },
      { type: "tool_result", toolCallId: "a", content: "A", isError: false, uuid: "u4" },
    ] as any);
    expect(out).toHaveLength(2);
    const byId = Object.fromEntries(
      out.map((m) => [(m.parts[0] as any).toolCallId, m.parts[0] as any]),
    );
    expect(byId.a.output).toBe("A");
    expect(byId.b.output).toBe("B");
  });

  test("filters out kinds not in allowMessageTypes", () => {
    const out = convertToAiSdkMessage(
      [
        { type: "assistant", content: "kept", uuid: "u1" },
        { type: "reasoning", content: "dropped", uuid: "r1" },
      ] as any,
      { allowMessageTypes: ["assistant"] },
    );
    expect(out).toHaveLength(1);
    expect((out[0].parts[0] as any).text).toBe("kept");
  });

  test("ignores non-renderable kinds by default", () => {
    const out = convertToAiSdkMessage([
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
      { type: "init" },
    ] as any);
    expect(out).toEqual([]);
  });
});
