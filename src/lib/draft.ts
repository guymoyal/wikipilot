import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { scanDirectory, collectExtensionStats, type ScannedDir } from "./scan.js";
import type { PageFrontmatter } from "./frontmatter.js";
import { DEFAULT_PRESET, sectionsForPreset, type WikiPreset } from "./config.js";

export interface DraftedPage {
  section: string;
  slug: string;
  frontmatter: PageFrontmatter;
  body: string;
}

interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  main?: string;
  bin?: string | Record<string, string>;
  engines?: Record<string, string>;
}

const KNOWN_TECH_DESCRIPTIONS: Record<string, string> = {
  react: "UI library for building component-based interfaces.",
  next: "React framework providing routing, SSR, and build tooling.",
  typescript: "Typed superset of JavaScript used across this codebase.",
  express: "Minimal HTTP server framework for Node.js.",
  commander: "Library for building command-line interfaces and parsing CLI arguments.",
  tailwindcss: "Utility-first CSS framework.",
  vite: "Frontend build tool and dev server.",
  vitest: "Test runner used for unit/integration tests.",
  eslint: "Linter enforcing code-quality and style rules.",
  prettier: "Opinionated code formatter.",
  jest: "Test runner used for unit/integration tests.",
  zod: "Runtime schema validation library.",
  axios: "HTTP client used for making network requests.",
  lodash: "Utility library for common data operations.",
};

function getGitSha(targetDir: string): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: targetDir, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

function readPackageJson(targetDir: string): PackageJson | null {
  const path = join(targetDir, "package.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function firstParagraph(readme: string): string {
  const withoutHeading = readme.replace(/^#.*\n+/, "");
  const paragraph = withoutHeading.split(/\n\s*\n/)[0]?.trim();
  return paragraph ?? "";
}

interface ReadmeSection {
  heading: string;
  level: number;
  body: string;
}

/**
 * Splits a README into its headed sections. Fenced code blocks are tracked so a
 * `# comment` inside a bash snippet isn't mistaken for a heading.
 */
function parseReadmeSections(readme: string): ReadmeSection[] {
  const sections: ReadmeSection[] = [];
  let current: { heading: string; level: number; lines: string[] } | null = null;
  let inFence = false;

  for (const line of readme.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;

    const heading = inFence ? null : /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (current) sections.push({ heading: current.heading, level: current.level, body: current.lines.join("\n").trim() });
      current = { heading: heading[2].replace(/[*_`]/g, "").trim(), level: heading[1].length, lines: [] };
      continue;
    }

    current?.lines.push(line);
  }

  if (current) sections.push({ heading: current.heading, level: current.level, body: current.lines.join("\n").trim() });
  return sections;
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled"
  );
}

const INSTALL_HEADING = /^(install(ation|ing)?|set[- ]?up|requirements|prerequisites)$/i;
const QUICKSTART_HEADING = /^(quick[- ]?start|getting started|usage|first steps|basic usage|how to use)$/i;
const FAQ_HEADING = /^(faq|frequently asked questions|questions|q ?& ?a)$/i;
const TROUBLESHOOTING_HEADING = /^(troubleshooting|troubleshoot|common (issues|problems)|known issues|gotchas|debugging)$/i;

/** Headings that belong to the repo's own maintainers, not to someone using it. */
const NOT_A_GUIDE =
  /^(licen[cs]e|contributing|contributors|development|developing|changelog|credits|acknowledge?ments?|roadmap|table of contents|contents|badges|stars?|sponsors?|authors?)$/i;

function findSection(sections: ReadmeSection[], pattern: RegExp): ReadmeSection | undefined {
  return sections.find((s) => pattern.test(s.heading));
}

function installCommand(pkg: PackageJson | null): string | null {
  if (!pkg?.name) return null;
  return pkg.bin ? `npm install -g ${pkg.name}` : `npm install ${pkg.name}`;
}

function draftGettingStarted(tree: ScannedDir, pkg: PackageJson | null, sha: string): DraftedPage[] {
  const sections = tree.readme ? parseReadmeSections(tree.readme) : [];
  const name = pkg?.name ?? tree.name;
  const pages: DraftedPage[] = [];

  const installLines: string[] = [];
  const engines = pkg?.engines ? Object.entries(pkg.engines) : [];
  if (engines.length) {
    installLines.push("## Before you start", "");
    for (const [engine, range] of engines) {
      installLines.push(`- ${engine} \`${range}\``);
    }
    installLines.push("");
  }

  const install = installCommand(pkg);
  const readmeInstall = findSection(sections, INSTALL_HEADING);
  const installBlock = install ? ["```bash", install, "```", ""] : [];

  if (readmeInstall?.body) {
    // Prefer the README's own words, and only add the derived command when the
    // README doesn't already show one — otherwise the page repeats itself.
    installLines.push(`## ${readmeInstall.heading}`, "", readmeInstall.body, "");
    if (!/\b(npm|pnpm|yarn|bun|npx|pip|brew|docker|go|cargo) \S/.test(readmeInstall.body)) {
      installLines.push(...installBlock);
    }
  } else if (installBlock.length) {
    installLines.push("## Install", "", ...installBlock);
  }

  if (!installLines.length) {
    installLines.push(
      `No install instructions were detectable for \`${name}\` — there's no \`name\` in \`package.json\` and no Install section in the README.`,
      "",
      "Write the real steps here: what a user needs installed first, and the exact command that installs this.",
      "",
    );
  }

  pages.push({
    section: "getting-started",
    slug: "installation",
    frontmatter: {
      title: "Installation",
      description: `How to install ${name} and what you need first.`,
      section: "getting-started",
      order: 1,
      sources: ["package.json", "README.md"],
      last_synced: sha,
      locale: "en",
    },
    body: installLines.join("\n"),
  });

  const quickstart = findSection(sections, QUICKSTART_HEADING);
  const quickstartLines: string[] = [];
  if (quickstart?.body) {
    quickstartLines.push(quickstart.body, "");
  } else if (pkg?.bin && typeof pkg.bin === "object") {
    quickstartLines.push("Run the CLI:", "");
    for (const command of Object.keys(pkg.bin)) {
      quickstartLines.push("```bash", `${command} --help`, "```", "");
    }
    quickstartLines.push("Replace this with the shortest path from install to a real result.", "");
  } else {
    quickstartLines.push(
      "No quick-start section was found in the README to draft from.",
      "",
      "Write the shortest path from a clean install to a user's first real result here — the fewest commands or clicks that produce something they can see.",
      "",
    );
  }

  pages.push({
    section: "getting-started",
    slug: "quickstart",
    frontmatter: {
      title: "Quick start",
      description: `The shortest path from installing ${name} to a first result.`,
      section: "getting-started",
      order: 2,
      sources: ["README.md", "package.json"],
      last_synced: sha,
      locale: "en",
    },
    body: quickstartLines.join("\n"),
  });

  return pages;
}

function draftGuides(tree: ScannedDir, pkg: PackageJson | null, sha: string): DraftedPage[] {
  const sections = tree.readme ? parseReadmeSections(tree.readme) : [];
  const name = pkg?.name ?? tree.name;

  // Top-level README sections that aren't install/quickstart/FAQ/maintainer material
  // are the closest thing to task-shaped user documentation already written down.
  const candidates = sections.filter(
    (s) =>
      s.level === 2 &&
      s.body.length > 0 &&
      !INSTALL_HEADING.test(s.heading) &&
      !QUICKSTART_HEADING.test(s.heading) &&
      !FAQ_HEADING.test(s.heading) &&
      !TROUBLESHOOTING_HEADING.test(s.heading) &&
      !NOT_A_GUIDE.test(s.heading),
  );

  const seen = new Set<string>();
  const guides = candidates.filter((s) => {
    const slug = slugify(s.heading);
    if (slug === "index" || seen.has(slug)) return false;
    seen.add(slug);
    return true;
  });

  const indexLines: string[] = [];
  if (guides.length) {
    indexLines.push(`Task-shaped guides for using ${name}, drafted from the README's own sections.`, "");
    for (const guide of guides) {
      indexLines.push(`- [${guide.heading}](./${slugify(guide.heading)}/)`);
    }
    indexLines.push("", "Each one is a starting point, not a finished guide — rewrite them around what a user is trying to do, not around how the README happened to be organised.");
  } else {
    indexLines.push(
      `No README sections were found to draft guides from for ${name}.`,
      "",
      "Add one page per task a user actually wants to accomplish. Name them after the goal (\"Import an existing project\") rather than the feature (\"The import module\").",
    );
  }

  const pages: DraftedPage[] = [
    {
      section: "guides",
      slug: "index",
      frontmatter: {
        title: "Guides",
        description: `Step-by-step guides for getting things done with ${name}.`,
        section: "guides",
        order: 1,
        sources: ["README.md"],
        last_synced: sha,
        locale: "en",
      },
      body: indexLines.join("\n"),
    },
  ];

  for (const guide of guides) {
    pages.push({
      section: "guides",
      slug: slugify(guide.heading),
      frontmatter: {
        title: guide.heading,
        description: `Drafted from the "${guide.heading}" section of the README.`,
        section: "guides",
        sources: ["README.md"],
        last_synced: sha,
        locale: "en",
      },
      body: guide.body,
    });
  }

  return pages;
}

function draftFaq(tree: ScannedDir, pkg: PackageJson | null, sha: string): DraftedPage[] {
  const sections = tree.readme ? parseReadmeSections(tree.readme) : [];
  const existing = findSection(sections, FAQ_HEADING);
  const name = pkg?.name ?? tree.name;

  const lines = existing?.body
    ? [existing.body]
    : [
        `No FAQ section was found in the README to draft from.`,
        "",
        `Fill this in from real questions people ask about ${name} — support threads, issues, and the things new users get wrong. Write each entry as the question someone actually types, then answer it in the first two sentences.`,
        "",
        "## Example shape",
        "",
        "### Does this need an API key?",
        "",
        "Answer directly, then explain. Questions and answers in this shape are what search engines and AI assistants quote.",
      ];

  return [
    {
      section: "faq",
      slug: "index",
      frontmatter: {
        title: "FAQ",
        description: `Common questions about ${name}, answered directly.`,
        section: "faq",
        order: 1,
        sources: ["README.md"],
        last_synced: sha,
        locale: "en",
      },
      body: lines.join("\n"),
    },
  ];
}

function draftTroubleshooting(tree: ScannedDir, pkg: PackageJson | null, sha: string): DraftedPage[] {
  const sections = tree.readme ? parseReadmeSections(tree.readme) : [];
  const existing = findSection(sections, TROUBLESHOOTING_HEADING);
  const name = pkg?.name ?? tree.name;

  const lines = existing?.body
    ? [existing.body]
    : [
        "Nothing in this repo mechanically describes what goes wrong at runtime, so this page starts empty on purpose.",
        "",
        `Add an entry every time someone hits a problem with ${name} that took more than a minute to figure out. The useful shape is: the symptom a user sees, what actually causes it, and the fix.`,
        "",
        "## Example shape",
        "",
        "### `command not found` after installing",
        "",
        "**Symptom.** The install succeeds but the command isn't on PATH.",
        "",
        "**Cause.** Global npm binaries aren't in the shell's PATH.",
        "",
        "**Fix.** The exact command to run.",
      ];

  return [
    {
      section: "troubleshooting",
      slug: "index",
      frontmatter: {
        title: "Troubleshooting",
        description: `What goes wrong with ${name}, and how to fix it.`,
        section: "troubleshooting",
        order: 1,
        sources: ["README.md"],
        last_synced: sha,
        locale: "en",
      },
      body: lines.join("\n"),
    },
  ];
}

function draftStartHere(
  targetDir: string,
  tree: ScannedDir,
  pkg: PackageJson | null,
  sha: string,
  preset: WikiPreset,
): DraftedPage[] {
  const lines: string[] = [];
  const name = pkg?.name ?? tree.name;
  lines.push(`## What this is`, "");
  if (pkg?.description) {
    lines.push(pkg.description, "");
  } else if (tree.readme) {
    const summary = firstParagraph(tree.readme);
    if (summary) lines.push(summary, "");
  } else {
    lines.push(`\`${name}\` — no root README or package description found yet to draft from.`, "");
  }

  // A user-guide wiki opens with what the thing does for its reader. Repo layout
  // and npm scripts are for people working *on* the code, not people using it.
  if (preset === "user-guide") {
    lines.push(
      "## Who this is for",
      "",
      `Say who reads this wiki and what they're trying to accomplish with ${name}. Then point them at [Installation](../../getting-started/installation/) and the [Guides](../../guides/) for the task they came here to do.`,
      "",
    );
  } else {
    lines.push("## Top-level layout", "");
    for (const sub of tree.subdirs) {
      const fileCount = sub.files.length;
      lines.push(`- \`${sub.name}/\` — ${fileCount} file${fileCount === 1 ? "" : "s"}`);
    }
    if (tree.files.length) {
      lines.push(`- ${tree.files.length} file(s) at the repo root`);
    }
    lines.push("");

    if (pkg?.scripts && Object.keys(pkg.scripts).length) {
      lines.push("## Getting started", "");
      for (const [name, cmd] of Object.entries(pkg.scripts)) {
        lines.push(`- \`npm run ${name}\` — \`${cmd}\``);
      }
      lines.push("");
    }
  }

  return [
    {
      section: "start-here",
      slug: "overview",
      frontmatter: {
        title: "Overview",
        description: `What ${name} is and how the repo is laid out.`,
        section: "start-here",
        order: 1,
        sources: ["package.json", "README.md"],
        last_synced: sha,
        locale: "en",
      },
      body: lines.join("\n"),
    },
  ];
}

function draftTechnologies(pkg: PackageJson | null, sha: string): DraftedPage[] {
  if (!pkg) return [];
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const names = Object.keys(deps).sort();

  const indexLines: string[] = ["Technologies detected in `package.json`.", ""];
  for (const dep of names) {
    indexLines.push(`- [${dep}](./${dep.replace(/[\\/]/g, "-")}/)`);
  }

  const pages: DraftedPage[] = [
    {
      section: "technologies",
      slug: "index",
      frontmatter: {
        title: "Technologies",
        description: "One page per dependency used by this project.",
        section: "technologies",
        order: 1,
        sources: ["package.json"],
        last_synced: sha,
        locale: "en",
      },
      body: indexLines.join("\n"),
    },
  ];

  for (const dep of names) {
    const description = KNOWN_TECH_DESCRIPTIONS[dep] ?? "A dependency used by this project (see `package.json`).";
    pages.push({
      section: "technologies",
      slug: dep,
      frontmatter: {
        title: dep,
        description,
        section: "technologies",
        sources: ["package.json"],
        last_synced: sha,
        locale: "en",
      },
      body: [description, "", `Version: \`${deps[dep]}\``].join("\n"),
    });
  }

  return pages;
}

function draftReference(tree: ScannedDir, sha: string): DraftedPage[] {
  const extStats = collectExtensionStats(tree);
  const lines: string[] = ["## File type summary", ""];
  for (const [ext, count] of [...extStats.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${ext}: ${count}`);
  }
  lines.push("", "## Directory map", "");
  const renderDir = (dir: ScannedDir, depth: number) => {
    if (depth > 2) return;
    const indent = "  ".repeat(depth);
    lines.push(`${indent}- \`${dir.name}/\``);
    for (const sub of dir.subdirs) renderDir(sub, depth + 1);
  };
  for (const sub of tree.subdirs) renderDir(sub, 0);

  return [
    {
      section: "reference",
      slug: "file-map",
      frontmatter: {
        title: "File map",
        description: "Directory structure and file-type breakdown.",
        section: "reference",
        order: 1,
        sources: ["**/*"],
        last_synced: sha,
        locale: "en",
      },
      body: lines.join("\n"),
    },
  ];
}

function draftHowItWorks(pkg: PackageJson | null, sha: string): DraftedPage[] {
  const lines: string[] = ["## Entry points", ""];
  if (pkg?.main) lines.push(`- Library entry: \`${pkg.main}\``);
  if (pkg?.bin) {
    if (typeof pkg.bin === "string") {
      lines.push(`- CLI entry: \`${pkg.bin}\``);
    } else {
      for (const [name, path] of Object.entries(pkg.bin)) {
        lines.push(`- CLI entry (\`${name}\`): \`${path}\``);
      }
    }
  }
  if (lines.length === 2) {
    lines.push("- No `main`/`bin` fields found in `package.json` yet.");
  }
  lines.push("", "Fill this page in with the real request/data flow as you learn it — this page only drafts what's mechanically detectable from `package.json`.");

  return [
    {
      section: "how-it-works",
      slug: "entry-points",
      frontmatter: {
        title: "Entry points",
        description: "Where execution starts, detected from package.json.",
        section: "how-it-works",
        order: 1,
        sources: ["package.json"],
        last_synced: sha,
        locale: "en",
      },
      body: lines.join("\n"),
    },
  ];
}

function draftCookbook(pkg: PackageJson | null, sha: string): DraftedPage[] {
  const lines: string[] = ["Common tasks, derived from `package.json` scripts.", ""];
  if (pkg?.scripts && Object.keys(pkg.scripts).length) {
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      lines.push(`### ${name}`, "", `\`\`\`bash\nnpm run ${name}\n\`\`\``, "", `Runs: \`${cmd}\``, "");
    }
  } else {
    lines.push("No `package.json` scripts found yet — add recipes here as your team learns them.");
  }

  return [
    {
      section: "cookbook",
      slug: "common-tasks",
      frontmatter: {
        title: "Common tasks",
        description: "Recipes for everyday tasks in this repo.",
        section: "cookbook",
        order: 1,
        sources: ["package.json"],
        last_synced: sha,
        locale: "en",
      },
      body: lines.join("\n"),
    },
  ];
}

export function draftContent(targetDir: string, preset: WikiPreset = DEFAULT_PRESET): DraftedPage[] {
  const tree = scanDirectory(targetDir);
  const pkg = readPackageJson(targetDir);
  const sha = getGitSha(targetDir);

  const drafted = [
    ...draftStartHere(targetDir, tree, pkg, sha, preset),
    ...draftGettingStarted(tree, pkg, sha),
    ...draftGuides(tree, pkg, sha),
    ...draftTechnologies(pkg, sha),
    ...draftHowItWorks(pkg, sha),
    ...draftCookbook(pkg, sha),
    ...draftFaq(tree, pkg, sha),
    ...draftTroubleshooting(tree, pkg, sha),
    ...draftReference(tree, sha),
  ];

  const wanted = new Set(sectionsForPreset(preset));

  // Stamped in one place rather than by each drafter: a commit SHA says when a
  // page was verified, but a release version says *against what* — which is the
  // number a reader recognises. Done here so a new drafter can't forget it.
  return drafted
    .filter((page) => wanted.has(page.section))
    .map((page) =>
      pkg?.version ? { ...page, frontmatter: { ...page.frontmatter, version: pkg.version } } : page,
    );
}
