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
  const create = createOpenAICompatMessage({ baseUrl: "https://example.test/v1", apiKey: "k", fetchImpl });
  await assert.rejects(
    () => create({ model: "m", max_tokens: 9, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as never),
    /500.*upstream exploded/s,
  );
});
