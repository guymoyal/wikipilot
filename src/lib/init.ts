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
  /** The documented project's version, if it has a package.json. */
  version?: string;
  skillPath?: string;
}

/**
 * A wiki titled "Wiki" tells the reader nothing, so name it after the project.
 * `my-app` reads better as "My App" in a site header, and `--site-name` is there
 * for anyone who disagrees.
 */
function readPackageJson(targetDir: string): { name?: string; version?: string } {
  try {
    return JSON.parse(readFileSync(join(targetDir, "package.json"), "utf8"));
  } catch {
    return {};
  }
}

function deriveSiteName(targetDir: string, pkgName?: string): string {
  // Drop the npm scope: "@acme/billing-service" reads better as "Billing Service".
  const raw = pkgName?.trim() ? pkgName.replace(/^@[^/]+\//, "") : basename(resolve(targetDir));
  const words = raw.replace(/[-_.]+/g, " ").trim();
  return words.replace(/\b\w/g, (c) => c.toUpperCase()) || "Wiki";
}

export function init(options: InitOptions): InitResult {
  const { targetDir, wikiDir } = options;
  const preset = options.preset ?? DEFAULT_PRESET;

  if (!existsSync(targetDir)) {
    throw new Error(`Source directory does not exist: ${targetDir}`);
  }

  const pkg = readPackageJson(targetDir);
  const siteName = options.siteName ?? deriveSiteName(targetDir, pkg.name);
  const version = typeof pkg.version === "string" ? pkg.version : undefined;
  const config = { ...configForPreset(preset), siteName, ...(version ? { version } : {}) };

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

  return { pagesWritten, wikiDir, preset, sections: config.sections, siteName, version, skillPath };
}
