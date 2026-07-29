import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  USER_GUIDE_SECTIONS,
  configForPreset,
  configPath,
  readConfig,
  sectionsForPreset,
  writeConfig,
} from "../src/lib/config.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "wikipilot-config-"));
}

test("readConfig returns defaults when no config file exists", () => {
  const dir = tempDir();
  try {
    assert.deepEqual(readConfig(dir), DEFAULT_CONFIG);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeConfig then readConfig round-trips and merges with defaults", () => {
  const dir = tempDir();
  try {
    writeConfig(dir, { preset: "technical", sections: ["custom"], locales: ["en", "he"], sourcesOfTruth: ["registry.ts"] });
    const config = readConfig(dir);
    assert.deepEqual(config.sections, ["custom"]);
    assert.deepEqual(config.locales, ["en", "he"]);
    assert.deepEqual(config.sourcesOfTruth, ["registry.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("configForPreset derives the section list from the preset", () => {
  assert.deepEqual(configForPreset("user-guide").sections, USER_GUIDE_SECTIONS);
  assert.equal(configForPreset("user-guide").preset, "user-guide");
  assert.deepEqual(sectionsForPreset("all").slice(0, 2), ["start-here", "getting-started"]);
});

test("sectionsForPreset returns a fresh array callers can't mutate into the shared constant", () => {
  const sections = sectionsForPreset("technical");
  sections.push("injected");
  assert.ok(!sectionsForPreset("technical").includes("injected"));
});

test("readConfig keeps explicit sections from a pre-preset config instead of overwriting them", () => {
  const dir = tempDir();
  try {
    // A config written before `preset` existed.
    writeFileSync(
      configPath(dir),
      JSON.stringify({ sections: ["start-here", "legacy-section"], locales: ["en"], sourcesOfTruth: [] }),
      "utf8",
    );
    const config = readConfig(dir);
    assert.deepEqual(config.sections, ["start-here", "legacy-section"]);
    assert.equal(config.preset, "all", "missing preset falls back to the default");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readConfig fills in sections when a config names only a preset", () => {
  const dir = tempDir();
  try {
    writeFileSync(configPath(dir), JSON.stringify({ preset: "user-guide" }), "utf8");
    assert.deepEqual(readConfig(dir).sections, USER_GUIDE_SECTIONS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
