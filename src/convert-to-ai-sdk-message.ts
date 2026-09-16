import type { SDKMessage } from "@letta-ai/letta-agent-sdk";
import {
  UIMessage,
  TextUIPart,
  ToolUIPart,
  ReasoningUIPart,
} from "ai";

type DynamicToolType = `tool-${string}`;

export interface ConvertToAiSdkMessageOptions {
  /** SDKMessage kinds to keep. Defaults to the renderable conversation kinds. */
  allowMessageTypes?: SDKMessage["type"][];
}

const DEFAULT_ALLOWED: SDKMessage["type"][] = [
  "assistant",
  "reasoning",
  "tool_call",
  "tool_result",
];

/**
 * Convert a batch of Letta Agent SDK messages (e.g. from
 * `session.listMessages()`) into AI SDK UI messages for rendering.
 *
 * Tool calls and their results are correlated by `toolCallId` so a result
 * upgrades the matching call part to `output-available` rather than appearing
 * as a separate message.
 */
export function convertToAiSdkMessage(
  messages: SDKMessage[],
  options: ConvertToAiSdkMessageOptions = {},
): UIMessage[] {
  const allowed = new Set(options.allowMessageTypes ?? DEFAULT_ALLOWED);
  const result: UIMessage[] = [];
  const toolParts = new Map<string, ToolUIPart>();

  for (const message of messages) {
    if (!allowed.has(message.type)) continue;

    switch (message.type) {
      case "assistant": {
        const part: TextUIPart = { type: "text", text: message.content };
        result.push({
          id: message.uuid,
          role: "assistant",
          parts: [part],
        } as UIMessage);
        break;
      }

      case "reasoning": {
        const part: ReasoningUIPart = {
          type: "reasoning",
          text: message.content,
        };
        result.push({
          id: message.uuid,
          role: "assistant",
          parts: [part],
        } as UIMessage);
        break;
      }

      case "tool_call": {
        const part = {
          type: `tool-${message.toolName}` as DynamicToolType,
          toolCallId: message.toolCallId,
          state: "input-available",
          input: message.toolInput ?? {},
        } as ToolUIPart;
        toolParts.set(message.toolCallId, part);
        result.push({
          id: message.uuid,
          role: "assistant",
          parts: [part],
        } as UIMessage);
        break;
      }

      case "tool_result": {
        const pending = toolParts.get(message.toolCallId);
        if (pending) {
          // Upgrade the existing call part in place.
          Object.assign(pending, {
            state: message.isError ? "output-error" : "output-available",
            ...(message.isError
              ? { errorText: message.content }
              : { output: message.content }),
          });
          toolParts.delete(message.toolCallId);
        } else {
          result.push({
            id: message.uuid,
            role: "assistant",
            parts: [
              {
                type: "tool-unknown" as DynamicToolType,
                toolCallId: message.toolCallId,
                state: message.isError ? "output-error" : "output-available",
                ...(message.isError
                  ? { errorText: message.content }
                  : { output: message.content }),
              } as ToolUIPart,
            ],
          } as UIMessage);
        }
        break;
      }

      default:
        break;
    }
  }

  return result;
}
