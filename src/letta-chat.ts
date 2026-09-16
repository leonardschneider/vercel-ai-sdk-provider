import {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2CallWarning,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from "@ai-sdk/provider";
import {
  LettaAgentClient,
  extractStreamTextDelta,
  type LettaCodeSession,
  type LettaCodeClientSessionOptions,
  type SDKMessage,
} from "@letta-ai/letta-agent-sdk";
import { convertToLettaMessage } from "./convert-to-letta-message";

export interface LettaProviderOptions {
  letta: {
    agent: {
      /** Required. The Letta agent to run this turn against. */
      id?: string;
      /**
       * Target a specific conversation on that agent. Omit to use the agent's
       * default conversation. Give each end user their own conversation id to
       * get isolated transcripts over one shared agent memory.
       */
      conversationId?: string;
    };
    /**
     * Passed through to createSession/resumeSession — model override,
     * permissionMode, allowedTools, client-executed `tools`, mcpServers, cwd.
     */
    session?: LettaCodeClientSessionOptions;
  };
}

const UNKNOWN_USAGE: LanguageModelV2Usage = {
  inputTokens: undefined,
  outputTokens: undefined,
  totalTokens: undefined,
};

/**
 * Letta's default permission mode requires a human to approve tool calls.
 * A provider running under generateText/streamText has no approver attached,
 * so any tool-using turn dies with a bare "approval_conflict". Say what to do
 * about it instead of surfacing the raw code.
 */
function explainError(
  raw: string,
  message: { approvalConflict?: boolean },
): string {
  const isApproval =
    message.approvalConflict === true || /approval_conflict/i.test(raw);
  if (!isApproval) return raw;
  return (
    `${raw}: the agent tried to call a tool but no approver is attached to ` +
    `this session. Set providerOptions.letta.session.permissionMode to ` +
    `"acceptEdits" or "unrestricted", or supply session.canUseTool, to let ` +
    `tool calls proceed.`
  );
}

function mapStopReason(
  stopReason: string | undefined,
  success: boolean,
): LanguageModelV2FinishReason {
  if (!success) return "error";
  switch (stopReason) {
    case "end_turn":
    case "stop":
    case undefined:
      return "stop";
    case "max_steps":
    case "max_tokens":
    case "length":
      return "length";
    case "tool_use":
    case "requires_approval":
      return "tool-calls";
    case "cancelled":
    case "aborted":
      return "other";
    default:
      return "stop";
  }
}

export class LettaChatModel implements LanguageModelV2 {
  readonly specificationVersion = "v2" as const;
  readonly provider = "letta";
  readonly modelId = "placeholder"; // model selection lives on the Letta agent
  readonly supportedUrls = {};

  private readonly client: LettaAgentClient;

  constructor(client: LettaAgentClient) {
    this.client = client;
  }

  private getArgs(options: LanguageModelV2CallOptions) {
    const warnings: LanguageModelV2CallWarning[] = [];

    const letta = (
      options as LanguageModelV2CallOptions & {
        providerOptions?: LettaProviderOptions;
      }
    ).providerOptions?.letta;

    const agentId = letta?.agent?.id;
    if (!agentId) {
      throw new Error(
        "Letta provider requires an agentId in providerOptions. Usage: " +
          "streamText({ model: letta(), providerOptions: { letta: { agent: { id: 'agent-...' } } }, ... })",
      );
    }

    // A Letta agent owns its toolset; tools supplied through the AI SDK call
    // are not silently executed. Surface that rather than dropping it quietly.
    if (options.tools && options.tools.length > 0) {
      warnings.push({
        type: "unsupported-setting",
        setting: "tools",
        details:
          "Letta agents execute their own tools, so these definitions are not " +
          "invoked. Registering them as placeholders (no `execute`) is still " +
          "recommended so the AI SDK recognises tool-call parts instead of " +
          "raising AI_NoSuchToolError. For tools that should run in your own " +
          "process, use providerOptions.letta.session.tools.",
      });
    }
    for (const setting of ["temperature", "topP", "topK", "seed"] as const) {
      if (options[setting] !== undefined) {
        warnings.push({
          type: "unsupported-setting",
          setting,
          details: "Sampling settings are configured on the Letta agent.",
        });
      }
    }

    return {
      agentId,
      conversationId: letta?.agent?.conversationId,
      sessionOptions: letta?.session,
      message: convertToLettaMessage(options.prompt),
      warnings,
    };
  }

  private openSession(args: ReturnType<LettaChatModel["getArgs"]>) {
    // resumeSession(agentId) continues the agent's default conversation;
    // resumeSession(conversationId) continues that specific one.
    return this.client.resumeSession(
      args.conversationId ?? args.agentId,
      args.sessionOptions,
    );
  }

  /**
   * One turn, mapped from SDKMessage events to AI SDK stream parts.
   * Shared by doStream and doGenerate so both agree on semantics.
   */
  private async *runTurn(
    args: ReturnType<LettaChatModel["getArgs"]>,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LanguageModelV2StreamPart> {
    const session: LettaCodeSession = this.openSession(args);

    // Without this the caller aborting only stops us reading: the agent keeps
    // running the turn server-side and burning tokens. Tell it to stop.
    let onAbort: (() => void) | undefined;
    if (abortSignal) {
      onAbort = () => {
        void session.abort().catch(() => {
          /* the turn may already be finished */
        });
      };
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    let finishReason: LanguageModelV2FinishReason = "stop";
    let usage: LanguageModelV2Usage = UNKNOWN_USAGE;

    // Content arrives twice over: as token deltas (stream_event) and again as
    // a completed assistant/reasoning message. Track the open block and what
    // it already emitted so the completed message does not duplicate it.
    //
    // stream_event deltas carry a `kind` telling assistant text apart from
    // reasoning tokens; they must not be merged into one block.
    type Block = { kind: "text" | "reasoning"; id: string; streamed: string };
    // Held in a container: TypeScript does not track assignments made inside
    // the closures below, so a bare `let` would narrow to `never` at each use.
    const state: { block: Block | null } = { block: null };

    const closeBlock = (): LanguageModelV2StreamPart | null => {
      const open = state.block;
      if (!open) return null;
      state.block = null;
      return open.kind === "text"
        ? ({ type: "text-end", id: open.id } as LanguageModelV2StreamPart)
        : ({ type: "reasoning-end", id: open.id } as LanguageModelV2StreamPart);
    };

    const openBlock = (
      kind: "text" | "reasoning",
      id: string,
    ): LanguageModelV2StreamPart => {
      state.block = { kind, id, streamed: "" };
      return kind === "text"
        ? ({ type: "text-start", id } as LanguageModelV2StreamPart)
        : ({ type: "reasoning-start", id } as LanguageModelV2StreamPart);
    };

    /** Append to the open block and produce its delta part. */
    const appendDelta = (text: string): LanguageModelV2StreamPart => {
      const open = state.block;
      if (!open) {
        throw new Error("internal: delta emitted with no open block");
      }
      open.streamed += text;
      return open.kind === "text"
        ? ({
            type: "text-delta",
            id: open.id,
            delta: text,
          } as LanguageModelV2StreamPart)
        : ({
            type: "reasoning-delta",
            id: open.id,
            delta: text,
          } as LanguageModelV2StreamPart);
    };

    /** Ensure a block of `kind` is open, closing a different one first. */
    function* ensureBlock(
      kind: "text" | "reasoning",
      id: string,
    ): Generator<LanguageModelV2StreamPart> {
      if (state.block && state.block.kind !== kind) {
        const end = closeBlock();
        if (end) yield end;
      }
      if (!state.block) yield openBlock(kind, id);
    }

    /** Emit `content` for a completed message, skipping what deltas covered. */
    function* settle(
      kind: "text" | "reasoning",
      id: string,
      content: string,
    ): Generator<LanguageModelV2StreamPart> {
      yield* ensureBlock(kind, id);
      const already = state.block?.streamed ?? "";
      if (content && content !== already) {
        const remainder = content.startsWith(already)
          ? content.slice(already.length)
          : content;
        if (remainder) yield appendDelta(remainder);
      }
      const end = closeBlock();
      if (end) yield end;
    }

    try {
      await session.send(args.message);

      for await (const message of session.stream() as AsyncGenerator<SDKMessage>) {
        switch (message.type) {
          case "stream_event": {
            const delta = extractStreamTextDelta(message.event);
            if (delta?.text) {
              const kind = delta.kind === "reasoning" ? "reasoning" : "text";
              yield* ensureBlock(kind, message.uuid);
              yield appendDelta(delta.text);
            }
            break;
          }

          case "assistant": {
            yield* settle("text", message.uuid, message.content ?? "");
            break;
          }

          case "reasoning": {
            yield* settle("reasoning", message.uuid, message.content ?? "");
            break;
          }

          case "tool_call": {
            yield {
              type: "tool-call",
              toolCallId: message.toolCallId,
              toolName: message.toolName,
              input:
                message.rawArguments ?? JSON.stringify(message.toolInput ?? {}),
            };
            break;
          }

          case "tool_result": {
            yield {
              type: "tool-result",
              toolCallId: message.toolCallId,
              toolName: "",
              result: message.content,
              isError: message.isError,
            } as LanguageModelV2StreamPart;
            break;
          }

          case "error": {
            finishReason = "error";
            yield {
              type: "error",
              error: new Error(explainError(message.message, message)),
            };
            break;
          }

          case "result": {
            finishReason = mapStopReason(message.stopReason, message.success);
            if (!message.success && message.error) {
              yield {
                type: "error",
                error: new Error(explainError(message.error, message)),
              };
            }
            break;
          }

          default:
            break;
        }
      }

      const dangling = closeBlock();
      if (dangling) yield dangling;
    } finally {
      if (abortSignal && onAbort) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      await session[Symbol.asyncDispose]?.();
    }

    yield { type: "finish", finishReason, usage };
  }

  async doGenerate(options: LanguageModelV2CallOptions) {
    const args = this.getArgs(options);

    const content: LanguageModelV2Content[] = [];
    let finishReason: LanguageModelV2FinishReason = "stop";
    let usage: LanguageModelV2Usage = UNKNOWN_USAGE;
    let text = "";

    for await (const part of this.runTurn(args, options.abortSignal)) {
      switch (part.type) {
        case "text-delta":
          text += part.delta;
          break;
        case "text-end":
          if (text) content.push({ type: "text", text });
          text = "";
          break;
        case "reasoning-delta":
          content.push({ type: "reasoning", text: part.delta });
          break;
        case "tool-call":
          content.push({
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          });
          break;
        case "finish":
          finishReason = part.finishReason;
          usage = part.usage;
          break;
        default:
          break;
      }
    }

    if (text) content.push({ type: "text", text });

    return {
      content,
      finishReason,
      usage,
      warnings: args.warnings,
      request: { body: { agentId: args.agentId, message: args.message } },
    };
  }

  async doStream(options: LanguageModelV2CallOptions) {
    const args = this.getArgs(options);
    const turn = this.runTurn(args, options.abortSignal);

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings: args.warnings });
      },
      async pull(controller) {
        try {
          const { value, done } = await turn.next();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          controller.enqueue({
            type: "error",
            error: error instanceof Error ? error : new Error(String(error)),
          });
          controller.close();
        }
      },
      async cancel() {
        await turn.return(undefined as never);
      },
    });

    return {
      stream,
      request: { body: { agentId: args.agentId, message: args.message } },
    };
  }
}
