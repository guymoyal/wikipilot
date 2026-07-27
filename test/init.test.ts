import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/lib/init.js";
import { parseFrontmatter } from "../src/lib/frontmatter.js";

function makeFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wikipilot-init-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture-app", scripts: { build: "tsc" } }));
  return dir;
}

test("init scaffolds config, content pages, and the update-wiki skill with a valid relative path", () => {
  const targetDir = makeFixtureRepo();
  const wikiDir = join(targetDir, "wiki");
  try {
    const result = init({ targetDir, wikiDir });

    assert.ok(result.pagesWritten > 0);
    assert.ok(existsSync(join(wikiDir, "wikipilot.config.json")));
    assert.ok(existsSync(join(wikiDir, "content", "en", "start-here", "overview.md")));

    const overviewRaw = readFileSync(join(wikiDir, "content", "en", "start-here", "overview.md"), "utf8");
    const { frontmatter } = parseFrontmatter(overviewRaw);
    assert.equal(frontmatter.section, "start-here");

    assert.ok(result.skillPath);
    const skillContent = readFileSync(result.skillPath!, "utf8");
    assert.match(skillContent, /`wiki\/content\/</);
    assert.doesNotMatch(
      skillContent,
      /\.\.[\\/][\w-]*[\\/]?content\//,
      "the wiki-directory reference should stay inside the target repo, not escape it",
    );
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("init --preset user-guide drafts user-facing sections and skips the dev-facing ones", () => {
  const targetDir = makeFixtureRepo();
  const wikiDir = join(targetDir, "wiki");
  try {
    const result = init({ targetDir, wikiDir, preset: "user-guide" });

    assert.equal(result.preset, "user-guide");
    assert.ok(existsSync(join(wikiDir, "content", "en", "getting-started", "installation.md")));
    assert.ok(existsSync(join(wikiDir, "content", "en", "faq", "index.md")));
    assert.ok(existsSync(join(wikiDir, "content", "en", "troubleshooting", "index.md")));
    assert.ok(!existsSync(join(wikiDir, "content", "en", "technologies")), "technologies is dev-facing");
    assert.ok(!existsSync(join(wikiDir, "content", "en", "reference")), "reference is dev-facing");

    const config = JSON.parse(readFileSync(join(wikiDir, "wikipilot.config.json"), "utf8"));
    assert.equal(config.preset, "user-guide");
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("init defaults to the technical preset and drafts dev-facing sections", () => {
  const targetDir = makeFixtureRepo();
  const wikiDir = join(targetDir, "wiki");
  try {
    const result = init({ targetDir, wikiDir });
    assert.equal(result.preset, "technical");
    assert.ok(existsSync(join(wikiDir, "content", "en", "technologies")));
    assert.ok(!existsSync(join(wikiDir, "content", "en", "faq")), "faq belongs to the user-guide preset");
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("init --preset all drafts both audiences", () => {
  const targetDir = makeFixtureRepo();
  const wikiDir = join(targetDir, "wiki");
  try {
    init({ targetDir, wikiDir, preset: "all" });
    assert.ok(existsSync(join(wikiDir, "content", "en", "getting-started", "installation.md")));
    assert.ok(existsSync(join(wikiDir, "content", "en", "technologies", "index.md")));
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("the scaffolded skill is preset-aware so it authors the right sections", () => {
  const targetDir = makeFixtureRepo();
  const wikiDir = join(targetDir, "wiki");
  try {
    const result = init({ targetDir, wikiDir, preset: "user-guide" });
    const skillContent = readFileSync(result.skillPath!, "utf8");
    assert.match(skillContent, /\*\*user-guide\*\* preset/);
    assert.match(skillContent, /troubleshooting/);
    assert.doesNotMatch(skillContent, /`technologies\/` —/, "shouldn't brief a section this wiki doesn't have");
    assert.doesNotMatch(skillContent, /https:\/\/github\.com\/\)/, "the wikipilot link must point at the repo");
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("init names the wiki after the project instead of calling it 'Wiki'", () => {
  const targetDir = makeFixtureRepo();
  const wikiDir = join(targetDir, "wiki");
  try {
    const result = init({ targetDir, wikiDir });
    assert.equal(result.siteName, "Fixture App", "package.json name drives the title");

    const config = JSON.parse(readFileSync(join(wikiDir, "wikipilot.config.json"), "utf8"));
    assert.equal(config.siteName, "Fixture App", "and it's persisted so build picks it up");
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("init strips the npm scope when deriving a name", () => {
  const targetDir = mkdtempSync(join(tmpdir(), "wikipilot-scoped-"));
  const wikiDir = join(targetDir, "wiki");
  try {
    writeFileSync(join(targetDir, "package.json"), JSON.stringify({ name: "@acme/billing_service" }));
    assert.equal(init({ targetDir, wikiDir }).siteName, "Billing Service");
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("init falls back to the directory name when there's no package.json", () => {
  const targetDir = mkdtempSync(join(tmpdir(), "wikipilot-noPkg-"));
  const wikiDir = join(targetDir, "wiki");
  try {
    const result = init({ targetDir, wikiDir });
    assert.ok(result.siteName.length > 0);
    assert.notEqual(result.siteName, "Wiki", "should use the folder name, not a generic default");
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("an explicit --site-name overrides the derived one", () => {
  const targetDir = makeFixtureRepo();
  const wikiDir = join(targetDir, "wiki");
  try {
    assert.equal(init({ targetDir, wikiDir, siteName: "Internal Docs" }).siteName, "Internal Docs");
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("init stamps the project's package.json version onto every page and the config", () => {
  const targetDir = mkdtempSync(join(tmpdir(), "wikipilot-version-"));
  const wikiDir = join(targetDir, "wiki");
  try {
    writeFileSync(join(targetDir, "package.json"), JSON.stringify({ name: "billing", version: "2.3.1" }));
    const result = init({ targetDir, wikiDir, preset: "user-guide" });

    assert.equal(result.version, "2.3.1");

    const config = JSON.parse(readFileSync(join(wikiDir, "wikipilot.config.json"), "utf8"));
    assert.equal(config.version, "2.3.1", "the header reads the version from config");

    const page = readFileSync(join(wikiDir, "content", "en", "getting-started", "installation.md"), "utf8");
    const { frontmatter } = parseFrontmatter(page);
    assert.equal(frontmatter.version, "2.3.1", "and every drafted page carries it too");
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("a version like 1.0 survives the frontmatter round-trip as a string", () => {
  const targetDir = mkdtempSync(join(tmpdir(), "wikipilot-version2-"));
  const wikiDir = join(targetDir, "wiki");
  try {
    // Unquoted `1.0` would otherwise parse back as the number 1.
    writeFileSync(join(targetDir, "package.json"), JSON.stringify({ name: "x", version: "1.0" }));
    init({ targetDir, wikiDir });
    const raw = readFileSync(join(wikiDir, "content", "en", "start-here", "overview.md"), "utf8");
    assert.equal(parseFrontmatter(raw).frontmatter.version, "1.0");
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("a project with no version in package.json omits the field entirely", () => {
  const targetDir = makeFixtureRepo(); // fixture has no `version`
  const wikiDir = join(targetDir, "wiki");
  try {
    const result = init({ targetDir, wikiDir });
    assert.equal(result.version, undefined);
    const raw = readFileSync(join(wikiDir, "content", "en", "start-here", "overview.md"), "utf8");
    assert.ok(!/^version:/m.test(raw), "no empty version line in the frontmatter");
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("init throws a clean error for a non-existent target directory", () => {
  const targetDir = join(tmpdir(), "wikipilot-init-does-not-exist-" + Math.random().toString(36).slice(2));
  assert.throws(() => init({ targetDir, wikiDir: join(targetDir, "wiki") }), /does not exist/);
});

test("init --skipSkill omits the .claude skill scaffold", () => {
  const targetDir = makeFixtureRepo();
  const wikiDir = join(targetDir, "wiki");
  try {
    const result = init({ targetDir, wikiDir, skipSkill: true });
    assert.equal(result.skillPath, undefined);
    assert.ok(!existsSync(join(targetDir, ".claude")));
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});
