import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { draftContent } from "./draft.js";
import { renderPage } from "./frontmatter.js";
import { DEFAULT_PRESET, configForPreset, writeConfig, type WikiPreset } from "./config.js";
import { scaffoldUpdateWikiSkill } from "./skill.js";

export interface InitOptions {
  targetDir: string;
  wikiDir: string;
  /** Which audience to draft for. Resolved by the CLI wizard before it gets here. */
  preset?: WikiPreset;
  /** Overrides the name derived from package.json / the directory name. */
  siteName?: string;
  skipSkill?: boolean;
}

export interface InitResult {
  pagesWritten: number;
  wikiDir: string;
  preset: WikiPreset;
  sections: string[];
  siteName: string;
  skillPath?: string;
}

/**
 * A wiki titled "Wiki" tells the reader nothing, so name it after the project.
 * `my-app` reads better as "My App" in a site header, and `--site-name` is there
 * for anyone who disagrees.
 */
function deriveSiteName(targetDir: string): string {
  let raw = basename(resolve(targetDir));

  try {
    const pkg = JSON.parse(readFileSync(join(targetDir, "package.json"), "utf8"));
    if (typeof pkg.name === "string" && pkg.name.trim()) {
      raw = pkg.name.replace(/^@[^/]+\//, ""); // drop the npm scope
    }
  } catch {
    // No package.json, or it's unreadable — the directory name is a fine fallback.
  }

  const words = raw.replace(/[-_.]+/g, " ").trim();
  return words.replace(/\b\w/g, (c) => c.toUpperCase()) || "Wiki";
}

export function init(options: InitOptions): InitResult {
  const { targetDir, wikiDir } = options;
  const preset = options.preset ?? DEFAULT_PRESET;

  if (!existsSync(targetDir)) {
    throw new Error(`Source directory does not exist: ${targetDir}`);
  }

  const siteName = options.siteName ?? deriveSiteName(targetDir);
  const config = { ...configForPreset(preset), siteName };

  mkdirSync(wikiDir, { recursive: true });
  writeConfig(wikiDir, config);

  const pages = draftContent(targetDir, preset);
  let pagesWritten = 0;

  for (const page of pages) {
    const dir = join(wikiDir, "content", page.frontmatter.locale ?? "en", page.section);
    mkdirSync(dir, { recursive: true });
    const safeSlug = page.slug.replace(/[\\/]/g, "-");
    writeFileSync(join(dir, `${safeSlug}.md`), renderPage(page.frontmatter, page.body), "utf8");
    pagesWritten++;
  }

  const skillPath = options.skipSkill ? undefined : scaffoldUpdateWikiSkill(targetDir, wikiDir, config);

  return { pagesWritten, wikiDir, preset, sections: config.sections, siteName, skillPath };
}
