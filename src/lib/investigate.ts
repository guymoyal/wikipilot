import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, existsSync, realpathSync, unlinkSync } from "node:fs";
import { join, resolve, relative, sep, isAbsolute } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { type WikipilotConfig } from "./config.js";
import { DEFAULT_IGNORE } from "./scan.js";
import { getGitSha } from "./draft.js";
import { SECTION_BRIEFS } from "./skill.js";
import { renderPage, type PageFrontmatter } from "./frontmatter.js";
import { PROVIDERS, createOpenAICompatMessage, type ProviderId } from "./providers.js";

export const DEFAULT_INIT_MODEL = "claude-sonnet-5";

/** Injected so tests can script the model without a network or a mocking library. */
export type CreateMessage = (req: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;

export interface InvestigateOptions {
  targetDir: string;
  wikiDir: string;
  config: WikipilotConfig;
  model?: string;
  apiKey?: string;
  /** Which provider to talk to. Absent or "anthropic" uses the Anthropic SDK directly. */
  provider?: ProviderId;
  /** OpenAI-compatible base URL, required for "custom" when not otherwise known. */
  baseUrl?: string;
  /** Progress lines. The lib never touches the console; the CLI passes console.log. */
  report?: (line: string) => void;
  createMessage?: CreateMessage;
  maxTurns?: number;
  maxReadBytes?: number;
}

export interface InvestigateResult {
  pagesWritten: number;
  /** Mechanical draft pages superseded by the investigation and removed. */
  pagesRemoved: number;
  turns: number;
  summary: string;
  stopped: "finished" | "max_turns";
  usage: InvestigateUsage;
}

export interface InvestigateUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Rough cost at claude-sonnet-5 list prices ($3/M input, $15/M output, cache
 * reads ~0.1x, cache writes ~1.25x). Other models differ — this is a readout so
 * a run's spend is visible, not a bill.
 */
export function estimateCostUsd(usage: InvestigateUsage): number {
  return (
    (usage.inputTokens / 1e6) * 3 +
    (usage.outputTokens / 1e6) * 15 +
    (usage.cacheReadTokens / 1e6) * 0.3 +
    (usage.cacheWriteTokens / 1e6) * 3.75
  );
}

const MAX_FILE_BYTES = 64 * 1024;
const MAX_GREP_MATCHES = 50;
const EMOJI = /\p{Extended_Pictographic}/u;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "list_dir",
    description:
      "List one directory level of the repository: entry name, whether it is a directory, and file size in bytes. Ignored directories (node_modules, .git, build output, dotfiles) are omitted.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: 'Directory path relative to the repo root (default ".")' } },
    },
  },
  {
    name: "read_file",
    description:
      "Read a file from the repository, returned with line numbers. Reads are capped per file and by a total budget — read selectively, never re-read a file you have already seen.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "File path relative to the repo root" } },
      required: ["path"],
    },
  },
  {
    name: "grep",
    description:
      "Search file contents with a JavaScript regular expression. Returns up to 50 matches as path:line: text. Use it to find where something is defined or used before reading whole files.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regex source, applied per line" },
        path: { type: "string", description: 'Directory to search, relative to the repo root (default ".")' },
        glob: { type: "string", description: 'Filename filter like "*.ts" (optional)' },
      },
      required: ["pattern"],
    },
  },
  {
    name: "write_page",
    description:
      "Write one wiki page. This replaces any existing page at the same section/slug — reusing the drafted slugs keeps their URLs. The body is markdown (mermaid fences allowed, raw HTML is not). This is the only way to produce pages; never emit page content as plain text.",
    input_schema: {
      type: "object",
      properties: {
        section: { type: "string", description: "One of this wiki's configured sections" },
        slug: { type: "string", description: "URL slug, lowercase words joined by dashes" },
        title: { type: "string" },
        description: { type: "string", description: "One line; it is the search preview and sidebar blurb" },
        order: { type: "number", description: "Sidebar position within the section (optional)" },
        sources: {
          type: "array",
          items: { type: "string" },
          description: "Narrowest repo globs that cover what this page documents — the drift contract",
        },
        body: { type: "string", description: "Page body markdown, without the frontmatter block" },
      },
      required: ["section", "slug", "title", "sources", "body"],
    },
  },
  {
    name: "finish",
    description: "Call once, when the wiki is complete, with a short summary of what you wrote and what you verified.",
    input_schema: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    },
  },
];

/**
 * Resolves a model-supplied path and confines it to the repo root. Returns null
 * for anything that escapes — `..`, absolute paths elsewhere, or symlinks out.
 */
function resolveInsideRoot(root: string, requested: string): string | null {
  const rootReal = realpathSync(root);
  const candidate = isAbsolute(requested) ? requested : resolve(rootReal, requested);
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return null;
  }
  if (real !== rootReal && !real.startsWith(rootReal + sep)) return null;
  return real;
}

function isIgnoredName(name: string): boolean {
  return DEFAULT_IGNORE.has(name) || name.startsWith(".");
}

/** Lockfiles and build artifacts burn the read budget without teaching anything. */
const GENERATED_FILE = /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|composer\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock|go\.sum)$|\.(min\.js|min\.css|map|lock)$/;

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function sectionGuidance(sections: string[]): string {
  return sections
    .filter((section) => SECTION_BRIEFS[section])
    .map((section) => `- \`${section}/\` — ${SECTION_BRIEFS[section]}`)
    .join("\n");
}

/**
 * The pages a professional wiki cannot ship without, filtered to the sections
 * this wiki actually has. Kept out of SECTION_BRIEFS because these are
 * init-time demands on specific pages, not descriptions of whole sections.
 */
function requiredPagesGuidance(sections: string[]): string {
  const bars: Array<[section: string, bar: string]> = [
    [
      "start-here",
      "`start-here/overview` — opens with the product narrative: what the product does, who uses it, and its 2-4 main use cases, before any repo detail. Ends with a map of where each kind of reader goes next. Never a directory listing.",
    ],
    [
      "how-it-works",
      "one `how-it-works` page carries an end-to-end user-flow diagram: the user's journey as a mermaid flowchart or sequenceDiagram (user action, system steps, visible result), distinct from the internal architecture diagram. Both derived from code you traced.",
    ],
    [
      "onboarding",
      "`onboarding/index` — a new developer's day one: environment setup with commands verified against the repo's scripts, a repo tour explaining where things live and why, a \"your first change\" walkthrough pointing at a real low-risk location, and how to run the tests.",
    ],
    [
      "technologies",
      "every technologies page states why this technology serves this project — verified from code or config, or explicitly marked as an open question — plus a snippet copied from this repo showing characteristic use, linking the files that import it.",
    ],
  ];
  return bars
    .filter(([section]) => sections.includes(section))
    .map(([, bar]) => `- ${bar}`)
    .join("\n");
}

/**
 * The methodology here mirrors docs/wiki-init-skills.md (the human/skill-facing
 * spec); keep the two in sync when either changes.
 */
export function buildSystemPrompt(config: WikipilotConfig, facts: { sha: string; locale: string }): string {
  return `You are wikipilot's deep-investigation agent. A mechanical first draft of a documentation wiki already exists; your job is to replace it with documentation investigated from the code. Every sentence you write must be traceable to file contents you have read through your tools in this session.

## Tools contract

- Explore with list_dir, read_file, and grep. Reads are budgeted: read selectively, never re-read a file, skip lockfiles and generated bundles, and when a tool result warns that the budget is exhausted, stop exploring and write from what you have.
- Batch independent tool calls into a single turn — request several reads at once instead of one per turn. Fewer turns means a faster, cheaper run.
- Pages are produced ONLY through write_page. Writing to an existing section/slug replaces the draft page (keep the drafted slugs to keep their URLs). Never print page content as plain text.
- When you call finish, every draft page you did NOT rewrite is deleted — the wiki becomes exactly the set of pages you wrote. If a drafted page covers something worth keeping, rewrite it properly; otherwise let it go.
- When the wiki is complete, call finish with a short summary. Do not stop before calling finish.

## Phase 1 — Investigate before writing anything

Work through these in order; keep going until you can sketch the architecture from memory:

1. Entry points: the package manifest (bin, main, exports, scripts), Dockerfiles, CI workflows. These say what the project IS before any README claim does.
2. The product surface: UI routes or screens, CLI commands, API endpoints, exported entry points. From these, answer: who uses this, what problem it solves for them, and the user's journey — the sequence of user-visible steps from first contact to the core result. For a library or CLI the journey is the primary usage path; never invent a funnel the code does not show.
3. The primary flow, end to end: pick the thing a user most obviously does and read the code path from entry to result. This trace becomes the backbone of how-it-works and its diagrams.
4. The tests: they state intended behaviour more honestly than comments. Harvest named guarantees.
5. Configuration surface: env vars, config files, CLI flags, defaults.
6. Data model: schemas, migrations, type definitions.
7. Dependencies, with receipts: for each direct dependency, find the files that import it and what it is used for in THIS repo. A paraphrase of the dependency's own README is not a finding.
8. Boundaries and non-goals: what the project deliberately does not do.

If the investigation comes up nearly empty (a scaffold with no source), that is itself the finding: write the few pages the evidence supports, say plainly what does not exist yet, and skip the rest. Never manufacture content to make an empty repo look documented.

## Phase 2 — Plan the page map

Decide what pages this repo actually needs. The drafted stubs are suggestions: rewrite them in place when the topic is right, replace them when it is not. A section's index slug is its landing page. For a mid-sized repo, 10-20 substantial pages is a reasonable shape — but the evidence sets the number. Skip a section rather than pad it: three real FAQ entries beat ten invented ones.

Required pages — this wiki is rejected without them:

${requiredPagesGuidance(config.sections)}

## Phase 3 — Authoring rules

Write each page to its section's brief:

${sectionGuidance(config.sections)}

- Lead with what the thing does and why it exists, then how it works. Concrete names, real paths, real commands.
- Code snippets are COPIED from files you have read, never composed from memory. Caption every fence with the source path: \`\`\`ts title="src/lib/example.ts". Trim to the lines that matter, mark elisions with // …, never edit the lines you keep.
- Mermaid renders natively. Use flowchart for component/request paths, sequenceDiagram for multi-actor flows, erDiagram for data models, stateDiagram-v2 for lifecycles. Every node and edge must come from code you read — an invented arrow is a lie with a diagram's authority. Name nodes after real modules, label edges with what actually crosses them, keep diagrams under ~12 nodes, and put one sentence before each saying what to look at.
- The renderer is markdown-it with raw HTML disabled: no <div>/<img>/<br> in page bodies (inside a mermaid fence, <br/> is fine). Pages are served at /<section>/<slug>/ — cross-section links go up two levels (../../guides/refunds/), same-section links one (../refunds/).
- frontmatter sources are the drift contract: the narrowest repo globs that truly cover the page. Never use **/*. Give every page a one-line description that says something specific.
- NO EMOJI anywhere — not in titles, headings, descriptions, or body text. The site ships its own iconography.

## Anti-patterns (each one is a rejected page)

- A dependency page that paraphrases the package's own README instead of citing the files here that import it.
- A diagram that mirrors the folder tree instead of behaviour.
- "Robust, flexible, powerful" filler — state the concrete fact or delete the sentence.
- FAQ or troubleshooting entries invented to fill space.
- A "why" stated with confidence that the code does not support — mark it as an open question instead.

## Before you call finish

Walk this checklist page by page; a failed item means fix it, then finish:

- Every required page above exists and meets its stated bar.
- No mechanical-draft placeholder text survives anywhere.
- Cross-section links use the ../../<section>/<slug>/ form; same-section links use ../<slug>/.
- Every diagram has one intro sentence and at most ~12 nodes.
- Every page's sources are the narrowest globs that truly cover it.

## This wiki

- Site: ${config.siteName ?? "Wiki"}${config.version ? ` (version ${config.version})` : ""}
- Preset: ${config.preset}; sections: ${config.sections.join(", ")}
- Locale: ${facts.locale}; git commit: ${facts.sha}
- write_page stamps last_synced and version for you — focus on the content.`;
}

interface ToolOutcome {
  content: string;
  isError?: boolean;
}

export async function investigate(options: InvestigateOptions): Promise<InvestigateResult> {
  const { targetDir, wikiDir, config } = options;
  const provider = options.provider ?? "anthropic";
  // WIKI_INIT_MODEL is documented next to the provider keys in .env.example
  // and typically holds a Claude model id — only the anthropic provider
  // should ever see it, or a Claude model name gets sent to another
  // provider's API.
  const envModel = provider === "anthropic" ? process.env.WIKI_INIT_MODEL : undefined;
  const model = options.model ?? envModel ?? PROVIDERS[provider].defaultModel ?? DEFAULT_INIT_MODEL;
  const report = options.report ?? (() => {});
  const maxTurns = options.maxTurns ?? 150;
  // The read budget caps spend AND keeps the conversation inside the model's
  // context window, however large the repo is. Haiku's window is much smaller
  // than Sonnet's, so its budget is too.
  let readBudget = options.maxReadBytes ?? (model.includes("haiku") ? 512 * 1024 : 2 * 1024 * 1024);

  const locale = config.locales[0] ?? "en";
  const sha = getGitSha(targetDir);
  const system = buildSystemPrompt(config, { sha, locale });

  const createMessage: CreateMessage =
    options.createMessage ??
    (() => {
      if (provider === "anthropic") {
        const client = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
        return (req) => client.messages.create(req);
      }
      const baseUrl = options.baseUrl ?? PROVIDERS[provider].baseUrl;
      if (!baseUrl) throw new Error("custom provider needs a base URL (--base-url)");
      if (!options.apiKey) throw new Error(`no API key for provider ${provider}`);
      return createOpenAICompatMessage({ baseUrl, apiKey: options.apiKey });
    })();

  let pagesWritten = 0;
  let summary = "";
  let finished = false;
  const usage: InvestigateUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  // Pages that existed before the run — the mechanical draft, or a previous
  // run's output. Whatever the investigation doesn't rewrite is superseded and
  // gets removed on a successful finish, so thin draft stubs never linger next
  // to the investigated pages.
  const contentRoot = join(wikiDir, "content", locale);
  const preExisting = new Set<string>();
  const writtenPaths = new Set<string>();
  if (existsSync(contentRoot)) {
    for (const section of readdirSync(contentRoot)) {
      const sectionDir = join(contentRoot, section);
      if (!statSync(sectionDir).isDirectory()) continue;
      for (const file of readdirSync(sectionDir)) {
        if (file.endsWith(".md")) preExisting.add(join(sectionDir, file));
      }
    }
  }

  function chargeBudget(text: string): string {
    readBudget -= Buffer.byteLength(text, "utf8");
    if (readBudget < 0) {
      return `${text}\n\n[read budget exhausted — no further reads will succeed; write the wiki from what you have read]`;
    }
    return text;
  }

  function runListDir(input: { path?: string }): ToolOutcome {
    const requested = input.path ?? ".";
    const real = resolveInsideRoot(targetDir, requested);
    if (!real) return { content: `path escapes the repository root: ${requested}`, isError: true };
    let entries: string[];
    try {
      entries = readdirSync(real);
    } catch (err) {
      return { content: `cannot list ${requested}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
    const lines = entries
      .filter((name) => !isIgnoredName(name))
      .sort()
      .map((name) => {
        try {
          const stat = statSync(join(real, name));
          return stat.isDirectory() ? `${name}/` : `${name} (${stat.size} B)`;
        } catch {
          return name;
        }
      });
    report(`list ${requested}`);
    return { content: lines.join("\n") || "(empty)" };
  }

  const alreadyRead = new Set<string>();

  function runReadFile(input: { path: string }): ToolOutcome {
    if (readBudget <= 0) {
      return { content: "read budget exhausted — write the wiki from what you have already read", isError: true };
    }
    const real = resolveInsideRoot(targetDir, input.path);
    if (!real) return { content: `path escapes the repository root: ${input.path}`, isError: true };
    if (alreadyRead.has(real)) {
      return { content: `already read ${input.path} this session — its content is in your context; use what you have`, isError: true };
    }
    if (GENERATED_FILE.test(real.split(sep).pop() ?? "")) {
      return { content: `${input.path} is a lockfile or generated artifact — not worth the read budget`, isError: true };
    }
    let buffer: Buffer;
    try {
      buffer = readFileSync(real);
    } catch (err) {
      return { content: `cannot read ${input.path}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
    if (looksBinary(buffer)) return { content: `${input.path} is a binary file`, isError: true };
    alreadyRead.add(real);
    const truncated = buffer.length > MAX_FILE_BYTES;
    const text = buffer.subarray(0, MAX_FILE_BYTES).toString("utf8");
    const numbered = text
      .split("\n")
      .map((line, i) => `${i + 1}\t${line}`)
      .join("\n");
    report(`read ${relative(targetDir, real)} (${formatBytes(buffer.length)})`);
    return { content: chargeBudget(truncated ? `${numbered}\n[truncated at 64 KB]` : numbered) };
  }

  function runGrep(input: { pattern: string; path?: string; glob?: string }): ToolOutcome {
    if (readBudget <= 0) {
      return { content: "read budget exhausted — write the wiki from what you have already read", isError: true };
    }
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern);
    } catch (err) {
      return { content: `invalid regular expression: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
    const root = resolveInsideRoot(targetDir, input.path ?? ".");
    if (!root) return { content: `path escapes the repository root: ${input.path}`, isError: true };
    const nameFilter = input.glob ? globToRegex(input.glob) : null;

    const matches: string[] = [];
    const walk = (dir: string): void => {
      if (matches.length >= MAX_GREP_MATCHES) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (matches.length >= MAX_GREP_MATCHES) return;
        if (isIgnoredName(name)) continue;
        const full = join(dir, name);
        let stat;
        try {
          stat = statSync(full);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          walk(full);
        } else if (stat.isFile() && stat.size <= 512 * 1024 && !GENERATED_FILE.test(name) && (!nameFilter || nameFilter.test(name))) {
          let buffer: Buffer;
          try {
            buffer = readFileSync(full);
          } catch {
            continue;
          }
          if (looksBinary(buffer)) continue;
          const rel = relative(targetDir, full);
          const lines = buffer.toString("utf8").split("\n");
          for (let i = 0; i < lines.length && matches.length < MAX_GREP_MATCHES; i++) {
            if (regex.test(lines[i])) matches.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
          }
        }
      }
    };
    walk(root);
    report(`grep /${input.pattern}/ (${matches.length} match${matches.length === 1 ? "" : "es"})`);
    if (matches.length === 0) return { content: "no matches" };
    return { content: chargeBudget(matches.join("\n")) };
  }

  function runWritePage(input: {
    section: string;
    slug: string;
    title: string;
    description?: string;
    order?: number;
    sources: string[];
    body: string;
  }): ToolOutcome {
    if (!config.sections.includes(input.section)) {
      return {
        content: `unknown section "${input.section}" — this wiki's sections are: ${config.sections.join(", ")}`,
        isError: true,
      };
    }
    const headings = input.body.split("\n").filter((line) => line.startsWith("#"));
    if (EMOJI.test(input.title) || EMOJI.test(input.description ?? "") || headings.some((h) => EMOJI.test(h))) {
      return {
        content: "no emoji in titles, headings, or descriptions — rewrite this page without them",
        isError: true,
      };
    }
    if (!Array.isArray(input.sources) || input.sources.length === 0) {
      return { content: "sources must list at least one repo glob this page documents", isError: true };
    }

    const slug = input.slug.replace(/[\\/]/g, "-");
    const frontmatter: PageFrontmatter = {
      title: input.title,
      section: input.section,
      sources: input.sources,
      last_synced: sha,
      locale,
      ...(input.description ? { description: input.description } : {}),
      ...(typeof input.order === "number" ? { order: input.order } : {}),
      ...(config.version ? { version: config.version } : {}),
    };
    const dir = join(wikiDir, "content", locale, input.section);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${slug}.md`);
    const replaced = existsSync(path);
    writeFileSync(path, renderPage(frontmatter, input.body), "utf8");
    writtenPaths.add(path);
    pagesWritten++;
    report(`${replaced ? "rewrote" : "wrote"} ${input.section}/${slug}`);
    return { content: JSON.stringify({ ok: true, path: `content/${locale}/${input.section}/${slug}.md` }) };
  }

  function runTool(name: string, input: unknown): ToolOutcome {
    try {
      switch (name) {
        case "list_dir":
          return runListDir(input as { path?: string });
        case "read_file":
          return runReadFile(input as { path: string });
        case "grep":
          return runGrep(input as { pattern: string; path?: string; glob?: string });
        case "write_page":
          return runWritePage(input as Parameters<typeof runWritePage>[0]);
        default:
          return { content: `unknown tool: ${name}`, isError: true };
      }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  }

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Begin. Investigate the repository with your tools, plan the page map, then write the wiki and call finish.",
        },
      ],
    },
  ];

  /**
   * The whole history is resent every turn — without caching that re-bills it
   * at full price each time. Marking the newest message caches the prefix, so
   * later turns re-read it at ~10% of the input rate. The mark is added on a
   * shallow copy at send time; stored history stays unmarked.
   */
  function withCacheMark(history: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
    const last = history[history.length - 1];
    if (!Array.isArray(last.content) || last.content.length === 0) return history;
    const blocks = last.content.slice();
    const tail = blocks[blocks.length - 1];
    if (typeof tail !== "object" || tail.type === "thinking" || tail.type === "redacted_thinking") return history;
    blocks[blocks.length - 1] = { ...tail, cache_control: { type: "ephemeral" } } as typeof tail;
    return [...history.slice(0, -1), { role: last.role, content: blocks }];
  }

  report(
    `deep investigation with ${model}${provider === "anthropic" ? "" : ` via ${provider}`} — this reads your code and can take several minutes`,
  );

  let turns = 0;
  while (turns < maxTurns) {
    turns++;
    const response = await createMessage({
      model,
      max_tokens: 16000,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools: TOOLS,
      messages: withCacheMark(messages),
    });

    if (response.usage) {
      usage.inputTokens += response.usage.input_tokens ?? 0;
      usage.outputTokens += response.usage.output_tokens ?? 0;
      usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
      usage.cacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0;
    }

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      // The model ended its turn without finish — accept its text as the summary.
      summary = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      finished = true;
      break;
    }

    messages.push({ role: "assistant", content: response.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      if (use.name === "finish") {
        summary = String((use.input as { summary?: string }).summary ?? "");
        finished = true;
        results.push({ type: "tool_result", tool_use_id: use.id, content: "done" });
        continue;
      }
      const outcome = runTool(use.name, use.input);
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: outcome.content,
        ...(outcome.isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "user", content: results });

    if (finished) break;
  }

  let pagesRemoved = 0;
  if (finished && pagesWritten > 0) {
    for (const path of preExisting) {
      if (writtenPaths.has(path)) continue;
      try {
        unlinkSync(path);
        pagesRemoved++;
      } catch {
        // A page that can't be removed just stays — not worth failing the run.
      }
    }
    if (pagesRemoved > 0) report(`removed ${pagesRemoved} superseded draft page(s)`);
  }

  const totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  report(`investigation ${finished ? "complete" : "stopped at the turn limit"} — ${pagesWritten} page(s) written over ${turns} turn(s)`);
  if (totalTokens > 0) {
    const costNote = model.startsWith(DEFAULT_INIT_MODEL)
      ? ` — about $${estimateCostUsd(usage).toFixed(2)} at ${DEFAULT_INIT_MODEL} list prices`
      : "";
    report(`tokens: ${Math.round(totalTokens / 1000)}k total (${Math.round(usage.cacheReadTokens / 1000)}k cached reads)${costNote}`);
  }
  return { pagesWritten, pagesRemoved, turns, summary, stopped: finished ? "finished" : "max_turns", usage };
}
