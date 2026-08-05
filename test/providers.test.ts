import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDERS,
  isProviderId,
  toOpenAIRequest,
  fromOpenAIResponse,
  createOpenAICompatMessage,
} from "../src/lib/providers.js";

test("registry carries the exact env vars and defaults per provider", () => {
  assert.equal(PROVIDERS.anthropic.envVar, "ANTHROPIC_API_KEY");
  assert.equal(PROVIDERS.anthropic.defaultModel, "claude-sonnet-5");
  assert.equal(PROVIDERS.openai.defaultModel, "gpt-5.5");
  assert.equal(PROVIDERS.openai.baseUrl, "https://api.openai.com/v1");
  assert.equal(PROVIDERS.gemini.envVar, "GEMINI_API_KEY");
  assert.equal(PROVIDERS.gemini.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(PROVIDERS.custom.envVar, "WIKI_INIT_API_KEY");
  assert.ok(isProviderId("openai"));
  assert.ok(!isProviderId("mistral"));
});

test("registry carries a keyUrl for the providers with a single place to get a key", () => {
  assert.equal(PROVIDERS.anthropic.keyUrl, "https://console.anthropic.com/settings/keys");
  assert.equal(PROVIDERS.openai.keyUrl, "https://platform.openai.com/api-keys");
  assert.equal(PROVIDERS.gemini.keyUrl, "https://aistudio.google.com/apikey");
  assert.equal(PROVIDERS.custom.keyUrl, undefined);
});

test("toOpenAIRequest translates system, tool_use, tool_result, and tools", () => {
  const req = {
    model: "gpt-5.5",
    max_tokens: 16000,
    system: [{ type: "text", text: "You are an agent.", cache_control: { type: "ephemeral" } }],
    tools: [{ name: "grep", description: "search", input_schema: { type: "object", properties: {} } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "Begin." }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Searching." },
          { type: "tool_use", id: "call_1", name: "grep", input: { pattern: "x" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "no matches", is_error: true }],
      },
    ],
  } as never;
  const out = toOpenAIRequest(req) as {
    messages: Array<Record<string, unknown>>;
    tools: Array<{ function: { name: string } }>;
    max_completion_tokens: number;
  };
  assert.equal(out.messages[0].role, "system");
  assert.equal(out.messages[0].content, "You are an agent.");
  assert.equal(out.messages[1].role, "user");
  const assistant = out.messages[2] as { tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> };
  assert.equal(assistant.tool_calls[0].id, "call_1");
  assert.equal(JSON.parse(assistant.tool_calls[0].function.arguments).pattern, "x");
  assert.deepEqual(out.messages[3], { role: "tool", tool_call_id: "call_1", content: "no matches" });
  assert.equal(out.tools[0].function.name, "grep");
  assert.equal(out.max_completion_tokens, 16000);
});

test("fromOpenAIResponse maps tool_calls, finish_reason, and usage", () => {
  const message = fromOpenAIResponse(
    {
      id: "chatcmpl-1",
      model: "gpt-5.5",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: "Looking.",
            tool_calls: [{ id: "call_9", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } },
    },
    "gpt-5.5",
  );
  assert.equal(message.stop_reason, "tool_use");
  const toolUse = message.content.find((b) => b.type === "tool_use") as { name: string; input: { path: string } };
  assert.equal(toolUse.name, "read_file");
  assert.equal(toolUse.input.path, "a.ts");
  assert.equal(message.usage.input_tokens, 100);
  assert.equal(message.usage.cache_read_input_tokens, 60);
});

test("fromOpenAIResponse survives malformed tool arguments with an empty input", () => {
  const message = fromOpenAIResponse(
    { choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c", type: "function", function: { name: "grep", arguments: "{not json" } }] } }] },
    "gpt-5.5",
  );
  const toolUse = message.content[0] as { input: object };
  assert.deepEqual(toolUse.input, {});
});

test("fromOpenAIResponse derives stop_reason from content, not the finish_reason label", () => {
  // Some OpenAI-compatible providers report finish_reason "stop" even though
  // the message carries tool_calls — the loop must still see "tool_use", or
  // it ends the run after one turn believing it succeeded.
  const message = fromOpenAIResponse(
    {
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
          },
        },
      ],
    },
    "gpt-5.5",
  );
  assert.equal(message.stop_reason, "tool_use");
});

test("fromOpenAIResponse throws with a body excerpt when choices is missing or empty", () => {
  assert.throws(
    () => fromOpenAIResponse({ error: { message: "insufficient_quota: you exceeded your quota" } }, "gpt-5.5"),
    /insufficient_quota/,
  );
  assert.throws(() => fromOpenAIResponse({ choices: [] }, "gpt-5.5"), /choices/);
});

test("createOpenAICompatMessage retries with max_tokens when max_completion_tokens is rejected", async () => {
  const bodies: string[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    bodies.push(init.body);
    if (bodies.length === 1) {
      return new Response('{"error":{"message":"Unsupported parameter: max_completion_tokens"}}', { status: 400 });
    }
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  }) as unknown as typeof fetch;
  const create = createOpenAICompatMessage({ baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl });
  const message = await create({ model: "m", max_tokens: 99, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as never);
  assert.equal(bodies.length, 2);
  assert.ok(JSON.parse(bodies[0]).max_completion_tokens === 99);
  assert.ok(JSON.parse(bodies[1]).max_tokens === 99);
  assert.equal((message.content[0] as { text: string }).text, "ok");
});

test("createOpenAICompatMessage surfaces provider errors with status and body excerpt", async () => {
  const fetchImpl = (async () => new Response("upstream exploded", { status: 500 })) as unknown as typeof fetch;
  const create = createOpenAICompatMessage({ baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl, sleepImpl: async () => {} });
  await assert.rejects(
    () => create({ model: "m", max_tokens: 9, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as never),
    /500.*upstream exploded/s,
  );
});

const REQ = { model: "m", max_tokens: 9, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as never;

test("createOpenAICompatMessage retries a 429 with backoff and succeeds", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) return new Response("rate limited", { status: 429 });
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const create = createOpenAICompatMessage({
    baseUrl: "https://example.test/v1",
    apiKey: "k",
    fetchImpl,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
  });
  const message = await create(REQ);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1000]);
  assert.equal((message.content[0] as { text: string }).text, "ok");
});

test("createOpenAICompatMessage gives up and throws after three consecutive 5xx responses", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response("still down", { status: 503 });
  }) as unknown as typeof fetch;
  const create = createOpenAICompatMessage({ baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl, sleepImpl: async () => {} });
  await assert.rejects(() => create(REQ), /503.*still down/s);
  assert.equal(calls, 3, "two retries plus the original attempt");
});

test("createOpenAICompatMessage does not retry a non-retryable status like 401", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response("bad key", { status: 401 });
  }) as unknown as typeof fetch;
  const create = createOpenAICompatMessage({ baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl, sleepImpl: async () => {} });
  await assert.rejects(() => create(REQ), /401.*bad key/s);
  assert.equal(calls, 1, "a non-retryable error must throw immediately");
});

test("createOpenAICompatMessage requests a 10-minute abort signal", async () => {
  let signal: AbortSignal | undefined;
  const fetchImpl = (async (_url: string, init: { signal?: AbortSignal }) => {
    signal = init.signal;
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const create = createOpenAICompatMessage({ baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl, sleepImpl: async () => {} });
  await create(REQ);
  assert.ok(signal instanceof AbortSignal, "the request must carry an AbortSignal");
});

test("the max_completion_tokens fallback is sticky across later requests", async () => {
  const bodies: string[] = [];
  let calls = 0;
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    calls++;
    bodies.push(init.body);
    // Only the very first request (before the fallback is learned) is rejected.
    if (calls === 1) {
      return new Response('{"error":{"message":"Unsupported parameter: max_completion_tokens"}}', { status: 400 });
    }
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const create = createOpenAICompatMessage({ baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl, sleepImpl: async () => {} });

  await create(REQ); // learns the fallback: request 1 (max_completion_tokens, 400), request 2 (max_tokens, 200)
  await create(REQ); // should send max_tokens on the very first try this time

  assert.equal(bodies.length, 3);
  assert.equal(JSON.parse(bodies[0]).max_completion_tokens, 9);
  assert.equal(JSON.parse(bodies[1]).max_tokens, 9);
  assert.equal(JSON.parse(bodies[2]).max_tokens, 9, "the second call's first request must already use max_tokens");
  assert.equal("max_completion_tokens" in JSON.parse(bodies[2]), false);
});

test("createOpenAICompatMessage posts to <baseUrl>/chat/completions with the bearer header, trailing slashes stripped", async () => {
  let capturedUrl: string | undefined;
  let capturedInit: { headers?: Record<string, string> } | undefined;
  const fetchImpl = (async (url: string, init: { headers?: Record<string, string> }) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const create = createOpenAICompatMessage({ baseUrl: "https://example.test/v1///", apiKey: "sk-secret", fetchImpl, sleepImpl: async () => {} });
  await create(REQ);
  assert.equal(capturedUrl, "https://example.test/v1/chat/completions");
  assert.equal(capturedInit?.headers?.authorization, "Bearer sk-secret");
});
