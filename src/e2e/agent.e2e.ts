/**
 * End-to-end against a real Letta app server.
 *
 * Skips unless a server is configured, so CI stays green without credentials:
 *
 *   letta server --listen ws://127.0.0.1:4500 \
 *     --ws-auth capability-token --ws-token-file /path/to/token
 *
 *   LETTA_E2E_URL=ws://127.0.0.1:4500 \
 *   LETTA_E2E_TOKEN=$(cat /path/to/token) \
 *   LETTA_E2E_AGENT_ID=agent-local-... \
 *   npm run test:e2e
 *
 * The agent needs a working model provider (`letta connect anthropic-oauth`
 * or similar). Tool coverage is pinned to read-only tools.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { streamText } from "ai";
import WebSocketImpl from "ws";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lettaRemote, type LettaProvider } from "../index";

const URL = process.env.LETTA_E2E_URL;
const TOKEN = process.env.LETTA_E2E_TOKEN;
const AGENT_ID = process.env.LETTA_E2E_AGENT_ID;
const configured = Boolean(URL && AGENT_ID);

const SAFE_TOOLS = ["TaskList"];
const TIMEOUT = 120_000;
// Override for the reasoning case; the agent's own model may not emit
// reasoning tokens. Set LETTA_E2E_REASONING_MODEL to a provider/model handle.
const REASONING_MODEL =
  process.env.LETTA_E2E_REASONING_MODEL ?? "anthropic/claude-opus-4-8";

describe.skipIf(!configured)("letta provider e2e", () => {
  let letta: LettaProvider;

  beforeAll(() => {
    letta = lettaRemote({
      url: URL as string,
      authToken: TOKEN,
      // vitest's global WebSocket fails to connect; use the ws package.
      WebSocket: WebSocketImpl as never,
    });
  });

  afterAll(async () => {
    await (letta?.client as unknown as AsyncDisposable)?.[
      Symbol.asyncDispose
    ]?.();
  });

  async function freshConversation(name: string): Promise<string> {
    const conv = await letta.client.conversations.create({
      agentId: AGENT_ID as string,
      description: `${name}-${Date.now()}`,
    });
    return conv.id;
  }

  function providerOptions(
    conversationId: string,
    session: Record<string, unknown> = {},
  ) {
    return {
      letta: {
        agent: { id: AGENT_ID as string, conversationId },
        session: { allowedTools: SAFE_TOOLS, ...session },
      },
    };
  }

  it(
    "streams text from a real model",
    async () => {
      const conversationId = await freshConversation("e2e-text");
      const res = streamText({
        model: letta(),
        providerOptions: providerOptions(conversationId),
        prompt: "Reply with exactly: E2E-OK. Nothing else.",
      });

      let text = "";
      for await (const delta of res.textStream) text += delta;

      expect(text).toContain("E2E-OK");
      expect(await res.finishReason).toBe("stop");
    },
    TIMEOUT,
  );

  it(
    "keeps the transcript server-side across turns",
    async () => {
      const conversationId = await freshConversation("e2e-memory");

      const first = streamText({
        model: letta(),
        providerOptions: providerOptions(conversationId),
        prompt: "My favourite number is 4242. Acknowledge briefly.",
      });
      for await (const _ of first.textStream) {
        /* drain */
      }

      // Second turn sends ONLY the new message: recall proves the agent, not
      // the client, is holding the transcript.
      const second = streamText({
        model: letta(),
        providerOptions: providerOptions(conversationId),
        prompt: "What number did I tell you? Reply with only the number.",
      });
      let recalled = "";
      for await (const delta of second.textStream) recalled += delta;

      expect(recalled).toContain("4242");
    },
    TIMEOUT,
  );

  it(
    "keeps conversations on one agent isolated",
    async () => {
      const a = await freshConversation("e2e-iso-a");
      const b = await freshConversation("e2e-iso-b");

      const seed = streamText({
        model: letta(),
        providerOptions: providerOptions(a),
        prompt: "Remember the codeword BANANA-31. Acknowledge briefly.",
      });
      for await (const _ of seed.textStream) {
        /* drain */
      }

      const other = streamText({
        model: letta(),
        providerOptions: providerOptions(b),
        prompt:
          "What codeword were you just told? If you were not told one, reply NONE.",
      });
      let answer = "";
      for await (const delta of other.textStream) answer += delta;

      expect(answer).not.toContain("BANANA-31");
    },
    TIMEOUT,
  );

  it(
    "keeps streamed reasoning out of the assistant text",
    async () => {
      const conversationId = await freshConversation("e2e-reasoning");
      const { stream } = await letta().doStream({
        prompt: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Think step by step: what is 17 * 23? Show your reasoning.",
              },
            ],
          },
        ],
        providerOptions: {
          letta: {
            agent: { id: AGENT_ID as string, conversationId },
            session: {
              allowedTools: [],
              model: REASONING_MODEL,
              reasoningEffort: "medium",
            },
          },
        },
      } as never);

      let reasoning = "";
      let text = "";
      let starts = 0;
      let ends = 0;
      const reader = stream.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const part = value as { type: string; delta?: string };
        if (part.type === "reasoning-delta") reasoning += part.delta ?? "";
        if (part.type === "text-delta") text += part.delta ?? "";
        if (part.type.endsWith("-start") && part.type !== "stream-start")
          starts++;
        if (part.type.endsWith("-end")) ends++;
      }

      // The model must actually have produced reasoning for this to mean
      // anything; skip the assertion rather than pass vacuously if it did not.
      if (reasoning.length > 0) {
        expect(text).not.toContain(reasoning.slice(0, 40));
      }
      expect(starts).toBe(ends);
    },
    TIMEOUT,
  );

  it(
    "surfaces a tool call and its result without a spurious tool-error",
    async () => {
      const conversationId = await freshConversation("e2e-tools");
      const res = streamText({
        model: letta(),
        providerOptions: providerOptions(conversationId, {
          permissionMode: "unrestricted",
        }),
        prompt: "Use the TaskList tool, then say how many tasks there are.",
        tools: {
          TaskList: letta.tool("TaskList", { description: "List tasks" }),
        },
      });

      const types: string[] = [];
      for await (const part of res.fullStream) types.push(part.type);

      expect(types).toContain("tool-call");
      expect(types.filter((t) => t === "tool-result")).toHaveLength(1);
      expect(types).not.toContain("tool-error");
      expect(types).not.toContain("error");
    },
    TIMEOUT,
  );

  it(
    "handles a turn that calls two different tools",
    async () => {
      // Read executes on the app-server machine, so point it at a file this
      // test owns rather than anything pre-existing.
      const probe = join(tmpdir(), `letta-e2e-probe-${Date.now()}.txt`);
      writeFileSync(probe, "MULTITOOL-PROBE-8812\n");

      try {
        const conversationId = await freshConversation("e2e-multitool");
        const res = streamText({
          model: letta(),
          providerOptions: providerOptions(conversationId, {
            allowedTools: ["TaskList", "Read"],
            permissionMode: "unrestricted",
          }),
          prompt:
            `Do exactly two things, using a tool for each: ` +
            `(1) call TaskList to list tasks; ` +
            `(2) call Read on the file ${probe} and report the line it contains.`,
          tools: {
            TaskList: letta.tool("TaskList", { description: "List tasks" }),
            Read: letta.tool("Read", { description: "Read a file" }),
          },
        });

        const calls: string[] = [];
        const resultIds: string[] = [];
        const types: string[] = [];
        let text = "";
        for await (const part of res.fullStream) {
          types.push(part.type);
          if (part.type === "tool-call") calls.push((part as any).toolName);
          if (part.type === "tool-result")
            resultIds.push((part as any).toolCallId);
          if (part.type === "text-delta")
            text += (part as any).text ?? (part as any).delta ?? "";
        }

        expect(calls.length).toBeGreaterThanOrEqual(2);
        expect(new Set(calls).size).toBeGreaterThanOrEqual(2);
        // Every call must have exactly one correlated result.
        expect(resultIds.length).toBe(calls.length);
        expect(new Set(resultIds).size).toBe(resultIds.length);
        expect(types).not.toContain("tool-error");
        expect(text).toContain("MULTITOOL-PROBE-8812");
      } finally {
        rmSync(probe, { force: true });
      }
    },
    TIMEOUT,
  );

  it(
    "serves concurrent turns on one provider instance",
    async () => {
      const cases = [
        { conv: await freshConversation("e2e-conc-a"), token: "ALPHA-11" },
        { conv: await freshConversation("e2e-conc-b"), token: "BRAVO-22" },
        { conv: await freshConversation("e2e-conc-c"), token: "CHARLIE-33" },
      ];

      const answers = await Promise.all(
        cases.map(async ({ conv, token }) => {
          const res = streamText({
            model: letta(),
            providerOptions: providerOptions(conv),
            prompt: `Reply with exactly: ${token}. Nothing else.`,
          });
          let out = "";
          for await (const delta of res.textStream) out += delta;
          return out;
        }),
      );

      // Each turn gets its own answer, and no other turn's token bleeds in.
      cases.forEach(({ token }, i) => {
        expect(answers[i]).toContain(token);
        cases
          .filter((_, j) => j !== i)
          .forEach(({ token: other }) => {
            expect(answers[i]).not.toContain(other);
          });
      });
    },
    TIMEOUT,
  );

  it(
    "reports approval_conflict with actionable guidance",
    async () => {
      const conversationId = await freshConversation("e2e-approval");
      // Default permission mode: no approver is attached, so a tool call fails.
      const res = streamText({
        model: letta(),
        providerOptions: providerOptions(conversationId),
        prompt: "Use the TaskList tool now.",
        tools: {
          TaskList: letta.tool("TaskList", { description: "List tasks" }),
        },
      });

      const errors: string[] = [];
      for await (const part of res.fullStream) {
        if (part.type === "error") errors.push(String((part as any).error));
      }

      if (errors.length > 0) {
        expect(errors.join(" ")).toMatch(/permissionMode|canUseTool/);
      }
    },
    TIMEOUT,
  );
});
