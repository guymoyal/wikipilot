import MarkdownIt from "markdown-it";
import { urlPathFor, localeDir, type LoadedPage, type SidebarGroup } from "./loadContent.js";

const md = new MarkdownIt({ html: false, linkify: true });

const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const info = token.info.trim();

  if (info === "mermaid") {
    return `<pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre>`;
  }

  // ```ts title="src/billing/refunds.ts" — captions the snippet with the file it
  // was copied from, so a reader (or the sync skill) can go verify it.
  const title = /\btitle="([^"]*)"/.exec(info)?.[1];
  if (!title) return defaultFence(tokens, idx, options, env, self);

  const lang = info.split(/\s+/)[0];
  token.info = lang.startsWith("title=") ? "" : lang;
  const rendered = defaultFence(tokens, idx, options, env, self);
  token.info = info;

  return `<figure class="code-figure"><figcaption>${md.utils.escapeHtml(title)}</figcaption>${rendered}</figure>`;
};

/**
 * Frontmatter is untrusted: titles and descriptions are drafted from whatever a
 * scanned repo's README happens to contain. markdown-it's `html: false` guards
 * the page body, but every interpolation outside it has to escape on its own.
 * Escapes `& < > "`, so it is safe in both text and double-quoted attributes.
 */
function esc(value: unknown): string {
  return md.utils.escapeHtml(String(value ?? ""));
}

function titleCase(slug: string): string {
  return slug.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const SECTION_ICONS: Record<string, string> = {
  "start-here": "🚀",
  technologies: "🧩",
  "how-it-works": "⚙️",
  cookbook: "📖",
  reference: "📚",
};

function sectionIcon(section: string): string {
  return SECTION_ICONS[section] ?? "📄";
}

function brandMark(siteName: string): string {
  const letter = (siteName.trim()[0] ?? "W").toUpperCase();
  return `<span class="brand-mark">${esc(letter)}</span>`;
}

function renderSidebar(groups: SidebarGroup[], currentUrl: string, basePath: string): string {
  return groups
    .map((group) => {
      const items = group.pages
        .map((p) => {
          const href = basePath + p.urlPath.replace(/^\//, "");
          const active = p.urlPath === currentUrl ? ' class="active"' : "";
          return `<li><a href="${esc(href)}"${active} dir="auto">${esc(p.frontmatter.title)}</a></li>`;
        })
        .join("");
      return `<div class="sidebar-group"><h4>${esc(titleCase(group.section))}</h4><ul>${items}</ul></div>`;
    })
    .join("");
}

function renderHeader(siteName: string, base: string, localeSwitcherHtml: string, version?: string): string {
  const versionBadge = version ? `<span class="brand-version">v${esc(version)}</span>` : "";
  return `<header class="site-header">
    <a class="brand" href="${esc(base)}">${brandMark(siteName)}<span>${esc(siteName)}</span>${versionBadge}</a>
    <div class="search-box">
      <input type="text" placeholder="Search the wiki..." autocomplete="off" />
      <kbd class="search-kbd">⌘K</kbd>
      <div class="search-results"></div>
    </div>
    <div class="header-actions">
      ${localeSwitcherHtml}
      <button class="theme-toggle" aria-label="Toggle theme">◐</button>
    </div>
  </header>`;
}

export interface AgentTarget {
  /** Local dev: the widget calls `<same-host>:<port>/api/chat`. */
  port?: number;
  /** Hosting: an absolute endpoint, so the static site and the API can live apart. */
  url?: string;
}

export interface RenderOptions {
  siteName: string;
  /** The documented project's version, shown next to the wiki name. */
  version?: string;
  basePath: string;
  locales: string[];
  defaultLocale: string;
  agent?: AgentTarget;
}

/**
 * The built site is static HTML — the only thing that needs a server is the
 * optional assistant, and it's wired in as data attributes the client reads.
 */
function agentAttrs(agent?: AgentTarget): string {
  if (agent?.url) return ` data-agent-url="${esc(agent.url)}"`;
  if (agent?.port) return ` data-agent-port="${Number(agent.port)}"`;
  return "";
}

const LOCALE_LABELS: Record<string, string> = { en: "EN", he: "עברית", ar: "العربية", fr: "FR", es: "ES", de: "DE", ja: "日本語", zh: "中文" };

function renderLocaleSwitcher(page: LoadedPage, options: RenderOptions, base: string): string {
  if (options.locales.length < 2) return "";
  const links = options.locales
    .map((locale) => {
      const href = base + urlPathFor(locale, options.defaultLocale, page.section, page.slug).replace(/^\//, "");
      const active = locale === page.locale ? ' class="active"' : "";
      return `<a href="${esc(href)}"${active}>${esc(LOCALE_LABELS[locale] ?? locale)}</a>`;
    })
    .join("");
  return `<div class="locale-switcher">${links}</div>`;
}

export function renderIndexHtml(sidebar: SidebarGroup[], siteName: string, locale = "en", dir: "ltr" | "rtl" = "ltr", agent?: AgentTarget, version?: string): string {
  const agentAttr = agentAttrs(agent);
  const localePrefix = new RegExp(`^/${locale}/`);
  const pageCount = sidebar.reduce((n, group) => n + group.pages.length, 0);

  const cards = sidebar
    .map((group) => {
      const blurb = group.pages[0]?.frontmatter.description ?? "";
      const items = group.pages
        .slice(0, 5)
        .map((p) => `<li><a href="${esc(p.urlPath.replace(localePrefix, "").replace(/^\//, ""))}">${esc(p.frontmatter.title)}</a></li>`)
        .join("");
      const cardHref = group.pages[0]?.urlPath.replace(localePrefix, "").replace(/^\//, "") ?? "#";
      return `<div class="section-card">
        <div class="section-card-icon">${sectionIcon(group.section)}</div>
        <h2><a href="${esc(cardHref)}">${esc(titleCase(group.section))}</a></h2>
        ${blurb ? `<p>${esc(blurb)}</p>` : ""}
        <ul>${items}</ul>
      </div>`;
    })
    .join("");

  const firstPageUrl = sidebar[0]?.pages[0]?.urlPath.replace(localePrefix, "").replace(/^\//, "") ?? "#";

  return `<!doctype html>
<html lang="${esc(locale)}" dir="${dir}" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(siteName)}</title>
<link rel="stylesheet" href="assets/theme.css" />
</head>
<body data-base=""${agentAttr}>
${renderHeader(siteName, "", "", version)}
<main class="hero-page">
  <section class="hero">
    <div class="hero-copy">
      <span class="hero-eyebrow">Wiki</span>
      <h1>${esc(siteName)}</h1>
      <p>${pageCount} page${pageCount === 1 ? "" : "s"} across ${sidebar.length} section${sidebar.length === 1 ? "" : "s"}, generated from the real codebase — every page tracks the sources it came from.</p>
      <div class="hero-actions">
        <a class="btn btn-primary" href="${esc(firstPageUrl)}">Start reading →</a>
      </div>
    </div>
    <div class="hero-mark">${esc((siteName.trim()[0] ?? "W").toUpperCase())}</div>
  </section>
  <div class="card-grid">${cards}</div>
</main>
<script src="assets/minisearch.js"></script>
<script src="assets/client.js"></script>
</body>
</html>
`;
}

export function renderPageHtml(page: LoadedPage, sidebar: SidebarGroup[], options: RenderOptions): string {
  const bodyHtml = md.render(page.body);
  const staleBanner = page.frontmatter.stale
    ? `<div class="stale-banner">This page may be outdated — its sources changed since the prose was last verified (${esc(page.frontmatter.last_synced)}).</div>`
    : "";
  const fallbackBanner = page.fallback
    ? `<div class="fallback-banner">Not yet translated — showing the ${esc(options.defaultLocale)} version.</div>`
    : "";

  const depth = page.urlPath.split("/").filter(Boolean).length;
  const base = options.basePath + "../".repeat(depth);
  const dir = localeDir(page.locale);
  const agentAttr = agentAttrs(options.agent);

  return `<!doctype html>
<html lang="${esc(page.locale)}" dir="${dir}" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(page.frontmatter.title)} · ${esc(options.siteName)}</title>
<meta name="description" content="${esc(page.frontmatter.description ?? "")}" />
<link rel="stylesheet" href="${esc(base)}assets/theme.css" />
</head>
<body data-base="${esc(base)}"${agentAttr}>
${renderHeader(options.siteName, base, renderLocaleSwitcher(page, options, base), options.version)}
<div class="layout">
  <nav class="sidebar">
    ${renderSidebar(sidebar, page.urlPath, base)}
  </nav>
  <main class="main">
    ${staleBanner}
    ${fallbackBanner}
    <article${page.fallback ? ' dir="ltr"' : ""}>
      ${bodyHtml}
    </article>
    <p class="page-meta" dir="ltr">Sources: ${page.frontmatter.sources.map((s) => `<code>${esc(s)}</code>`).join(", ")} · last synced <code>${esc(page.frontmatter.last_synced)}</code>${page.frontmatter.version ? ` · version <code>${esc(page.frontmatter.version)}</code>` : ""}</p>
  </main>
</div>
<script src="${esc(base)}assets/minisearch.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<script src="${esc(base)}assets/client.js"></script>
</body>
</html>
`;
}
