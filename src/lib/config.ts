import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Which audience the wiki is drafted for. Picked by the `init` wizard and
 * persisted so `build` and the scaffolded update-wiki skill know what kind of
 * pages belong in this wiki.
 */
export type WikiPreset = "technical" | "user-guide" | "all";

export interface WikipilotConfig {
  preset: WikiPreset;
  /** Shown in the built site's header. Derived at init time; `--site-name` overrides it. */
  siteName?: string;
  /** The documented project's package.json version, captured at init and refreshed on sync. */
  version?: string;
  sections: string[];
  locales: string[];
  sourcesOfTruth: string[];
}

export const TECHNICAL_SECTIONS = ["start-here", "how-it-works", "technologies", "reference", "cookbook"];
export const USER_GUIDE_SECTIONS = ["start-here", "getting-started", "guides", "faq", "troubleshooting"];

/** Union, ordered so a reader moves from onboarding → usage → internals → lookup. */
export const ALL_SECTIONS = [
  "start-here",
  "getting-started",
  "guides",
  "how-it-works",
  "technologies",
  "cookbook",
  "faq",
  "troubleshooting",
  "reference",
];

export const SECTIONS_BY_PRESET: Record<WikiPreset, string[]> = {
  technical: TECHNICAL_SECTIONS,
  "user-guide": USER_GUIDE_SECTIONS,
  all: ALL_SECTIONS,
};

export const PRESET_LABELS: Record<WikiPreset, string> = {
  technical: "Technical — for the people who work on this codebase",
  "user-guide": "User guide — for the people who use what it produces",
  all: "Everything — both audiences, one wiki",
};

export const PRESETS = Object.keys(SECTIONS_BY_PRESET) as WikiPreset[];

export function isWikiPreset(value: string): value is WikiPreset {
  return (PRESETS as string[]).includes(value);
}

export function sectionsForPreset(preset: WikiPreset): string[] {
  return [...SECTIONS_BY_PRESET[preset]];
}

export const DEFAULT_PRESET: WikiPreset = "all";

/** Kept as a named export because older configs and tests refer to it. */
export const DEFAULT_SECTIONS = sectionsForPreset(DEFAULT_PRESET);

export const DEFAULT_CONFIG: WikipilotConfig = {
  preset: DEFAULT_PRESET,
  sections: DEFAULT_SECTIONS,
  locales: ["en"],
  sourcesOfTruth: [],
};

export function configForPreset(preset: WikiPreset): WikipilotConfig {
  return { ...DEFAULT_CONFIG, preset, sections: sectionsForPreset(preset) };
}

export function configPath(wikiDir: string): string {
  return join(wikiDir, "wikipilot.config.json");
}

export function readConfig(wikiDir: string): WikipilotConfig {
  const path = configPath(wikiDir);
  if (!existsSync(path)) return DEFAULT_CONFIG;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const merged: WikipilotConfig = { ...DEFAULT_CONFIG, ...parsed };

  // Configs written before presets existed have no `preset` key. Their explicit
  // `sections` list is the source of truth — don't overwrite it with a default.
  if (!isWikiPreset(merged.preset)) merged.preset = DEFAULT_PRESET;
  if (!Array.isArray(parsed.sections)) merged.sections = sectionsForPreset(merged.preset);

  return merged;
}

export function writeConfig(wikiDir: string, config: WikipilotConfig): void {
  writeFileSync(configPath(wikiDir), JSON.stringify(config, null, 2) + "\n", "utf8");
}
