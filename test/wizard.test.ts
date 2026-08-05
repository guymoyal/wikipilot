import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_PROMPT_ATTEMPTS, resolvePreset, resolveAiPlan, type PromptIO } from "../src/lib/wizard.js";

/** A scripted stand-in for the terminal: answers come from a queue. */
function fakeIO(answers: string[], interactive = true): PromptIO & { asked: number; output: string[] } {
  const io = {
    interactive,
    asked: 0,
    output: [] as string[],
    async ask() {
      io.asked++;
      return answers.shift() ?? "";
    },
    print(line: string) {
      io.output.push(line);
    },
  };
  return io;
}

test("an explicit --preset skips the prompt entirely", async () => {
  const io = fakeIO([]);
  assert.equal(await resolvePreset({ preset: "user-guide" }, io), "user-guide");
  assert.equal(io.asked, 0);
});

test("an unknown --preset fails with the valid options named", async () => {
  await assert.rejects(() => resolvePreset({ preset: "bogus" }, fakeIO([])), /unknown preset "bogus".*technical, user-guide, all/s);
});

test("--yes takes the default without prompting", async () => {
  const io = fakeIO([]);
  assert.equal(await resolvePreset({ yes: true }, io), "all");
  assert.equal(io.asked, 0);
});

test("a non-interactive stdin never blocks on a prompt", async () => {
  const io = fakeIO([], false);
  assert.equal(await resolvePreset({}, io), "all");
  assert.equal(io.asked, 0, "CI must not be asked a question it cannot answer");
});

test("choosing by number picks that wiki type", async () => {
  assert.equal(await resolvePreset({}, fakeIO(["2"])), "technical");
  assert.equal(await resolvePreset({}, fakeIO(["3"])), "user-guide");
});

test("choosing by name works too", async () => {
  assert.equal(await resolvePreset({}, fakeIO(["user-guide"])), "user-guide");
  assert.equal(await resolvePreset({}, fakeIO(["ALL"])), "all");
});

test("pressing enter accepts the first option", async () => {
  const io = fakeIO(["  "]);
  assert.equal(await resolvePreset({}, io), "all");
  assert.equal(io.asked, 1);
});

test("an invalid answer re-asks instead of guessing", async () => {
  const io = fakeIO(["nope", "2"]);
  assert.equal(await resolvePreset({}, io), "technical");
  assert.equal(io.asked, 2);
  assert.ok(io.output.some((l) => l.includes("Not one of the options")));
});

test("repeated invalid answers give up rather than looping forever", async () => {
  const io = fakeIO(["x", "y", "z", "2"]);
  assert.equal(await resolvePreset({}, io), "all");
  assert.equal(io.asked, MAX_PROMPT_ATTEMPTS, "must stop asking after the attempt limit");
});

test("an out-of-range number is rejected, not silently coerced", async () => {
  const io = fakeIO(["9", "1"]);
  assert.equal(await resolvePreset({}, io), "all");
  assert.equal(io.asked, 2, "9 should be re-asked, not treated as a valid choice");
});

test("every option is listed before the first question", async () => {
  const io = fakeIO(["1"]);
  await resolvePreset({}, io);
  const shown = io.output.join("\n");
  assert.match(shown, /Technical/);
  assert.match(shown, /User guide/);
  assert.match(shown, /Everything/);
});

test("--no-ai disables the AI pass without asking anything", async () => {
  const io = fakeIO([]);
  const plan = await resolveAiPlan({ ai: false }, io, { ANTHROPIC_API_KEY: "sk-env" });
  assert.deepEqual(plan, { enabled: false, provider: "anthropic", saveKey: false });
  assert.equal(io.asked, 0);
});

test("non-interactive runs never prompt and never enable AI without --ai", async () => {
  const io = fakeIO([], false);
  const plan = await resolveAiPlan({}, io, { ANTHROPIC_API_KEY: "sk-env" });
  assert.equal(plan.enabled, false);
  assert.equal(io.asked, 0, "CI must not be asked a question it cannot answer");
});

test("non-interactive --ai with a key runs without prompting", async () => {
  const io = fakeIO([], false);
  const plan = await resolveAiPlan({ ai: true }, io, { ANTHROPIC_API_KEY: "sk-env" });
  assert.deepEqual(plan, { enabled: true, provider: "anthropic", apiKey: "sk-env", saveKey: false });
  assert.equal(io.asked, 0);
});

test("non-interactive --ai without a key stays disabled", async () => {
  const io = fakeIO([], false);
  const plan = await resolveAiPlan({ ai: true }, io, {});
  assert.equal(plan.enabled, false);
});

test("pressing enter accepts the AI pass when a key is already available", async () => {
  const io = fakeIO(["", ""]);
  const plan = await resolveAiPlan({}, io, { ANTHROPIC_API_KEY: "sk-env" });
  assert.deepEqual(plan, { enabled: true, provider: "anthropic", apiKey: "sk-env", saveKey: false });
  assert.equal(io.asked, 2, "with a key on hand there is nothing left to ask once a provider is picked");
});

test("answering n skips the AI pass", async () => {
  const io = fakeIO(["n"]);
  const plan = await resolveAiPlan({}, io, { ANTHROPIC_API_KEY: "sk-env" });
  assert.equal(plan.enabled, false);
});

test("a typed key enables the pass without saving by default", async () => {
  const io = fakeIO(["", "", "sk-typed-123", ""]);
  const plan = await resolveAiPlan({}, io, {});
  assert.deepEqual(plan, { enabled: true, provider: "anthropic", apiKey: "sk-typed-123", saveKey: false });
  assert.equal(io.asked, 4);
});

test("answering y to the save question sets saveKey", async () => {
  const io = fakeIO(["y", "", "sk-typed-456", "y"]);
  const plan = await resolveAiPlan({}, io, {});
  assert.deepEqual(plan, { enabled: true, provider: "anthropic", apiKey: "sk-typed-456", saveKey: true });
});

test("an empty key answer keeps the mechanical draft", async () => {
  const io = fakeIO(["", "", "  "]);
  const plan = await resolveAiPlan({}, io, {});
  assert.equal(plan.enabled, false);
  assert.ok(io.output.some((l) => l.includes("mechanical draft")));
});

test("--ai on a TTY skips the yes/no question but still collects a key", async () => {
  const io = fakeIO(["", "sk-typed-789", ""]);
  const plan = await resolveAiPlan({ ai: true }, io, {});
  assert.deepEqual(plan, { enabled: true, provider: "anthropic", apiKey: "sk-typed-789", saveKey: false });
  assert.equal(io.asked, 3, "no [Y/n] question when --ai was explicit, but still a provider question and a key question");
});

test("resolveAiPlan asks for a provider after a yes and defaults to anthropic on Enter", async () => {
  const io = fakeIO(["", "", ""]); // yes to AI (Enter), provider Enter → 1 (anthropic)
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

test("typing a provider id by name works, not just a number", async () => {
  const io = fakeIO(["", "openai"]);
  const plan = await resolveAiPlan({}, io, { OPENAI_API_KEY: "o" });
  assert.equal(plan.provider, "openai");
});

test("an invalid provider answer re-asks instead of guessing", async () => {
  const io = fakeIO(["", "nope", "2"]);
  const plan = await resolveAiPlan({}, io, { OPENAI_API_KEY: "o" });
  assert.equal(plan.provider, "openai");
  assert.equal(io.asked, 3);
  assert.ok(io.output.some((l) => l.includes("Not one of the options")));
});

test("repeated invalid provider answers give up and fall back to anthropic", async () => {
  const io = fakeIO(["", "x", "y", "z"]);
  const plan = await resolveAiPlan({}, io, { ANTHROPIC_API_KEY: "a" });
  assert.equal(plan.provider, "anthropic");
  assert.equal(io.asked, 1 + MAX_PROMPT_ATTEMPTS, "must stop asking after the attempt limit");
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

test("custom provider with an empty base URL keeps the mechanical draft", async () => {
  const io = fakeIO(["", "4", "", "qwen3:32b"]);
  const plan = await resolveAiPlan({}, io, {});
  assert.equal(plan.enabled, false);
  assert.equal(plan.provider, "custom");
  assert.ok(io.output.some((l) => l.includes("base URL and a model are required")));
});

test("custom provider with an empty model keeps the mechanical draft", async () => {
  const io = fakeIO(["", "4", "http://localhost:11434/v1", "  "]);
  const plan = await resolveAiPlan({}, io, {});
  assert.equal(plan.enabled, false);
  assert.equal(plan.provider, "custom");
  assert.ok(io.output.some((l) => l.includes("base URL and a model are required")));
});

test("non-interactive --ai with the right env var enables without prompting", async () => {
  const io = fakeIO([], false);
  const plan = await resolveAiPlan({ ai: true, provider: "openai" }, io, { OPENAI_API_KEY: "o" });
  assert.equal(plan.enabled, true);
  assert.equal(plan.provider, "openai");
  assert.equal(io.asked, 0, "non-interactive must never prompt");
});

test("non-interactive custom without base-url and model stays disabled, naming the real cause", async () => {
  const io = fakeIO([], false);
  const plan = await resolveAiPlan({ ai: true, provider: "custom" }, io, { WIKI_INIT_API_KEY: "k" });
  assert.equal(plan.enabled, false);
  assert.equal(plan.disabledReason, "custom-incomplete");
  assert.equal(io.asked, 0, "non-interactive must never prompt");
});

test("custom provider with both flags already set uses them without prompting for either", async () => {
  const io = fakeIO(["", "4", "k-local", ""]); // run AI (Enter), provider 4 (custom), key, save? — no base-url/model prompts
  const plan = await resolveAiPlan({ baseUrl: "http://localhost:11434/v1", model: "qwen3:32b" }, io, {});
  assert.equal(plan.enabled, true);
  assert.equal(plan.provider, "custom");
  assert.equal(plan.baseUrl, "http://localhost:11434/v1");
  assert.equal(plan.model, "qwen3:32b");
  assert.equal(plan.apiKey, "k-local");
});

test("custom provider with only --base-url set still prompts for the model", async () => {
  const io = fakeIO(["", "4", "qwen3:32b", "k-local", ""]);
  const plan = await resolveAiPlan({ baseUrl: "http://localhost:11434/v1" }, io, {});
  assert.equal(plan.enabled, true);
  assert.equal(plan.baseUrl, "http://localhost:11434/v1");
  assert.equal(plan.model, "qwen3:32b");
});

test("custom provider with --base-url set and an empty model answer is disabled, naming the real cause", async () => {
  const io = fakeIO(["", "4", "  "]);
  const plan = await resolveAiPlan({ baseUrl: "http://localhost:11434/v1" }, io, {});
  assert.equal(plan.enabled, false);
  assert.equal(plan.provider, "custom");
  assert.equal(plan.disabledReason, "custom-incomplete");
  assert.ok(io.output.some((l) => l.includes("base URL and a model are required")));
});

test("custom provider prompts on empty base-url and model carry disabledReason custom-incomplete", async () => {
  const io = fakeIO(["", "4", "", "qwen3:32b"]);
  const plan = await resolveAiPlan({}, io, {});
  assert.equal(plan.enabled, false);
  assert.equal(plan.disabledReason, "custom-incomplete");
});

test("the key prompt names where to get one when the provider has a keyUrl", async () => {
  const io = fakeIO(["", "", "sk-typed-123", ""]); // yes to AI, provider Enter (anthropic), key, save? no
  await resolveAiPlan({}, io, {});
  assert.ok(
    io.output.some((l) => l.includes("console.anthropic.com/settings/keys")),
    "the anthropic keyUrl should appear in the API key prompt",
  );
});

test("non-interactive custom with base-url and model enables", async () => {
  const io = fakeIO([], false);
  const plan = await resolveAiPlan(
    { ai: true, provider: "custom", baseUrl: "http://localhost:11434/v1", model: "qwen3:32b" },
    io,
    { WIKI_INIT_API_KEY: "k" },
  );
  assert.equal(plan.enabled, true);
  assert.equal(plan.baseUrl, "http://localhost:11434/v1");
  assert.equal(plan.model, "qwen3:32b");
  assert.equal(io.asked, 0, "non-interactive must never prompt");
});
