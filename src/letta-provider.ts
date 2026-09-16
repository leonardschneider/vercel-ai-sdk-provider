import { ProviderV2, LanguageModelV2 } from "@ai-sdk/provider";
import {
  LettaAgentClient,
  type LettaCodeClientOptions,
  type LettaCodeRemoteClientOptions,
} from "@letta-ai/letta-agent-sdk";
import { LettaChatModel } from "./letta-chat";
import { tool } from "./letta-tools";

export interface LettaProvider extends ProviderV2 {
  /**
   * Creates a language model bound to the configured Letta backend.
   */
  (): LanguageModelV2;

  /**
   * The underlying Letta Agent SDK client for direct access.
   */
  client: LettaAgentClient;

  /**
   * Creates a tool placeholder for Letta.
   *
   * Letta agents own their own toolset, so this returns a typed placeholder
   * that satisfies the AI SDK's `ToolSet` requirements and lets tool-call
   * events render. To register tools that execute in *your* process, pass
   * `session.tools` through `providerOptions.letta.session.tools` instead.
   */
  tool: typeof tool;
}

/**
 * Create a Letta AI provider instance.
 *
 * Unlike the REST-based provider this replaces, the transport is the Letta
 * Code app-server websocket protocol, so `backend: "remote"` can reach a
 * self-hosted app server (`letta server --listen ...`).
 */
export function createLetta(
  options: LettaCodeClientOptions = { backend: "local" },
): LettaProvider {
  const client = new LettaAgentClient(options);

  const provider = function (): LanguageModelV2 {
    if (new.target) {
      throw new Error(
        "The Letta model function cannot be called with the new keyword.",
      );
    }

    if (arguments.length > 0) {
      throw new Error(
        "The Letta provider does not accept model parameters. Model configuration is managed through your Letta agents.",
      );
    }

    return new LettaChatModel(client);
  } as LettaProvider;

  provider.client = client;
  provider.tool = tool;

  return provider;
}

/**
 * Letta Cloud. Reads LETTA_API_KEY from the environment.
 */
export const lettaCloud = createLetta({
  backend: "cloud",
  ...(process.env.LETTA_API_KEY ? { apiKey: process.env.LETTA_API_KEY } : {}),
} as LettaCodeClientOptions);

/**
 * Local runtime: the SDK spawns its own Letta Code app-server on this machine
 * and keeps agent state under the local backend directory.
 */
export const lettaLocal = createLetta({ backend: "local" });

/**
 * Self-hosted app server you run yourself, e.g.
 *
 *   letta server --listen ws://0.0.0.0:4500 \
 *     --ws-auth capability-token --ws-token-file /path/to/token
 *
 * `authToken` is sent as `Authorization: Bearer <token>` on the websocket
 * upgrade, matching the capability-token mode above.
 */
export function lettaRemote(config: {
  url: string;
  authToken?: string;
  requestTimeoutMs?: number;
  /**
   * Override the WebSocket implementation. Some runtimes — notably test
   * runners such as vitest — provide a global `WebSocket` that fails to
   * connect; pass `ws` there:
   *
   *   import WebSocket from "ws";
   *   lettaRemote({ url, authToken, WebSocket });
   */
  WebSocket?: LettaCodeRemoteClientOptions["WebSocket"];
}): LettaProvider {
  return createLetta({ backend: "remote", ...config });
}
