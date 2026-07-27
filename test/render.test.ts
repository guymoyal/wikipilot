import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPageHtml, renderIndexHtml } from "../src/lib/site/render.js";
import type { LoadedPage, SidebarGroup } from "../src/lib/site/loadContent.js";

const XSS = '<img src=x onerror=alert(1)>';

function page(overrides: Partial<LoadedPage> = {}): LoadedPage {
  return {
    frontmatter: {
      title: "Safe title",
      description: "Safe description.",
      section: "guides",
      sources: ["src/a.ts"],
      last_synced: "abc1234",
    },
    body: "Body text.",
    slug: "a-page",
    locale: "en",
    section: "guides",
    urlPath: "/guides/a-page/",
    ...overrides,
  };
}

const renderOptions = { siteName: "Wiki", basePath: "", locales: ["en"], defaultLocale: "en" };

function sidebarFor(p: LoadedPage): SidebarGroup[] {
  return [{ section: p.section, pages: [p] }];
}

test("frontmatter titles drafted from a scanned README cannot inject HTML", () => {
  const p = page({ frontmatter: { ...page().frontmatter, title: XSS } });
  const html = renderPageHtml(p, sidebarFor(p), renderOptions);

  assert.ok(!html.includes("<img src=x"), "title must not reach the page as live HTML");
  assert.ok(html.includes("&lt;img src=x"), "it should be escaped, not dropped");
});

test("frontmatter descriptions cannot break out of the meta content attribute", () => {
  const p = page({ frontmatter: { ...page().frontmatter, description: '" onload="alert(1)' } });
  const html = renderPageHtml(p, sidebarFor(p), renderOptions);

  assert.ok(!/content="" onload=/.test(html), "a quote in the description must not break the attribute");
  assert.ok(html.includes("&quot; onload=&quot;alert(1)"));
});

test("source globs and last_synced are escaped in the page footer", () => {
  const p = page({
    frontmatter: { ...page().frontmatter, sources: [XSS], last_synced: XSS },
  });
  const html = renderPageHtml(p, sidebarFor(p), renderOptions);

  assert.ok(!html.includes("<img src=x"));
});

test("the sidebar escapes titles from every page, not just the current one", () => {
  const current = page();
  const other = page({ frontmatter: { ...page().frontmatter, title: XSS }, slug: "other", urlPath: "/guides/other/" });
  const html = renderPageHtml(current, [{ section: "guides", pages: [current, other] }], renderOptions);

  assert.ok(!html.includes("<img src=x"), "a malicious title on any page poisons every page's sidebar");
});

test("the generated index page escapes titles, descriptions, and the site name", () => {
  const p = page({ frontmatter: { ...page().frontmatter, title: XSS, description: XSS } });
  const html = renderIndexHtml(sidebarFor(p), XSS);

  assert.ok(!html.includes("<img src=x"));
});

test("an absolute agent URL is wired in as an escaped attribute", () => {
  const p = page();
  const html = renderPageHtml(p, sidebarFor(p), { ...renderOptions, agent: { url: 'https://api.example.com/chat" onx="' } });

  assert.ok(html.includes("data-agent-url="));
  assert.ok(!/onx="/.test(html), "the URL must not break out of its attribute");
});

test("a fenced block with title= renders a caption naming the source file", () => {
  const p = page({ body: '```ts title="src/billing/refunds.ts"\nconst x = 1;\n```' });
  const html = renderPageHtml(p, sidebarFor(p), renderOptions);

  assert.match(html, /<figcaption>src\/billing\/refunds\.ts<\/figcaption>/);
  assert.match(html, /class="language-ts"/, "the language tag should survive alongside the title");
});

test("a mermaid fence renders as a mermaid block, not a code block", () => {
  const p = page({ body: "```mermaid\nflowchart LR\n  A --> B\n```" });
  const html = renderPageHtml(p, sidebarFor(p), renderOptions);

  assert.match(html, /<pre class="mermaid">flowchart LR/);
});
