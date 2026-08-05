# Multi-Provider Init Investigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `wikipilot init` asks which AI provider to use (Claude / OpenAI / Gemini / custom OpenAI-compatible), resolves the matching API key (ephemeral by default), and runs the deep investigation through that provider.

**Architecture:** The investigation loop already speaks Anthropic's message format through one injected `CreateMessage` function. A new fetch-based adapter satisfies that signature against any OpenAI-compatible `/chat/completions` endpoint; a small provider registry drives the wizard, key resolution, and defaults. No new dependencies.

**Tech Stack:** TypeScript ESM, Node ≥18 (global fetch), `node --test` via tsx (`npm test`).

**Spec:** `docs/superpowers/specs/2026-08-05-multi-provider-init-design.md`

## Global Constraints

- Provider registry values (exact): `anthropic` → env `ANTHROPIC_API_KEY`, default model `claude-sonnet-5`, no base URL (SDK); `openai` → env `OPENAI_API_KEY`, default model `gpt-5.5`, base `https://api.openai.com/v1`; `gemini` → env `GEMINI_API_KEY`, default model `gemini-3.5-flash`, base `https://generativelanguage.googleapis.com/v1beta/openai`; `custom` → env `WIKI_INIT_API_KEY`, no defaults (user supplies base URL + model).
- Claude stays the default provider everywhere; existing Anthropic behaviour must be byte-for-byte unchanged when provider is `anthropic` or unspecified.
- Pasted keys stay ephemeral unless the user answers yes to the existing "Save it to .env for next time? [y/N]" — saving writes the *provider's* env var via the existing generic `saveEnvKey(repoRoot, key, value)`.
- Non-interactive runs never prompt and never spend by accident: they need `--ai` plus the chosen provider's key already in the environment.
- No new npm dependencies. No emoji anywhere.
- Run tests with `npm test`; commit after every task.

---

### Task 1: Provider registry and OpenAI-compatible adapter

**Files:**
- Create: `src/lib/providers.ts`
- Modify: `src/lib/index.ts` (re-export the new module's public names alongside the existing exports)
- Test: `test/providers.test.ts` (new)

**Interfaces:**
- Consumes: `import type { CreateMessage } from "./investigate.js"` (type-only, so no runtime cycle) and `import type Anthropic from "@anthropic-ai/sdk"`.
- Produces (used by Tasks 2–4): `ProviderId`, `ProviderInfo`, `PROVIDERS`, `PROVIDER_IDS`, `isProviderId(v: string): v is ProviderId`, `createOpenAICompatMessage(opts: { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch }): CreateMessage`, plus exported-for-test helpers `toOpenAIRequest`, `fromOpenAIResponse`.

- [ ] **Step 1: Write the failing tests** — create `test/providers.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test 2>&1 | grep -c "providers"`
Expected: FAIL — module `../src/lib/providers.js` does not exist.

- [ ] **Step 3: Implement** — create `src/lib/providers.ts`:

```ts
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
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  anthropic: {
    id: "anthropic",
    label: "Claude — the default, and what the investigation prompt is tuned on",
    envVar: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-5",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    envVar: "OPENAI_API_KEY",
    defaultModel: "gpt-5.5",
    baseUrl: "https://api.openai.com/v1",
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    envVar: "GEMINI_API_KEY",
    defaultModel: "gemini-3.5-flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
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
  const choice = (json.choices as JsonRecord[] | undefined)?.[0] ?? {};
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

  const finish = choice.finish_reason;
  const stopReason: Anthropic.Message["stop_reason"] =
    finish === "tool_calls" ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn";

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
}

/**
 * A CreateMessage backed by any OpenAI-compatible /chat/completions endpoint.
 * Newer OpenAI models require max_completion_tokens; older servers and some
 * compatibles only know max_tokens — on a 400 naming the parameter, retry once.
 */
export function createOpenAICompatMessage(options: OpenAICompatOptions): CreateMessage {
  const doFetch = options.fetchImpl ?? fetch;
  const endpoint = options.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const headers = { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` };

  return async (req) => {
    const body = toOpenAIRequest(req);
    let response = await doFetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });

    if (!response.ok) {
      const text = await response.text();
      if (response.status === 400 && text.includes("max_completion_tokens")) {
        const retry: JsonRecord = { ...body, max_tokens: body.max_completion_tokens };
        delete retry.max_completion_tokens;
        response = await doFetch(endpoint, { method: "POST", headers, body: JSON.stringify(retry) });
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
```

Then add to `src/lib/index.ts`'s exports (match its existing export style):

```ts
export {
  PROVIDERS,
  PROVIDER_IDS,
  isProviderId,
  createOpenAICompatMessage,
  type ProviderId,
  type ProviderInfo,
} from "./providers.js";
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS (new providers tests plus the existing 91).

- [ ] **Step 5: Commit**

```bash
git add src/lib/providers.ts src/lib/index.ts test/providers.test.ts
git commit -m "Add a provider registry and an OpenAI-compatible adapter for the investigation"
```

---

### Task 2: Wizard — provider question and per-provider key resolution

**Files:**
- Modify: `src/lib/wizard.ts` (`AiPlan`, `AiOptions`, `resolveAiPlan`)
- Test: `test/wizard.test.ts`

**Interfaces:**
- Consumes: `PROVIDERS`, `PROVIDER_IDS`, `isProviderId`, `ProviderId` from `./providers.js` (Task 1).
- Produces (Task 4 relies on these exact shapes):
  - `interface AiPlan { enabled: boolean; provider: ProviderId; model?: string; baseUrl?: string; apiKey?: string; saveKey: boolean; }`
  - `interface AiOptions { ai?: boolean; provider?: string; baseUrl?: string; model?: string; }`
  - `resolveAiPlan(options: AiOptions, io: PromptIO, env: Record<string, string | undefined>): Promise<AiPlan>` — note the third parameter is now the whole env lookup, not a single key.

**Behaviour (exact):**
1. `--no-ai` → `{ enabled: false, provider: "anthropic", saveKey: false }` (provider value irrelevant but stable).
2. An invalid `--provider` throws: `unknown provider "<x>" — expected one of: anthropic, openai, gemini, custom`.
3. Non-interactive: enabled only when `options.ai === true` AND `env[provider.envVar]` is set AND (provider !== "custom" OR both `options.baseUrl` and `options.model` were given). Never prompts.
4. Interactive without `--ai`: the existing "Run the AI deep investigation now? [Y/n]" question, unchanged wording.
5. Provider selection (interactive, after a yes, when no `--provider`): print a numbered list of the four providers in registry order using each `label`, prompt `Choose 1-4 [1]: `, Enter → anthropic, accept a number or a provider id typed by name, re-ask up to `MAX_PROMPT_ATTEMPTS` then fall back to anthropic (mirror `resolvePreset`'s loop shape).
6. Custom provider (interactive): prompt `  OpenAI-compatible base URL: ` and `  Model name: `; empty answer on either after trimming → print `  Both a base URL and a model are required for a custom provider — keeping the mechanical draft.` and return disabled.
7. Key: if `env[provider.envVar]` set → use it, `saveKey: false`. Otherwise print `  This needs an API key (it will be read as ${provider.envVar}).` then prompt `  Paste your API key: `; empty → the existing "No key — keeping the mechanical draft." path. Then the existing `  Save it to .env for next time? [y/N] ` — unchanged default No.
8. `plan.model` is set only for custom (the typed model); other providers leave it undefined so `investigate` falls through to the registry default / `WIKI_INIT_MODEL` / `--model`.

- [ ] **Step 1: Write the failing tests** — extend `test/wizard.test.ts` (follow its existing fake-`PromptIO` pattern; read the file first). Cover at minimum:

```ts
test("resolveAiPlan asks for a provider after a yes and defaults to anthropic on Enter", async () => {
  const io = fakeIO(["", "", ""]); // yes to AI (Enter), provider Enter → 1, no key typed
  const plan = await resolveAiPlan({}, io, { ANTHROPIC_API_KEY: "sk-ant-x" });
  assert.equal(plan.enabled, true);
  assert.equal(plan.provider, "anthropic");
  assert.equal(plan.apiKey, "sk-ant-x");
});

test("choosing OpenAI reads OPENAI_API_KEY, not ANTHROPIC_API_KEY", async () => {
  const io = fakeIO(["", "2"]);
  const plan = await resolveAiPlan({}, io, { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" });
  assert.equal(plan.provider, "openai");
  assert.equal(plan.apiKey, "o");
});

test("--provider skips the provider question", async () => {
  const io = fakeIO([""]); // only the run-AI question
  const plan = await resolveAiPlan({ provider: "gemini" }, io, { GEMINI_API_KEY: "g" });
  assert.equal(plan.provider, "gemini");
  assert.equal(plan.apiKey, "g");
});

test("unknown --provider throws naming the valid ones", async () => {
  await assert.rejects(() => resolveAiPlan({ provider: "mistral" }, fakeIO([]), {}), /anthropic, openai, gemini, custom/);
});

test("custom provider collects base URL and model interactively", async () => {
  const io = fakeIO(["", "4", "http://localhost:11434/v1", "qwen3:32b", "k-local", ""]);
  const plan = await resolveAiPlan({}, io, {});
  assert.equal(plan.provider, "custom");
  assert.equal(plan.baseUrl, "http://localhost:11434/v1");
  assert.equal(plan.model, "qwen3:32b");
  assert.equal(plan.apiKey, "k-local");
  assert.equal(plan.saveKey, false);
});

test("non-interactive --ai with the right env var enables without prompting", async () => {
  const io = nonInteractiveIO();
  const plan = await resolveAiPlan({ ai: true, provider: "openai" }, io, { OPENAI_API_KEY: "o" });
  assert.equal(plan.enabled, true);
  assert.equal(plan.provider, "openai");
});

test("non-interactive custom without base-url and model stays disabled", async () => {
  const plan = await resolveAiPlan({ ai: true, provider: "custom" }, nonInteractiveIO(), { WIKI_INIT_API_KEY: "k" });
  assert.equal(plan.enabled, false);
});
```

Also update every existing `resolveAiPlan` call in the test file from the old `envKey` third argument to an env object (`{ ANTHROPIC_API_KEY: "..." }` or `{}`), preserving each test's intent.

- [ ] **Step 2: Run to verify failure** — `npm test` → the new tests fail on the old signature/flow.

- [ ] **Step 3: Implement** per the Behaviour list above, mirroring `resolvePreset`'s prompt-loop idiom.

- [ ] **Step 4: Run the full suite** — `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/wizard.ts test/wizard.test.ts
git commit -m "Ask which AI provider to use and resolve its key in the init wizard"
```

---

### Task 3: investigate.ts — route non-Anthropic providers through the adapter

**Files:**
- Modify: `src/lib/investigate.ts` (options + `createMessage` construction + model default)
- Test: `test/investigate.test.ts`

**Interfaces:**
- Consumes: `PROVIDERS`, `createOpenAICompatMessage`, `ProviderId` from `./providers.js`; `AiPlan` fields from Task 2.
- Produces: `InvestigateOptions` gains `provider?: ProviderId` and `baseUrl?: string`. All existing fields and behaviour unchanged when `provider` is absent or `"anthropic"`.

**Behaviour (exact):**
- Model resolution becomes: `options.model ?? process.env.WIKI_INIT_MODEL ?? PROVIDERS[options.provider ?? "anthropic"].defaultModel ?? DEFAULT_INIT_MODEL`.
- `createMessage` construction: injected `options.createMessage` always wins (tests rely on this). Otherwise, when `provider` is absent or `anthropic`, keep the existing Anthropic SDK path verbatim. Otherwise resolve `baseUrl = options.baseUrl ?? PROVIDERS[provider].baseUrl`; if missing → throw `Error("custom provider needs a base URL (--base-url)")`; require `options.apiKey` → throw `Error("no API key for provider <id>")` if absent; build `createOpenAICompatMessage({ baseUrl, apiKey })`.
- The progress line `deep investigation with ${model}` stays; when provider is non-anthropic append ` via ${provider}` so runs are attributable.

- [ ] **Step 1: Write the failing test** — add to `test/investigate.test.ts` an adapter-backed end-to-end run: build a real `createOpenAICompatMessage` with a scripted `fetchImpl` that returns, in order, (1) a chat.completions response whose `tool_calls` invokes `write_page` with a valid page for section `start-here`, then (2) a response invoking `finish`; pass it via `createMessage` into `investigate` and assert `pagesWritten === 1`, `stopped === "finished"`, and the page file exists. Also assert `usage.inputTokens` reflects the scripted `prompt_tokens`. (This proves the adapter and the loop compose without a network.)

- [ ] **Step 2: Run to verify failure** — fails until Task 1's adapter exists in the import graph and any wiring gaps are closed; if it passes immediately after Task 1, it still pins the composition — keep it.

- [ ] **Step 3: Implement** the wiring per Behaviour above.

- [ ] **Step 4: Run the full suite** — `npm test` → PASS, including every pre-existing scripted-model test (unchanged Anthropic path).

- [ ] **Step 5: Commit**

```bash
git add src/lib/investigate.ts test/investigate.test.ts
git commit -m "Route non-Anthropic providers through the OpenAI-compatible adapter"
```

---

### Task 4: CLI flags, key saving, .env.example, README

**Files:**
- Modify: `src/bin/wikipilot.ts` (init flags + wiring), `.env.example`, `README.md`
- Test: none new (the wizard/investigate tests cover the logic; the bin is thin wiring)

**Interfaces:**
- Consumes: `AiPlan`/`AiOptions` (Task 2), `PROVIDERS`/`isProviderId` (Task 1), `InvestigateOptions` (Task 3), existing `saveEnvKey`.

**Changes (exact):**
1. New init options, right after `--model`:
   - `.option("--provider <name>", "AI provider for the investigation: anthropic | openai | gemini | custom (default anthropic)")`
   - `.option("--base-url <url>", "OpenAI-compatible endpoint for --provider custom")`
2. `--ai` help text becomes `"run the AI deep-investigation pass (needs an API key — Anthropic by default)"`.
3. In the action: `resolveAiPlan(opts as AiOptions, io, process.env)` (drop the pre-resolved `ANTHROPIC_API_KEY` argument; keep `loadDotEnv(targetDir)` before it).
4. Key saving: `saveEnvKey(targetDir, PROVIDERS[plan.provider].envVar, plan.apiKey)`.
5. `investigate({ ..., model: opts.model ?? plan.model, provider: plan.provider, baseUrl: opts.baseUrl ?? plan.baseUrl, apiKey: plan.apiKey, ... })`.
6. The no-key message generalizes: `` `wikipilot: --ai requested but no ${PROVIDERS[plan.provider].envVar} found — wrote the mechanical draft only.` ``
7. `.env.example`: keep the existing `ANTHROPIC_API_KEY` line; append commented `# OPENAI_API_KEY=` , `# GEMINI_API_KEY=`, `# WIKI_INIT_API_KEY=` lines with a one-line comment that each is only read when that provider is chosen at init.
8. README: in the AI-pass section, document the provider question, the four providers with their env vars and default models (table), `--provider`/`--base-url`, and one sentence stating Claude is the default and the path the prompt is tuned against. Follow the `human-content` skill (`.claude/skills/human-content/SKILL.md`) — it binds README copy.

- [ ] **Step 1: Implement** the eight changes.
- [ ] **Step 2: Verify** — `npm test` (suite untouched must pass) and `npm run build` (tsc clean). Then run `node ./dist/bin/wikipilot.js init --help` and confirm the new flags print.
- [ ] **Step 3: Commit**

```bash
git add src/bin/wikipilot.ts .env.example README.md
git commit -m "Wire provider choice through the init CLI and document it"
```

---

### Task 5: End-to-end verification

**Files:** none; smoke artifacts go to the scratchpad.

- [ ] **Step 1:** `npm test && npm run build` → both PASS.
- [ ] **Step 2:** Non-interactive provider gating, from the repo root (`$SCRATCHPAD` = session scratchpad):

```bash
env -u OPENAI_API_KEY node ./dist/bin/wikipilot.js init . --ai --provider openai --no-skill --yes -o "$SCRATCHPAD/mp-smoke" 2>&1 | grep "OPENAI_API_KEY"
```
Expected: the `--ai requested but no OPENAI_API_KEY found` line prints and the mechanical draft still lands (`ls "$SCRATCHPAD/mp-smoke/content/en"` shows sections).

- [ ] **Step 3:** Invalid provider fails loudly:

```bash
node ./dist/bin/wikipilot.js init . --ai --provider mistral --no-skill --yes -o "$SCRATCHPAD/mp-smoke2" 2>&1 | grep -i "unknown provider"
```
Expected: the error names the four valid providers.

- [ ] **Step 4:** Commit any fixes the smoke surfaced; otherwise nothing to commit.
