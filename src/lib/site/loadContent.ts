import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, type PageFrontmatter } from "../frontmatter.js";
import type { WikipilotConfig } from "../config.js";

export interface LoadedPage {
  frontmatter: PageFrontmatter;
  body: string;
  slug: string;
  locale: string;
  section: string;
  urlPath: string;
  fallback?: boolean;
}

export const RTL_LOCALES = new Set(["he", "ar", "fa", "ur"]);

export function localeDir(locale: string): "rtl" | "ltr" {
  return RTL_LOCALES.has(locale) ? "rtl" : "ltr";
}

export function urlPathFor(locale: string, defaultLocale: string, section: string, slug: string): string {
  const slugPart = slug === "index" ? "" : `${slug}/`;
  return locale === defaultLocale ? `/${section}/${slugPart}` : `/${locale}/${section}/${slugPart}`;
}

export function loadWikiContent(wikiDir: string, config: WikipilotConfig): LoadedPage[] {
  const contentDir = join(wikiDir, "content");
  const defaultLocale = config.locales[0] ?? "en";
  if (!existsSync(contentDir)) return [];

  const pages: LoadedPage[] = [];
  const locales = existsSync(contentDir) ? readdirSync(contentDir) : [];

  for (const locale of locales) {
    const localeDirPath = join(contentDir, locale);
    const sections = readdirSync(localeDirPath);
    for (const section of sections) {
      const sectionDir = join(localeDirPath, section);
      const files = readdirSync(sectionDir).filter((f) => f.endsWith(".md"));
      for (const file of files) {
        const slug = file.replace(/\.md$/, "");
        const raw = readFileSync(join(sectionDir, file), "utf8");
        const { frontmatter, body } = parseFrontmatter(raw);
        pages.push({
          frontmatter,
          body,
          slug,
          locale,
          section,
          urlPath: urlPathFor(locale, defaultLocale, section, slug),
        });
      }
    }
  }

  return pages;
}

/**
 * For a given target locale, returns every default-locale page, using the real
 * translation when one exists and falling back to the default-locale content
 * (flagged `fallback: true`) when it doesn't — so navigation/sidebar is always complete.
 */
export function resolveLocalePages(allPages: LoadedPage[], config: WikipilotConfig, locale: string): LoadedPage[] {
  const defaultLocale = config.locales[0] ?? "en";
  const defaultPages = allPages.filter((p) => p.locale === defaultLocale);
  if (locale === defaultLocale) return defaultPages;

  const localeKey = (p: LoadedPage) => `${p.section}/${p.slug}`;
  const translated = new Map(allPages.filter((p) => p.locale === locale).map((p) => [localeKey(p), p]));

  return defaultPages.map((defPage) => {
    const key = localeKey(defPage);
    const match = translated.get(key);
    if (match) return match;
    return {
      ...defPage,
      locale,
      urlPath: urlPathFor(locale, defaultLocale, defPage.section, defPage.slug),
      fallback: true,
    };
  });
}

export interface SidebarGroup {
  section: string;
  pages: LoadedPage[];
}

export function buildSidebar(pages: LoadedPage[], config: WikipilotConfig): SidebarGroup[] {
  const bySection = new Map<string, LoadedPage[]>();

  for (const page of pages) {
    const list = bySection.get(page.section) ?? [];
    list.push(page);
    bySection.set(page.section, list);
  }

  const orderedSections = [...config.sections, ...[...bySection.keys()].filter((s) => !config.sections.includes(s))];

  return orderedSections
    .filter((section) => bySection.has(section))
    .map((section) => ({
      section,
      pages: (bySection.get(section) ?? []).sort((a, b) => {
        const orderDiff = (a.frontmatter.order ?? Infinity) - (b.frontmatter.order ?? Infinity);
        if (orderDiff !== 0) return orderDiff;
        return a.frontmatter.title.localeCompare(b.frontmatter.title);
      }),
    }));
}
