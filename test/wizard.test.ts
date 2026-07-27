import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_PROMPT_ATTEMPTS, resolvePreset, type PromptIO } from "../src/lib/wizard.js";

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
  assert.equal(await resolvePreset({ yes: true }, io), "technical");
  assert.equal(io.asked, 0);
});

test("a non-interactive stdin never blocks on a prompt", async () => {
  const io = fakeIO([], false);
  assert.equal(await resolvePreset({}, io), "technical");
  assert.equal(io.asked, 0, "CI must not be asked a question it cannot answer");
});

test("choosing by number picks that wiki type", async () => {
  assert.equal(await resolvePreset({}, fakeIO(["2"])), "user-guide");
  assert.equal(await resolvePreset({}, fakeIO(["3"])), "all");
});

test("choosing by name works too", async () => {
  assert.equal(await resolvePreset({}, fakeIO(["user-guide"])), "user-guide");
  assert.equal(await resolvePreset({}, fakeIO(["ALL"])), "all");
});

test("pressing enter accepts the first option", async () => {
  const io = fakeIO(["  "]);
  assert.equal(await resolvePreset({}, io), "technical");
  assert.equal(io.asked, 1);
});

test("an invalid answer re-asks instead of guessing", async () => {
  const io = fakeIO(["nope", "2"]);
  assert.equal(await resolvePreset({}, io), "user-guide");
  assert.equal(io.asked, 2);
  assert.ok(io.output.some((l) => l.includes("Not one of the options")));
});

test("repeated invalid answers give up rather than looping forever", async () => {
  const io = fakeIO(["x", "y", "z", "2"]);
  assert.equal(await resolvePreset({}, io), "technical");
  assert.equal(io.asked, MAX_PROMPT_ATTEMPTS, "must stop asking after the attempt limit");
});

test("an out-of-range number is rejected, not silently coerced", async () => {
  const io = fakeIO(["9", "1"]);
  assert.equal(await resolvePreset({}, io), "technical");
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
