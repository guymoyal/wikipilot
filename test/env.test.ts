import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotEnv, saveEnvKey } from "../src/lib/env.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "wikipilot-env-"));
}

test("saveEnvKey creates .env and a .gitignore entry from nothing", () => {
  const dir = tempDir();
  try {
    saveEnvKey(dir, "ANTHROPIC_API_KEY", "sk-test-1");
    assert.equal(readFileSync(join(dir, ".env"), "utf8"), "ANTHROPIC_API_KEY=sk-test-1\n");
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), ".env\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveEnvKey appends without clobbering existing content", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, ".env"), "OTHER=1", "utf8"); // note: no trailing newline
    writeFileSync(join(dir, ".gitignore"), "node_modules\n", "utf8");
    saveEnvKey(dir, "ANTHROPIC_API_KEY", "sk-test-2");
    assert.equal(readFileSync(join(dir, ".env"), "utf8"), "OTHER=1\nANTHROPIC_API_KEY=sk-test-2\n");
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "node_modules\n.env\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveEnvKey is idempotent when the key already exists", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=already-there\n", "utf8");
    writeFileSync(join(dir, ".gitignore"), ".env\n", "utf8");
    saveEnvKey(dir, "ANTHROPIC_API_KEY", "sk-new");
    assert.equal(readFileSync(join(dir, ".env"), "utf8"), "ANTHROPIC_API_KEY=already-there\n");
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), ".env\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveEnvKey leaves .gitignore alone when .env is already covered", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, ".gitignore"), "/.env\ndist\n", "utf8");
    saveEnvKey(dir, "KEY", "v");
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "/.env\ndist\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDotEnv fills the environment but never overrides set variables", () => {
  const dir = tempDir();
  const setVar = "WIKIPILOT_TEST_SET";
  const unsetVar = "WIKIPILOT_TEST_UNSET";
  try {
    writeFileSync(join(dir, ".env"), `${setVar}=from-file\n${unsetVar}="quoted value"\n`, "utf8");
    process.env[setVar] = "from-env";
    delete process.env[unsetVar];
    loadDotEnv(dir);
    assert.equal(process.env[setVar], "from-env", "real environment wins over .env");
    assert.equal(process.env[unsetVar], "quoted value", "quotes are stripped");
  } finally {
    delete process.env[setVar];
    delete process.env[unsetVar];
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDotEnv is a no-op without a .env file", () => {
  const dir = tempDir();
  try {
    assert.ok(!existsSync(join(dir, ".env")));
    loadDotEnv(dir); // must not throw
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
