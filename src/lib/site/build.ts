import { mkdirSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import MiniSearch from "minisearch";
import { readConfig } from "../config.js";
import { loadWikiContent, buildSidebar, resolveLocalePages } from "./loadContent.js";
import { renderPageHtml, renderIndexHtml, type AgentTarget } from "./render.js";
import { localeDir } from "./loadContent.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface BuildOptions {
  wikiDir: string;
  outDir: string;
  siteName?: string;
  agent?: AgentTarget;
}

export interface BuildResult {
  pagesBuilt: number;
  outDir: string;
}

function copyAssets(outDir: string): void {
  const assetsOut = join(outDir, "assets");
  mkdirSync(assetsOut, { recursive: true });
  const assetsSrc = join(__dirname, "assets");
  for (const file of readdirSync(assetsSrc)) {
    copyFileSync(join(assetsSrc, file), join(assetsOut, file));
  }
}

export function buildSite(options: BuildOptions): BuildResult {
  const { wikiDir, outDir } = options;
  const config = readConfig(wikiDir);
  // Explicit flag wins, then whatever `init` derived from the project, then a
  // last-resort generic name.
  const siteName = options.siteName ?? config.siteName ?? "Wiki";
  const version = config.version;
  const pages = loadWikiContent(wikiDir, config);
  const defaultLocale = config.locales[0] ?? "en";

  mkdirSync(outDir, { recursive: true });
  copyAssets(outDir);

  const miniSearch = new MiniSearch({
    fields: ["title", "body"],
    storeFields: ["title", "url"],
  });

  let pagesBuilt = 0;
  for (const locale of config.locales) {
    const localePages = resolveLocalePages(pages, config, locale);
    const sidebar = buildSidebar(localePages, config);

    const hasRoot = localePages.some((p) => p.urlPath === "/" || p.urlPath === `/${locale}/`);
    if (!hasRoot) {
      const rootPath = locale === defaultLocale ? join(outDir, "index.html") : join(outDir, locale, "index.html");
      mkdirSync(dirname(rootPath), { recursive: true });
      writeFileSync(rootPath, renderIndexHtml(sidebar, siteName, locale, localeDir(locale), options.agent, version), "utf8");
      pagesBuilt++;
    }

    for (const page of localePages) {
      const html = renderPageHtml(page, sidebar, { siteName, version, basePath: "", locales: config.locales, defaultLocale, agent: options.agent });
      const relPath = page.urlPath.replace(/^\//, "");
      const filePath = relPath === "" ? join(outDir, "index.html") : join(outDir, relPath, "index.html");
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, html, "utf8");
      pagesBuilt++;

      if (!page.fallback) {
        miniSearch.add({
          id: page.urlPath,
          title: page.frontmatter.title,
          body: page.body,
          url: page.urlPath,
        });
      }
    }
  }

  writeFileSync(
    join(outDir, "search-index.json"),
    JSON.stringify({
      index: miniSearch.toJSON(),
      options: { fields: ["title", "body"], storeFields: ["title", "url"] },
    }),
    "utf8"
  );

  return { pagesBuilt, outDir };
}
