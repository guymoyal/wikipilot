import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { investigate, buildSystemPrompt, DEFAULT_INIT_MODEL, type CreateMessage } from "../src/lib/investigate.js";
import { createOpenAICompatMessage } from "../src/lib/providers.js";
import { configForPreset } from "../src/lib/config.js";
import { parseFrontmatter } from "../src/lib/frontmatter.js";

interface Fixture {
  outerDir: string;
  targetDir: string;
  wikiDir: string;
}

/** A repo inside an outer dir, so escape attempts have somewhere real to land. */
function makeFixture(): Fixture {
  const outerDir = mkdtempSync(join(tmpdir(), "wikipilot-inv-"));
  const targetDir = join(outerDir, "repo");
  const wikiDir = join(targetDir, "wiki");
  mkdirSync(join(targetDir, "src"), { recursive: true });
  writeFileSync(join(targetDir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }), "utf8");
  writeFileSync(join(targetDir, "src", "index.ts"), 'export const hello = "world";\n', "utf8");
  writeFileSync(join(outerDir, "canary.txt"), "outside the repo\n", "utf8");
  mkdirSync(wikiDir, { recursive: true });
  return { outerDir, targetDir, wikiDir };
}

let idCounter = 0;

function toolUse(name: string, input: unknown): Anthropic.ToolUseBlock {
  return { type: "tool_use", id: `toolu_${++idCounter}`, name, input } as Anthropic.ToolUseBlock;
}

function message(content: Anthropic.ContentBlock[], stopReason = "tool_use"): Anthropic.Message {
  return {
    id: `msg_${++idCounter}`,
    type: "message",
    role: "assistant",
    content,
    stop_reason: stopReason,
  } as unknown as Anthropic.Message;
}

/** Scripts the model: each call pops the next response; capture inspects requests. */
function scripted(responses: Anthropic.Message[]): { createMessage: CreateMessage; requests: Anthropic.MessageCreateParamsNonStreaming[] } {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const queue = [...responses];
  return {
    requests,
    createMessage: async (req) => {
      // The loop mutates `messages` in place — snapshot the request as it was sent.
      requests.push(structuredClone(req));
      const next = queue.shift();
      if (!next) throw new Error("scripted createMessage ran out of responses");
      return next;
    },
  };
}

const PAGE_INPUT = {
  section: "start-here",
  slug: "overview",
  title: "Overview",
  description: "What fixture is and how it fits together.",
  sources: ["package.json", "src/index.ts"],
  body: "# Overview\n\nFixture exports a single constant from `src/index.ts`.",
};

test("happy path: write_page then finish produces a real page and clears stale drafts", async () => {
  const fx = makeFixture();
  try {
    // A mechanical draft the investigation never rewrites — must be swept away.
    mkdirSync(join(fx.wikiDir, "content", "en", "technologies"), { recursive: true });
    writeFileSync(join(fx.wikiDir, "content", "en", "technologies", "lodash.md"), "---\ntitle: lodash\nsection: technologies\nsources:\n  - package.json\nlast_synced: abc\n---\n\nstub\n", "utf8");

    const { createMessage } = scripted([
      message([toolUse("write_page", PAGE_INPUT)]),
      message([toolUse("finish", { summary: "wrote one page" })]),
    ]);
    const result = await investigate({
      targetDir: fx.targetDir,
      wikiDir: fx.wikiDir,
      config: { ...configForPreset("all"), version: "1.0.0" },
      createMessage,
    });

    assert.equal(result.pagesWritten, 1);
    assert.equal(result.stopped, "finished");
    assert.equal(result.summary, "wrote one page");
    assert.equal(result.pagesRemoved, 1);
    assert.ok(!existsSync(join(fx.wikiDir, "content", "en", "technologies", "lodash.md")), "unrewritten drafts are superseded");

    const path = join(fx.wikiDir, "content", "en", "start-here", "overview.md");
    assert.ok(existsSync(path));
    const { frontmatter, body } = parseFrontmatter(readFileSync(path, "utf8"));
    assert.equal(frontmatter.title, "Overview");
    assert.deepEqual(frontmatter.sources, ["package.json", "src/index.ts"]);
    assert.equal(frontmatter.version, "1.0.0");
    assert.equal(frontmatter.locale, "en");
    assert.ok(frontmatter.last_synced.length > 0);
    assert.match(body, /single constant/);
  } finally {
    rmSync(fx.outerDir, { recursive: true, force: true });
  }
});

test("write_page accepts the onboarding section under the all preset", async () => {
  const fx = makeFixture();
  try {
    const { createMessage, requests } = scripted([
      message([toolUse("write_page", { ...PAGE_INPUT, section: "onboarding", slug: "index" })]),
      message([toolUse("finish", { summary: "done" })]),
    ]);
    const result = await investigate({ targetDir: fx.targetDir, wikiDir: fx.wikiDir, config: configForPreset("all"), createMessage });

    assert.equal(result.pagesWritten, 1);
    const [toolResult] = (requests[1].messages.at(-1)?.content ?? []) as Anthropic.ToolResultBlockParam[];
    assert.notEqual(toolResult.is_error, true, "onboarding is a configured section under the all preset");

    const path = join(fx.wikiDir, "content", "en", "onboarding", "index.md");
    assert.ok(existsSync(path), "expected the onboarding page to land at content/en/onboarding/index.md");
  } finally {
    rmSync(fx.outerDir, { recursive: true, force: true });
  }
});

test("read_file cannot escape the repo root", async () => {
  const fx = makeFixture();
  try {
    symlinkSync(join(fx.outerDir, "canary.txt"), join(fx.targetDir, "sneaky-link"));
    const { createMessage, requests } = scripted([
      message([
        toolUse("read_file", { path: "../canary.txt" }),
        toolUse("read_file", { path: join(fx.outerDir, "canary.txt") }),
        toolUse("read_file", { path: "sneaky-link" }),
      ]),
      message([toolUse("finish", { summary: "done" })]),
    ]);
    await investigate({ targetDir: fx.targetDir, wikiDir: fx.wikiDir, config: configForPreset("all"), createMessage });

    const toolResults = (requests[1].messages.at(-1)?.content ?? []) as Anthropic.ToolResultBlockParam[];
    assert.equal(toolResults.length, 3);
    for (const result of toolResults) {
      assert.equal(result.is_error, true, "every escape attempt must be an error result");
      assert.doesNotMatch(String(result.content), /outside the repo/, "canary contents must never leak");
    }
  } finally {
    rmSync(fx.outerDir, { recursive: true, force: true });
  }
});

test("write_page rejects unknown sections, naming the valid ones", async () => {
  const fx = makeFixture();
  try {
    const { createMessage, requests } = scripted([
      message([toolUse("write_page", { ...PAGE_INPUT, section: "made-up" })]),
      message([toolUse("finish", { summary: "done" })]),
    ]);
    const result = await investigate({ targetDir: fx.targetDir, wikiDir: fx.wikiDir, config: configForPreset("all"), createMessage });

    assert.equal(result.pagesWritten, 0);
    const [toolResult] = (requests[1].messages.at(-1)?.content ?? []) as Anthropic.ToolResultBlockParam[];
    assert.equal(toolResult.is_error, true);
    assert.match(String(toolResult.content), /start-here/);
    assert.ok(!existsSync(join(fx.wikiDir, "content", "en", "made-up")));
  } finally {
    rmSync(fx.outerDir, { recursive: true, force: true });
  }
});

test("write_page rejects emoji in titles and headings", async () => {
  const fx = makeFixture();
  try {
    const { createMessage, requests } = scripted([
      message([
        toolUse("write_page", { ...PAGE_INPUT, title: "🚀 Overview" }),
        toolUse("write_page", { ...PAGE_INPUT, slug: "second", body: "# Setup ⚙️\n\nText." }),
      ]),
      message([toolUse("finish", { summary: "done" })]),
    ]);
    const result = await investigate({ targetDir: fx.targetDir, wikiDir: fx.wikiDir, config: configForPreset("all"), createMessage });

    assert.equal(result.pagesWritten, 0);
    const toolResults = (requests[1].messages.at(-1)?.content ?? []) as Anthropic.ToolResultBlockParam[];
    for (const r of toolResults) {
      assert.equal(r.is_error, true);
      assert.match(String(r.content), /no emoji/i);
    }
  } finally {
    rmSync(fx.outerDir, { recursive: true, force: true });
  }
});

test("the turn budget stops a loop that never finishes, keeping the draft intact", async () => {
  const fx = makeFixture();
  try {
    mkdirSync(join(fx.wikiDir, "content", "en", "faq"), { recursive: true });
    writeFileSync(join(fx.wikiDir, "content", "en", "faq", "index.md"), "---\ntitle: FAQ\nsection: faq\nsources:\n  - README.md\nlast_synced: abc\n---\n\ndraft\n", "utf8");

    let calls = 0;
    const createMessage: CreateMessage = async () => {
      calls++;
      return message([toolUse("list_dir", {})]);
    };
    const result = await investigate({
      targetDir: fx.targetDir,
      wikiDir: fx.wikiDir,
      config: configForPreset("all"),
      createMessage,
      maxTurns: 3,
    });
    assert.equal(result.stopped, "max_turns");
    assert.equal(result.turns, 3);
    assert.equal(calls, 3);
    assert.equal(result.pagesRemoved, 0, "a partial run must not delete anything");
    assert.ok(existsSync(join(fx.wikiDir, "content", "en", "faq", "index.md")));
  } finally {
    rmSync(fx.outerDir, { recursive: true, force: true });
  }
});

test("the read budget cuts off further reads with an explanatory error", async () => {
  const fx = makeFixture();
  try {
    const { createMessage, requests } = scripted([
      message([toolUse("read_file", { path: "src/index.ts" })]),
      message([toolUse("read_file", { path: "package.json" })]),
      message([toolUse("finish", { summary: "done" })]),
    ]);
    await investigate({
      targetDir: fx.targetDir,
      wikiDir: fx.wikiDir,
      config: configForPreset("all"),
      createMessage,
      maxReadBytes: 10,
    });

    const first = (requests[1].messages.at(-1)?.content ?? []) as Anthropic.ToolResultBlockParam[];
    assert.notEqual(first[0].is_error, true, "the read that crosses the line still returns content");
    assert.match(String(first[0].content), /budget exhausted/);

    const second = (requests[2].messages.at(-1)?.content ?? []) as Anthropic.ToolResultBlockParam[];
    assert.equal(second[0].is_error, true, "reads after exhaustion are refused");
  } finally {
    rmSync(fx.outerDir, { recursive: true, force: true });
  }
});

test("requests carry the cached system prompt and no sampling params", async () => {
  const fx = makeFixture();
  try {
    const { createMessage, requests } = scripted([message([toolUse("finish", { summary: "done" })])]);
    await investigate({ targetDir: fx.targetDir, wikiDir: fx.wikiDir, config: configForPreset("all"), createMessage });

    const req = requests[0] as unknown as Record<string, unknown>;
    assert.equal(req.model, DEFAULT_INIT_MODEL);
    assert.equal(req.max_tokens, 16000);
    assert.ok(!("temperature" in req) && !("top_p" in req) && !("thinking" in req));
    const system = req.system as Array<{ text: string; cache_control?: { type: string } }>;
    assert.equal(system[0].cache_control?.type, "ephemeral");
    assert.match(system[0].text, /write_page/);
    assert.match(system[0].text, /NO EMOJI/);
  } finally {
    rmSync(fx.outerDir, { recursive: true, force: true });
  }
});

test("WIKI_INIT_MODEL overrides the default model", async () => {
  const fx = makeFixture();
  process.env.WIKI_INIT_MODEL = "claude-test-model";
  try {
    const { createMessage, requests } = scripted([message([toolUse("finish", { summary: "done" })])]);
    await investigate({ targetDir: fx.targetDir, wikiDir: fx.wikiDir, config: configForPreset("all"), createMessage });
    assert.equal(requests[0].model, "claude-test-model");
  } finally {
    delete process.env.WIKI_INIT_MODEL;
    rmSync(fx.outerDir, { recursive: true, force: true });
  }
});

test("WIKI_INIT_MODEL is not sent to a non-anthropic provider", async () => {
  const fx = makeFixture();
  process.env.WIKI_INIT_MODEL = "claude-test-model";
  try {
    const { createMessage, requests } = scripted([message([toolUse("finish", { summary: "done" })])]);
    await investigate({ targetDir: fx.targetDir, wikiDir: fx.wikiDir, config: configForPreset("all"), provider: "openai", createMessage });
    assert.notEqual(requests[0].model, "claude-test-model", "a Claude model id must never be sent to another provider's API");
    assert.equal(requests[0].model, "gpt-5.5", "falls through to the openai registry default instead");
  } finally {
    delete process.env.WIKI_INIT_MODEL;
    rmSync(fx.outerDir, { recursive: true, force: true });
  }
});

test("an explicit --model still wins over the registry default for a non-anthropic provider", async () => {
  const fx = makeFixture();
  try {
    const { createMessage, requests } = scripted([message([toolUse("finish", { summary: "done" })])]);
    await investigate({
      targetDir: fx.targetDir,
      wikiDir: fx.wikiDir,
      config: configForPreset("all"),
      provider: "openai",
      model: "gpt-5.5-mini",
      createMessage,
    });
    assert.equal(requests[0].model, "gpt-5.5-mini");
  } finally {
    rmSync(fx.outerDir, { recursive: true, force: true });
  }
});

test("a custom provider without a base URL fails with an actionable error", async () => {
  const fx = makeFixture();
  try {
    await assert.rejects(
      () =>
        investigate({
          targetDir: fx.targetDir,
          wikiDir: fx.wikiDir,
          config: configForPreset("all"),
          provider: "custom",
          apiKey: "k",
        }),
      /custom provider needs a base URL/,
    );
  } finally {
    rmSync(fx.outerDir, { recursive: true, force: true });
  }
});

test("a non-anthropic provider without an API key fails with an actionable error", async () => {
  const fx = makeFixture();
  try {
    await assert.rejects(
      () =>
        investigate({
          targetDir: fx.targetDir,
          wikiDir: fx.wikiDir,
          config: configForPreset("all"),
          provider: "openai",
        }),
      /no API key for provider/,
    );
  } finally {
    rmSync(fx.outerDir, { recursive: true, force: true });
  }
});

test("progress goes only through the injected reporter", async () => {
  const fx = makeFixture();
  try {
    const lines: string[] = [];
    const { createMessage } = scripted([
      message([toolUse("write_page", PAGE_INPUT)]),
      message([toolUse("finish", { summary: "done" })]),
    ]);
    await investigate({
      targetDir: fx.targetDir,
      wikiDir: fx.wikiDir,
      config: configForPreset("all"),
      createMessage,
      report: (line) => lines.push(line),
    });
    assert.ok(lines.some((l) => l.includes("wrote start-here/overview")));
  } finally {
    rmSync(fx.outerDir, { recursive: true, force: true });
  }
});

test("re-reads and lockfiles are refused cheaply instead of resending content", async () => {
  const fx = makeFixture();
  try {
    writeFileSync(join(fx.targetDir, "package-lock.json"), "{}", "utf8");
    const { createMessage, requests } = scripted([
      message([toolUse("read_file", { path: "src/index.ts" })]),
      message([
        toolUse("read_file", { path: "src/index.ts" }),
        toolUse("read_file", { path: "package-lock.json" }),
      ]),
      message([toolUse("finish", { summary: "done" })]),
    ]);
    await investigate({ targetDir: fx.targetDir, wikiDir: fx.wikiDir, config: configForPreset("all"), createMessage });

    const results = (requests[2].messages.at(-1)?.content ?? []) as Anthropic.ToolResultBlockParam[];
    assert.equal(results[0].is_error, true);
    assert.match(String(results[0].content), /already read/);
    assert.doesNotMatch(String(results[0].content), /hello/, "content must not be resent");
    assert.equal(results[1].is_error, true);
    assert.match(String(results[1].content), /lockfile or generated/);
  } finally {
    rmSync(fx.outerDir, { recursive: true, force: true });
  }
});

test("each request cache-marks only the newest message; stored history stays clean", async () => {
  const fx = makeFixture();
  try {
    const { createMessage, requests } = scripted([
      message([toolUse("list_dir", {})]),
      message([toolUse("read_file", { path: "package.json" })]),
      message([toolUse("finish", { summary: "done" })]),
    ]);
    await investigate({ targetDir: fx.targetDir, wikiDir: fx.wikiDir, config: configForPreset("all"), createMessage });

    for (const req of requests) {
      const history = req.messages;
      const last = history[history.length - 1].content as Array<{ cache_control?: { type: string } }>;
      assert.equal(last[last.length - 1].cache_control?.type, "ephemeral", "newest message must carry the breakpoint");
      for (const msg of history.slice(0, -1)) {
        for (const block of msg.content as Array<{ cache_control?: unknown }>) {
          assert.equal(block.cache_control, undefined, "older messages must not accumulate stale breakpoints");
        }
      }
    }
  } finally {
    rmSync(fx.outerDir, { recursive: true, force: true });
  }
});

test("token usage is accumulated across turns and returned", async () => {
  const fx = makeFixture();
  try {
    const first = message([toolUse("list_dir", {})]);
    (first as { usage?: unknown }).usage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 50 };
    const second = message([toolUse("finish", { summary: "done" })]);
    (second as { usage?: unknown }).usage = { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 140, cache_creation_input_tokens: 30 };

    const { createMessage } = scripted([first, second]);
    const result = await investigate({ targetDir: fx.targetDir, wikiDir: fx.wikiDir, config: configForPreset("all"), createMessage });
    assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 15, cacheReadTokens: 140, cacheWriteTokens: 80 });
  } finally {
    rmSync(fx.outerDir, { recursive: true, force: true });
  }
});

test("a text-only reply ends the run as finished with that text as summary", async () => {
  const fx = makeFixture();
  try {
    const { createMessage } = scripted([
      message([{ type: "text", text: "The repo is empty; nothing to document." } as Anthropic.TextBlock], "end_turn"),
    ]);
    const result = await investigate({ targetDir: fx.targetDir, wikiDir: fx.wikiDir, config: configForPreset("all"), createMessage });
    assert.equal(result.stopped, "finished");
    assert.match(result.summary, /nothing to document/);
  } finally {
    rmSync(fx.outerDir, { recursive: true, force: true });
  }
});

/** Scripts an OpenAI-compatible /chat/completions endpoint: each call pops the next JSON body. */
function scriptedFetch(bodies: unknown[]): typeof fetch {
  const queue = [...bodies];
  return (async () => {
    const next = queue.shift();
    if (!next) throw new Error("scripted fetch ran out of responses");
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(next),
      json: async () => next,
    } as Response;
  }) as typeof fetch;
}

test("the OpenAI-compatible adapter composes with the investigation loop end to end", async () => {
  const fx = makeFixture();
  try {
    const fetchImpl = scriptedFetch([
      {
        id: "chatcmpl-1",
        model: "test-model",
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "write_page", arguments: JSON.stringify(PAGE_INPUT) } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 321, completion_tokens: 12 },
      },
      {
        id: "chatcmpl-2",
        model: "test-model",
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call_2", type: "function", function: { name: "finish", arguments: JSON.stringify({ summary: "done via adapter" }) } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 47, completion_tokens: 5 },
      },
    ]);
    const createMessage = createOpenAICompatMessage({ baseUrl: "https://example.test/v1", apiKey: "test-key", fetchImpl });

    const result = await investigate({
      targetDir: fx.targetDir,
      wikiDir: fx.wikiDir,
      config: configForPreset("all"),
      createMessage,
    });

    assert.equal(result.pagesWritten, 1);
    assert.equal(result.stopped, "finished");
    assert.equal(result.usage.inputTokens, 321 + 47);
    const path = join(fx.wikiDir, "content", "en", "start-here", "overview.md");
    assert.ok(existsSync(path), "the adapter's write_page call must reach the real filesystem");
  } finally {
    rmSync(fx.outerDir, { recursive: true, force: true });
  }
});

test("buildSystemPrompt demands product narrative, user-flow diagram, onboarding, and tech rationale for the all preset", () => {
  const prompt = buildSystemPrompt(configForPreset("all"), { sha: "abc1234", locale: "en" });
  assert.match(prompt, /user's journey/);
  assert.match(prompt, /start-here\/overview/);
  assert.match(prompt, /user-flow diagram/);
  assert.match(prompt, /onboarding\/index/);
  assert.match(prompt, /why this technology serves this project/i);
  assert.match(prompt, /Before you call finish/);
});

test("buildSystemPrompt omits required pages whose sections are not in this wiki", () => {
  const prompt = buildSystemPrompt(configForPreset("user-guide"), { sha: "abc1234", locale: "en" });
  assert.ok(!prompt.includes("onboarding/index"));
  assert.ok(!prompt.includes("why this technology serves this project"));
  // The product narrative applies to every preset.
  assert.match(prompt, /start-here\/overview/);
  assert.match(prompt, /Before you call finish/);
});
