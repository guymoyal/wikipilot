import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPage, parseFrontmatter, type PageFrontmatter } from "../src/lib/frontmatter.js";

test("frontmatter round-trips through render + parse", () => {
  const fm: PageFrontmatter = {
    title: "Overview",
    description: "What this repo is",
    section: "start-here",
    order: 1,
    sources: ["package.json", "README.md"],
    last_synced: "abc1234",
    locale: "en",
  };

  const rendered = renderPage(fm, "## Hello\n\nSome body text.");
  const { frontmatter, body } = parseFrontmatter(rendered);

  assert.deepEqual(frontmatter, fm);
  assert.match(body, /## Hello/);
  assert.match(body, /Some body text\./);
});

test("frontmatter parses stale + no-description pages", () => {
  const fm: PageFrontmatter = {
    title: "File map",
    section: "reference",
    sources: ["**/*"],
    last_synced: "deadbee",
    stale: true,
  };
  const rendered = renderPage(fm, "content");
  const { frontmatter } = parseFrontmatter(rendered);

  assert.equal(frontmatter.stale, true);
  assert.equal(frontmatter.description, undefined);
  assert.equal(frontmatter.order, undefined);
});

test("parseFrontmatter throws without a frontmatter block", () => {
  assert.throws(() => parseFrontmatter("# just markdown, no frontmatter"));
});
