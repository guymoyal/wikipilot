import type Anthropic from "@anthropic-ai/sdk";
import type { CreateMessage } from "./investigate.js";

export type ProviderId = "anthropic" | "openai" | "gemini" | "custom";

export interface ProviderInfo {
  id: ProviderId;
  /** Shown in the wizard's provider list. */
  label: string;
  /** Where the key lives in the environment and in a saved .env. */
  envVar: string;
  /** Absent for custom — the user must name a model. */
  defaultModel?: string;
  /** OpenAI-compatible base URL. Absent for anthropic (SDK) and custom (user-supplied). */
  baseUrl?: string;
  /** Where to go get a key for this provider. Absent for custom — there's no single place. */
  keyUrl?: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  anthropic: {
    id: "anthropic",
    label: "Claude — the default, and what the investigation prompt is tuned on",
    envVar: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-5",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    envVar: "OPENAI_API_KEY",
    defaultModel: "gpt-5.5",
    baseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    envVar: "GEMINI_API_KEY",
    defaultModel: "gemini-3.5-flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  custom: {
    id: "custom",
    label: "Other (any OpenAI-compatible endpoint — OpenRouter, Ollama, LM Studio)",
    envVar: "WIKI_INIT_API_KEY",
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as string[]).includes(value);
}

type JsonRecord = Record<string, unknown>;

/**
 * Anthropic request → OpenAI chat.completions body. cache_control is dropped:
 * OpenAI and Gemini cache prompts implicitly, so the mark has no equivalent.
 */
export function toOpenAIRequest(req: Anthropic.MessageCreateParamsNonStreaming): JsonRecord {
  const messages: JsonRecord[] = [];

  const systemText =
    typeof req.system === "string"
      ? req.system
      : (req.system ?? []).map((block) => ("text" in block ? block.text : "")).join("\n");
  if (systemText) messages.push({ role: "system", content: systemText });

  for (const message of req.messages) {
    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      const text = message.content
        .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const toolCalls = message.content
        .filter((b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      messages.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else {
      // A user turn interleaves plain text and tool results; OpenAI wants tool
      // results as their own role:"tool" messages, in order.
      for (const block of message.content) {
        if (block.type === "tool_result") {
          const content =
            typeof block.content === "string"
              ? block.content
              : (block.content ?? [])
                  .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
                  .join("\n");
          messages.push({ role: "tool", tool_call_id: block.tool_use_id, content });
        } else if (block.type === "text") {
          messages.push({ role: "user", content: block.text });
        }
      }
    }
  }

  const tools = (req.tools ?? []).map((tool) => ({
    type: "function",
    function: {
      name: (tool as Anthropic.Tool).name,
      description: (tool as Anthropic.Tool).description,
      parameters: (tool as Anthropic.Tool).input_schema,
    },
  }));

  return {
    model: req.model,
    messages,
    ...(tools.length ? { tools } : {}),
    max_completion_tokens: req.max_tokens,
  };
}

/** OpenAI chat.completions response → the Anthropic Message shape the loop expects. */
export function fromOpenAIResponse(json: JsonRecord, model: string): Anthropic.Message {
  const choices = json.choices as JsonRecord[] | undefined;
  if (!choices || choices.length === 0) {
    // Some OpenAI-compatible proxies answer 200 with an `{"error":{...}}` body
    // instead of a proper HTTP error — surface the body so it isn't mistaken
    // for a well-formed empty reply.
    throw new Error(`provider response has no choices: ${JSON.stringify(json).slice(0, 300)}`);
  }
  const choice = choices[0];
  const message = (choice.message as JsonRecord | undefined) ?? {};
  const content: Anthropic.ContentBlock[] = [];

  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content, citations: null } as Anthropic.TextBlock);
  }
  for (const call of (message.tool_calls as JsonRecord[] | undefined) ?? []) {
    const fn = (call.function as JsonRecord | undefined) ?? {};
    let input: unknown = {};
    try {
      input = JSON.parse((fn.arguments as string) || "{}");
    } catch {
      input = {}; // The tool layer will answer with a conversational error.
    }
    content.push({
      type: "tool_use",
      id: String(call.id ?? ""),
      name: String(fn.name ?? ""),
      input,
    } as Anthropic.ToolUseBlock);
  }

  // Derived from what the model actually did, not the finish_reason label:
  // some OpenAI-compatible providers (Gemini's compat layer, llama.cpp, vLLM,
  // certain OpenRouter upstreams) report finish_reason "stop" even when the
  // message carries tool_calls, which would otherwise end the loop after one
  // turn reporting success with nothing written.
  const finish = choice.finish_reason;
  const stopReason: Anthropic.Message["stop_reason"] = content.some((b) => b.type === "tool_use")
    ? "tool_use"
    : finish === "length"
      ? "max_tokens"
      : "end_turn";

  const usage = (json.usage as JsonRecord | undefined) ?? {};
  const details = (usage.prompt_tokens_details as JsonRecord | undefined) ?? {};

  return {
    id: String(json.id ?? "openai-compat"),
    type: "message",
    role: "assistant",
    model: String(json.model ?? model),
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens ?? 0),
      output_tokens: Number(usage.completion_tokens ?? 0),
      cache_read_input_tokens: Number(details.cached_tokens ?? 0),
      cache_creation_input_tokens: 0,
    } as Anthropic.Usage,
  } as Anthropic.Message;
}

export interface OpenAICompatOptions {
  baseUrl: string;
  apiKey: string;
  /** Injected so tests can script the endpoint without a network. */
  fetchImpl?: typeof fetch;
  /** Injected so tests don't wait out the real backoff delays. */
  sleepImpl?: (ms: number) => Promise<void>;
}

/** Matches the Anthropic SDK's default: a run shouldn't hang forever on a stuck connection. */
const REQUEST_TIMEOUT_MS = 600_000;

/** Two retries, ~1s then ~4s — enough to ride out a rate limit or a blip without stalling the loop for long. */
const RETRY_DELAYS_MS = [1000, 4000];

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * A CreateMessage backed by any OpenAI-compatible /chat/completions endpoint.
 * Newer OpenAI models require max_completion_tokens; older servers and some
 * compatibles only know max_tokens — on a 400 naming the parameter, fall back
 * once and remember it, so every later request in this run sends max_tokens
 * directly instead of paying for the failed attempt again.
 */
export function createOpenAICompatMessage(options: OpenAICompatOptions): CreateMessage {
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const endpoint = options.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const headers = { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` };
  let useMaxTokens = false;

  /** Retries 429/5xx with backoff; any other status (ok or not) is returned as-is for the caller to interpret. */
  async function fetchWithRetry(body: JsonRecord): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok || !isRetryableStatus(response.status) || attempt >= RETRY_DELAYS_MS.length) {
        return response;
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  return async (req) => {
    const body = toOpenAIRequest(req);
    if (useMaxTokens) {
      body.max_tokens = body.max_completion_tokens;
      delete body.max_completion_tokens;
    }
    let response = await fetchWithRetry(body);

    if (!response.ok) {
      const text = await response.text();
      if (response.status === 400 && text.includes("max_completion_tokens")) {
        useMaxTokens = true;
        const retry: JsonRecord = { ...body, max_tokens: body.max_completion_tokens };
        delete retry.max_completion_tokens;
        response = await fetchWithRetry(retry);
        if (!response.ok) {
          throw new Error(`provider returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
        }
      } else {
        throw new Error(`provider returned ${response.status}: ${text.slice(0, 300)}`);
      }
    }

    return fromOpenAIResponse((await response.json()) as JsonRecord, req.model);
  };
}
