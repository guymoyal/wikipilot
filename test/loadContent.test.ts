import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWikiContent, resolveLocalePages, buildSidebar } from "../src/lib/site/loadContent.js";
import { renderPage } from "../src/lib/frontmatter.js";
import { DEFAULT_CONFIG } from "../src/lib/config.js";

function writePage(wikiDir: string, locale: string, section: string, slug: string, order: number, title: string) {
  const dir = join(wikiDir, "content", locale, section);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${slug}.md`),
    renderPage({ title, section, order, sources: ["x"], last_synced: "abc123", locale }, `Body for ${title}`)
  );
}

test("resolveLocalePages falls back to default-locale content and flags it", () => {
  const wikiDir = mkdtempSync(join(tmpdir(), "wikipilot-load-"));
  try {
    writePage(wikiDir, "en", "start-here", "overview", 1, "Overview");
    writePage(wikiDir, "en", "reference", "file-map", 1, "File map");
    writePage(wikiDir, "he", "start-here", "overview", 1, "סקירה");

    const config = { ...DEFAULT_CONFIG, locales: ["en", "he"] };
    const pages = loadWikiContent(wikiDir, config);

    const hePages = resolveLocalePages(pages, config, "he");
    assert.equal(hePages.length, 2);

    const translated = hePages.find((p) => p.slug === "overview");
    assert.equal(translated?.fallback, undefined);
    assert.equal(translated?.frontmatter.title, "סקירה");

    const fallback = hePages.find((p) => p.slug === "file-map");
    assert.equal(fallback?.fallback, true);
    assert.equal(fallback?.urlPath, "/he/reference/file-map/");
  } finally {
    rmSync(wikiDir, { recursive: true, force: true });
  }
});

test("resolveLocalePages for the default locale returns pages unchanged", () => {
  const wikiDir = mkdtempSync(join(tmpdir(), "wikipilot-load-"));
  try {
    writePage(wikiDir, "en", "start-here", "overview", 1, "Overview");
    const pages = loadWikiContent(wikiDir, DEFAULT_CONFIG);
    const enPages = resolveLocalePages(pages, DEFAULT_CONFIG, "en");
    assert.equal(enPages.length, 1);
    assert.equal(enPages[0].fallback, undefined);
  } finally {
    rmSync(wikiDir, { recursive: true, force: true });
  }
});

test("buildSidebar groups by section in config order and sorts by frontmatter.order", () => {
  const wikiDir = mkdtempSync(join(tmpdir(), "wikipilot-load-"));
  try {
    writePage(wikiDir, "en", "reference", "b-page", 2, "B page");
    writePage(wikiDir, "en", "reference", "a-page", 1, "A page");
    writePage(wikiDir, "en", "start-here", "overview", 1, "Overview");

    const pages = loadWikiContent(wikiDir, DEFAULT_CONFIG);
    const sidebar = buildSidebar(pages, DEFAULT_CONFIG);

    assert.equal(sidebar[0].section, "start-here");
    const reference = sidebar.find((g) => g.section === "reference")!;
    assert.deepEqual(reference.pages.map((p) => p.slug), ["a-page", "b-page"]);
  } finally {
    rmSync(wikiDir, { recursive: true, force: true });
  }
});
