import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateWiki } from "../src/lib/generateWiki.js";

test("generateWiki does not collide same-named directories at different paths", () => {
  const sourceDir = mkdtempSync(join(tmpdir(), "wikipilot-gen-src-"));
  const outputDir = mkdtempSync(join(tmpdir(), "wikipilot-gen-out-"));
  try {
    mkdirSync(join(sourceDir, "src", "utils"), { recursive: true });
    mkdirSync(join(sourceDir, "test", "utils"), { recursive: true });
    writeFileSync(join(sourceDir, "src", "utils", "a.ts"), "// a");
    writeFileSync(join(sourceDir, "test", "utils", "b.test.ts"), "// b");

    generateWiki({ sourceDir, outputDir });

    const files = readdirSync(outputDir);
    assert.ok(files.includes("src-utils.md"));
    assert.ok(files.includes("test-utils.md"));
  } finally {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(outputDir, { recursive: true, force: true });
  }
});
