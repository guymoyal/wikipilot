import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftContent } from "../src/lib/draft.js";

function makeFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wikipilot-draft-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "fixture-app",
      description: "A fixture app for testing.",
      scripts: { build: "tsc", test: "node --test" },
      dependencies: { react: "^18.0.0" },
      devDependencies: { "@types/node": "^20.0.0" },
    })
  );
  writeFileSync(join(dir, "README.md"), "# fixture-app\n\nA fixture app for testing.\n");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "index.ts"), "export const x = 1;\n");
  return dir;
}

test("draftContent produces pages for every default section with no empty placeholders", () => {
  const dir = makeFixtureRepo();
  try {
    const pages = draftContent(dir);
    const sections = new Set(pages.map((p) => p.section));

    assert.ok(sections.has("start-here"));
    assert.ok(sections.has("technologies"));
    assert.ok(sections.has("how-it-works"));
    assert.ok(sections.has("cookbook"));
    assert.ok(sections.has("reference"));

    for (const page of pages) {
      assert.ok(page.body.trim().length > 0, `page ${page.section}/${page.slug} has no content`);
      assert.ok(page.frontmatter.last_synced.length > 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("draftContent handles scoped package names without producing invalid slugs", () => {
  const dir = makeFixtureRepo();
  try {
    const pages = draftContent(dir);
    const typesPage = pages.find((p) => p.section === "technologies" && p.frontmatter.title === "@types/node");
    assert.ok(typesPage, "expected a drafted page for @types/node");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("draftContent surfaces real package.json scripts in the cookbook", () => {
  const dir = makeFixtureRepo();
  try {
    const pages = draftContent(dir);
    const cookbook = pages.find((p) => p.section === "cookbook");
    assert.ok(cookbook?.body.includes("npm run build"));
    assert.ok(cookbook?.body.includes("npm run test"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("draftContent emits an onboarding stub for the all preset with real detected commands", () => {
  const dir = makeFixtureRepo();
  try {
    const pages = draftContent(dir);
    const onboarding = pages.find((p) => p.section === "onboarding" && p.slug === "index");
    assert.ok(onboarding, "expected an onboarding/index page");
    assert.ok(onboarding.body.includes("npm run test"), "detected scripts appear as day-one commands");
    assert.ok(onboarding.body.includes("`src/`"), "repo tour lists top-level directories");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("draftContent omits onboarding for the user-guide preset", () => {
  const dir = makeFixtureRepo();
  try {
    const pages = draftContent(dir, "user-guide");
    assert.ok(!pages.some((p) => p.section === "onboarding"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
