import { describe, expect, test, vi } from "vitest";
import { LettaChatModel } from "./letta-chat";

type Part = Record<string, any>;

/** A scripted session: yields the SDKMessages you give it. */
function fakeSession(messages: any[], hooks: Record<string, any> = {}) {
  const sent: any[] = [];
  let disposed = 0;
  return {
    sent,
    get disposed() {
      return disposed;
    },
    session: {
      async send(message: any) {
        sent.push(message);
        if (hooks.sendThrows) throw hooks.sendThrows;
      },
      async *stream() {
        for (const m of messages) {
          if (m instanceof Error) throw m;
          yield m;
        }
      },
      async [Symbol.asyncDispose]() {
        disposed += 1;
      },
    },
  };
}

function fakeClient(messages: any[], hooks: Record<string, any> = {}) {
  const f = fakeSession(messages, hooks);
  const resumeSession = vi.fn(() => f.session);
  return { client: { resumeSession } as any, resumeSession, handle: f };
}

const PROMPT = [
  { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
];

function opts(extra: Record<string, any> = {}, agent: Record<string, any> = {}) {
  return {
    prompt: PROMPT,
    providerOptions: {
      letta: { agent: { id: "agent-1", ...agent } },
    },
    ...extra,
  } as any;
}

async function collect(model: LettaChatModel, o: any): Promise<Part[]> {
  const { stream } = await model.doStream(o);
  const parts: Part[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value as Part);
  }
  return parts;
}

const textOf = (parts: Part[]) =>
  parts
    .filter((p) => p.type === "text-delta")
    .map((p) => p.delta)
    .join("");

describe("LettaChatModel — turn plumbing", () => {
  test("requires an agent id", async () => {
    const { client } = fakeClient([]);
    const model = new LettaChatModel(client);
    await expect(
      model.doStream({ prompt: PROMPT, providerOptions: {} } as any),
    ).rejects.toThrow(/requires an agentId/);
  });

  test("resumes the agent's default conversation when none is given", async () => {
    const { client, resumeSession } = fakeClient([
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    await collect(new LettaChatModel(client), opts());
    expect(resumeSession).toHaveBeenCalledWith("agent-1", undefined);
  });

  test("resumes a specific conversation when one is given", async () => {
    const { client, resumeSession } = fakeClient([
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    await collect(
      new LettaChatModel(client),
      opts({}, { conversationId: "conv-9" }),
    );
    expect(resumeSession).toHaveBeenCalledWith("conv-9", undefined);
  });

  test("sends only the newest user message", async () => {
    const { client, handle } = fakeClient([
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const model = new LettaChatModel(client);
    await collect(model, {
      prompt: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        { role: "user", content: [{ type: "text", text: "newest" }] },
      ],
      providerOptions: { letta: { agent: { id: "agent-1" } } },
    } as any);
    expect(handle.sent).toEqual(["newest"]);
  });

  test("disposes the session after a turn", async () => {
    const { client, handle } = fakeClient([
      { type: "assistant", content: "hello", uuid: "u1" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    await collect(new LettaChatModel(client), opts());
    expect(handle.disposed).toBe(1);
  });

  test("aborts the server-side turn when the caller aborts", async () => {
    const aborted: string[] = [];
    const f = fakeSession([
      { type: "assistant", content: "hi", uuid: "u1" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    (f.session as any).abort = async () => {
      aborted.push("abort");
    };
    const client = { resumeSession: vi.fn(() => f.session) } as any;
    const controller = new AbortController();
    const model = new LettaChatModel(client);
    const { stream } = await model.doStream({
      ...opts(),
      abortSignal: controller.signal,
    });
    const reader = stream.getReader();
    await reader.read();
    controller.abort();
    await new Promise((r) => setTimeout(r, 0));
    expect(aborted).toEqual(["abort"]);
  });

  test("aborts immediately if the signal is already aborted", async () => {
    const aborted: string[] = [];
    const f = fakeSession([
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    (f.session as any).abort = async () => {
      aborted.push("abort");
    };
    const client = { resumeSession: vi.fn(() => f.session) } as any;
    await collect(new LettaChatModel(client), {
      ...opts(),
      abortSignal: AbortSignal.abort(),
    });
    expect(aborted).toEqual(["abort"]);
  });

  test("disposes the session even when the stream throws", async () => {
    const { client, handle } = fakeClient([new Error("transport died")]);
    const parts = await collect(new LettaChatModel(client), opts());
    expect(handle.disposed).toBe(1);
    expect(parts.some((p) => p.type === "error")).toBe(true);
  });
});

describe("LettaChatModel — text mapping and delta dedup", () => {
  test("emits a completed assistant message as text", async () => {
    const { client } = fakeClient([
      { type: "assistant", content: "hello world", uuid: "u1" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    expect(textOf(parts)).toBe("hello world");
    expect(parts.filter((p) => p.type === "text-start")).toHaveLength(1);
    expect(parts.filter((p) => p.type === "text-end")).toHaveLength(1);
  });

  test("does NOT duplicate text already streamed as deltas", async () => {
    const { client } = fakeClient([
      {
        type: "stream_event",
        uuid: "u1",
        event: { delta: { text: "hello " } },
      },
      { type: "stream_event", uuid: "u1", event: { delta: { text: "world" } } },
      { type: "assistant", content: "hello world", uuid: "u1" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    expect(textOf(parts)).toBe("hello world");
  });

  test("emits only the remainder when the final message extends the deltas", async () => {
    const { client } = fakeClient([
      { type: "stream_event", uuid: "u1", event: { delta: { text: "hel" } } },
      { type: "assistant", content: "hello", uuid: "u1" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    expect(textOf(parts)).toBe("hello");
  });

  test("falls back to full content when the final message diverges", async () => {
    const { client } = fakeClient([
      { type: "stream_event", uuid: "u1", event: { delta: { text: "xx" } } },
      { type: "assistant", content: "totally different", uuid: "u1" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    expect(textOf(parts)).toBe("xxtotally different");
  });

  test("handles two assistant messages as separate text blocks", async () => {
    const { client } = fakeClient([
      { type: "assistant", content: "one", uuid: "u1" },
      { type: "assistant", content: "two", uuid: "u2" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    expect(parts.filter((p) => p.type === "text-start")).toHaveLength(2);
    expect(parts.filter((p) => p.type === "text-end")).toHaveLength(2);
    expect(textOf(parts)).toBe("onetwo");
  });

  test("closes a dangling text block when the stream ends mid-text", async () => {
    const { client } = fakeClient([
      { type: "stream_event", uuid: "u1", event: { delta: { text: "partial" } } },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    expect(parts.filter((p) => p.type === "text-end")).toHaveLength(1);
    expect(textOf(parts)).toBe("partial");
  });
});

describe("LettaChatModel — streamed reasoning must not leak into text", () => {
  test("routes reasoning deltas to reasoning parts, not text", async () => {
    const { client } = fakeClient([
      {
        type: "stream_event",
        uuid: "r1",
        event: { delta: { reasoning: "let me think" } },
      },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    expect(textOf(parts)).toBe("");
    const reasoning = parts
      .filter((p) => p.type === "reasoning-delta")
      .map((p) => p.delta)
      .join("");
    expect(reasoning).toBe("let me think");
  });

  test("closes the reasoning block when assistant text starts", async () => {
    const { client } = fakeClient([
      {
        type: "stream_event",
        uuid: "r1",
        event: { delta: { reasoning: "thinking" } },
      },
      {
        type: "stream_event",
        uuid: "t1",
        event: { delta: { text: "answer" } },
      },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    const order = parts.map((p) => p.type);
    expect(order).toContain("reasoning-start");
    expect(order).toContain("reasoning-end");
    expect(order.indexOf("reasoning-end")).toBeLessThan(
      order.indexOf("text-start"),
    );
    expect(textOf(parts)).toBe("answer");
  });

  test("does not duplicate reasoning already streamed as deltas", async () => {
    const { client } = fakeClient([
      {
        type: "stream_event",
        uuid: "r1",
        event: { delta: { reasoning: "step one " } },
      },
      { type: "reasoning", content: "step one and two", uuid: "r1" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    const reasoning = parts
      .filter((p) => p.type === "reasoning-delta")
      .map((p) => p.delta)
      .join("");
    expect(reasoning).toBe("step one and two");
    expect(textOf(parts)).toBe("");
  });

  test("never leaves a block open across kinds", async () => {
    const { client } = fakeClient([
      { type: "stream_event", uuid: "r1", event: { delta: { reasoning: "a" } } },
      { type: "stream_event", uuid: "t1", event: { delta: { text: "b" } } },
      { type: "stream_event", uuid: "r2", event: { delta: { reasoning: "c" } } },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    // "stream-start" is the AI SDK's own envelope, not a content block.
    const starts = parts.filter(
      (p) => p.type.endsWith("-start") && p.type !== "stream-start",
    ).length;
    const ends = parts.filter((p) => p.type.endsWith("-end")).length;
    expect(starts).toBe(ends);
    expect(starts).toBe(3);
  });
});

describe("LettaChatModel — reasoning and tools", () => {
  test("maps reasoning messages", async () => {
    const { client } = fakeClient([
      { type: "reasoning", content: "thinking...", uuid: "r1" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    expect(parts.find((p) => p.type === "reasoning-delta")?.delta).toBe(
      "thinking...",
    );
    expect(parts.filter((p) => p.type === "reasoning-start")).toHaveLength(1);
    expect(parts.filter((p) => p.type === "reasoning-end")).toHaveLength(1);
  });

  test("maps a tool call using rawArguments when present", async () => {
    const { client } = fakeClient([
      {
        type: "tool_call",
        toolCallId: "tc1",
        toolName: "search",
        toolInput: { q: "x" },
        rawArguments: '{"q":"x"}',
        uuid: "u1",
      },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    const call = parts.find((p) => p.type === "tool-call")!;
    expect(call.toolCallId).toBe("tc1");
    expect(call.toolName).toBe("search");
    expect(call.input).toBe('{"q":"x"}');
  });

  test("serializes toolInput when rawArguments is absent", async () => {
    const { client } = fakeClient([
      {
        type: "tool_call",
        toolCallId: "tc2",
        toolName: "search",
        toolInput: { q: "y" },
        uuid: "u1",
      },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    expect(parts.find((p) => p.type === "tool-call")!.input).toBe('{"q":"y"}');
  });

  test("maps tool results including the error flag", async () => {
    const { client } = fakeClient([
      {
        type: "tool_result",
        toolCallId: "tc1",
        content: "boom",
        isError: true,
        uuid: "u2",
      },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    const r = parts.find((p) => p.type === "tool-result")!;
    expect(r.toolCallId).toBe("tc1");
    expect(r.isError).toBe(true);
  });
});

describe("LettaChatModel — finish reasons and errors", () => {
  const cases: Array<[string | undefined, boolean, string]> = [
    ["end_turn", true, "stop"],
    [undefined, true, "stop"],
    ["max_steps", true, "length"],
    ["tool_use", true, "tool-calls"],
    ["requires_approval", true, "tool-calls"],
    ["cancelled", true, "other"],
    ["end_turn", false, "error"],
  ];

  test.each(cases)(
    "stopReason %s (success=%s) -> %s",
    async (stopReason, success, expected) => {
      const { client } = fakeClient([
        {
          type: "result",
          success,
          stopReason,
          durationMs: 1,
          conversationId: "c",
          ...(success ? {} : { error: "failed" }),
        },
      ]);
      const parts = await collect(new LettaChatModel(client), opts());
      expect(parts.find((p) => p.type === "finish")!.finishReason).toBe(
        expected,
      );
    },
  );

  test("surfaces an error message as an error part", async () => {
    const { client } = fakeClient([
      { type: "error", message: "model exploded", stopReason: "error" },
      { type: "result", success: false, error: "model exploded", durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    const errs = parts.filter((p) => p.type === "error");
    expect(errs.length).toBeGreaterThan(0);
    expect(String(errs[0].error)).toContain("model exploded");
    expect(parts.find((p) => p.type === "finish")!.finishReason).toBe("error");
  });

  test("explains approval_conflict instead of surfacing the raw code", async () => {
    const { client } = fakeClient([
      {
        type: "error",
        message: "approval_conflict",
        approvalConflict: true,
        stopReason: "error",
      },
      { type: "result", success: false, error: "approval_conflict", durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    const msg = String(parts.find((p) => p.type === "error")!.error);
    expect(msg).toContain("permissionMode");
    expect(msg).toContain("canUseTool");
  });

  test("leaves unrelated errors untouched", async () => {
    const { client } = fakeClient([
      { type: "error", message: "rate limited", stopReason: "error" },
      { type: "result", success: false, error: "rate limited", durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    const msg = String(parts.find((p) => p.type === "error")!.error);
    expect(msg).toContain("rate limited");
    expect(msg).not.toContain("permissionMode");
  });

  test("always terminates with exactly one finish part", async () => {
    const { client } = fakeClient([
      { type: "assistant", content: "hi", uuid: "u1" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(new LettaChatModel(client), opts());
    expect(parts.filter((p) => p.type === "finish")).toHaveLength(1);
    expect(parts[parts.length - 1].type).toBe("finish");
  });
});

describe("LettaChatModel — warnings", () => {
  test("warns that AI SDK tools are not executed", async () => {
    const { client } = fakeClient([
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(
      new LettaChatModel(client),
      opts({ tools: [{ type: "function", name: "x" }] }),
    );
    const start = parts.find((p) => p.type === "stream-start")!;
    expect(
      start.warnings.some((w: any) => w.setting === "tools"),
    ).toBe(true);
  });

  test("warns about sampling settings owned by the agent", async () => {
    const { client } = fakeClient([
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const parts = await collect(
      new LettaChatModel(client),
      opts({ temperature: 0.5, topP: 0.9 }),
    );
    const settings = parts
      .find((p) => p.type === "stream-start")!
      .warnings.map((w: any) => w.setting);
    expect(settings).toContain("temperature");
    expect(settings).toContain("topP");
  });
});

describe("LettaChatModel — doGenerate", () => {
  test("accumulates text, reasoning and tool calls", async () => {
    const { client } = fakeClient([
      { type: "reasoning", content: "hmm", uuid: "r1" },
      { type: "assistant", content: "the answer", uuid: "u1" },
      {
        type: "tool_call",
        toolCallId: "tc1",
        toolName: "search",
        toolInput: {},
        uuid: "u2",
      },
      { type: "result", success: true, stopReason: "end_turn", durationMs: 1, conversationId: "c" },
    ]);
    const res = await new LettaChatModel(client).doGenerate(opts());
    const types = res.content.map((c: any) => c.type);
    expect(types).toContain("text");
    expect(types).toContain("reasoning");
    expect(types).toContain("tool-call");
    expect((res.content.find((c: any) => c.type === "text") as any).text).toBe(
      "the answer",
    );
    expect(res.finishReason).toBe("stop");
  });

  test("does not duplicate text that arrived as deltas", async () => {
    const { client } = fakeClient([
      { type: "stream_event", uuid: "u1", event: { delta: { text: "ab" } } },
      { type: "assistant", content: "abc", uuid: "u1" },
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const res = await new LettaChatModel(client).doGenerate(opts());
    const texts = res.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text);
    expect(texts.join("")).toBe("abc");
  });

  test("returns an empty content array for a silent turn", async () => {
    const { client } = fakeClient([
      { type: "result", success: true, durationMs: 1, conversationId: "c" },
    ]);
    const res = await new LettaChatModel(client).doGenerate(opts());
    expect(res.content).toEqual([]);
  });
});
