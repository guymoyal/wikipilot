#!/usr/bin/env node
import { Command } from "commander";
import { relative, resolve } from "node:path";
import { generateWiki } from "../lib/generateWiki.js";
import { init } from "../lib/init.js";
import { buildSite } from "../lib/site/build.js";
import { serveSite } from "../lib/site/serve.js";
import { startAgentServer } from "../lib/site/agentServer.js";
import { DEFAULT_PRESET, PRESETS, readConfig } from "../lib/config.js";
import { resolvePreset, resolveAiPlan, type PresetOptions, type AiOptions, type PromptIO } from "../lib/wizard.js";
import { PROVIDERS } from "../lib/providers.js";
import { loadDotEnv, saveEnvKey } from "../lib/env.js";
import { investigate, DEFAULT_INIT_MODEL } from "../lib/investigate.js";
import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8"));

const SECRET_QUESTION = /api key/i;

/**
 * Runs `fn` with a PromptIO. Only opens stdin when prompts can actually happen —
 * a non-TTY run resolves without ever creating a readline interface. Questions
 * that ask for an API key are masked: the typed characters are swallowed so the
 * key never lands in the terminal or its scrollback.
 */
async function withPromptIO<T>(interactive: boolean, fn: (io: PromptIO) => Promise<T>): Promise<T> {
  if (!interactive) {
    return fn({ interactive: false, ask: async () => "", print: () => {} });
  }

  const { createInterface } = await import("node:readline/promises");
  let muted = false;
  const maskable = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding as BufferEncoding);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output: maskable, terminal: true });
  try {
    return await fn({
      interactive: true,
      // Ctrl+D closes stdin and rejects the pending question. Treat that as
      // "cancel", not as a crash.
      ask: async (question) => {
        const secret = SECRET_QUESTION.test(question);
        try {
          if (!secret) return await rl.question(question);
          process.stdout.write(question);
          muted = true;
          const answer = await rl.question("");
          muted = false;
          process.stdout.write("\n");
          return answer;
        } catch {
          muted = false;
          throw new Error("cancelled — re-run with --preset or --no-ai to skip the prompts.");
        }
      },
      print: (line) => console.log(line),
    });
  } finally {
    rl.close();
  }
}

/** Absolute paths in terminal output are noise — show them relative to cwd. */
function short(target: string): string {
  const rel = relative(process.cwd(), target);
  if (!rel) return ".";
  return rel.startsWith("..") ? target : `./${rel}`;
}

function nextSteps(lines: string[]): void {
  console.log("\nNext:");
  for (const line of lines) console.log(`  ${line}`);
}

const program = new Command();

program
  .name("wikipilot")
  .description("Scan a codebase and generate a browsable Markdown wiki")
  .version(pkg.version);

program
  .command("generate")
  .description("Generate wiki pages from a source directory")
  .argument("[source]", "directory to scan", ".")
  .option("-o, --out <dir>", "output directory for generated wiki", "./wiki")
  .option("-d, --max-depth <n>", "maximum directory depth to scan", (v) => parseInt(v, 10))
  .option("--ignore <dirs...>", "additional directory names to ignore")
  .action((source: string, opts: { out: string; maxDepth?: number; ignore?: string[] }) => {
    const sourceDir = resolve(process.cwd(), source);
    const outputDir = resolve(process.cwd(), opts.out);

    const result = generateWiki({
      sourceDir,
      outputDir,
      maxDepth: opts.maxDepth,
      ignore: opts.ignore,
    });

    console.log(`wikipilot: wrote ${result.pagesWritten} page(s) to ${outputDir}`);
  });

program
  .command("init")
  .description("Scaffold a wiki into a repo, drafted from real repo content")
  .argument("[target]", "repo to scan and draft content from", ".")
  .option("-o, --out <dir>", "directory to scaffold the wiki into", "./wiki")
  .option("--preset <type>", `wiki type to draft: ${PRESETS.join(" | ")} (skips the prompt)`)
  .option("--site-name <name>", "name shown in the built site's header (defaults to the project name)")
  .option("-y, --yes", `skip the prompts: "${DEFAULT_PRESET}" preset, no AI pass unless --ai is given`)
  .option("--no-skill", "skip scaffolding the .claude/skills/update-wiki sync skill")
  .option("--ai", "run the AI deep-investigation pass (needs an API key — Anthropic by default)")
  .option("--no-ai", "skip the AI pass and the prompt for it")
  .option("--model <name>", `model for the AI pass (default ${DEFAULT_INIT_MODEL}, or WIKI_INIT_MODEL on the Claude provider)`)
  .option("--provider <name>", "AI provider for the investigation: anthropic | openai | gemini | custom (default anthropic)")
  .option("--base-url <url>", "OpenAI-compatible endpoint for --provider custom")
  .action(async (target: string, opts: { out: string; preset?: string; siteName?: string; yes?: boolean; skill: boolean; ai?: boolean; model?: string; provider?: string; baseUrl?: string }) => {
    const targetDir = resolve(process.cwd(), target);
    const wikiDir = resolve(process.cwd(), opts.out);

    try {
      const interactive = Boolean(process.stdin.isTTY) && !opts.yes;
      const { result, plan } = await withPromptIO(interactive, async (io) => {
        const preset = await resolvePreset(opts as PresetOptions, io);
        const result = init({ targetDir, wikiDir, preset, siteName: opts.siteName, skipSkill: !opts.skill });

        console.log(`\nwikipilot: drafted ${result.pagesWritten} page(s) into ${short(result.wikiDir)} — "${result.siteName}"`);
        console.log(`           preset "${result.preset}": ${result.sections.join(", ")}`);
        if (result.skillPath) {
          console.log(`           added ${short(result.skillPath)} so Claude Code can keep it in sync`);
        }

        loadDotEnv(targetDir);
        const plan = await resolveAiPlan(opts as AiOptions, io, process.env);
        return { result, plan };
      });

      if (plan.saveKey && plan.apiKey) {
        saveEnvKey(targetDir, PROVIDERS[plan.provider].envVar, plan.apiKey);
        console.log(`           saved the key to ${short(join(targetDir, ".env"))} (gitignored)`);
      }

      if (plan.enabled && plan.apiKey) {
        try {
          const config = readConfig(wikiDir);
          const ai = await investigate({
            targetDir,
            wikiDir,
            config,
            model: opts.model ?? plan.model,
            provider: plan.provider,
            baseUrl: opts.baseUrl ?? plan.baseUrl,
            apiKey: plan.apiKey,
            report: (line) => console.log(`  ${line}`),
          });
          console.log(`\nwikipilot: deep investigation rewrote ${ai.pagesWritten} page(s)`);
        } catch (err) {
          // The mechanical draft is already on disk — an API failure downgrades
          // the run, it doesn't fail it.
          console.error(`wikipilot: AI pass failed (${(err as Error).message}) — the drafted wiki is intact.`);
        }
      } else if (opts.ai === true && !plan.enabled) {
        if (plan.disabledReason === "custom-incomplete") {
          console.log("wikipilot: --ai requested but --provider custom needs both --base-url and --model — wrote the mechanical draft only.");
        } else {
          console.log(`wikipilot: --ai requested but no ${PROVIDERS[plan.provider].envVar} found — wrote the mechanical draft only.`);
        }
      }

      const outFlag = opts.out === "./wiki" ? "" : ` ${short(result.wikiDir)}`;
      nextSteps([
        `wikipilot build${outFlag}`.padEnd(28) + "# render it into a static site",
        "wikipilot serve".padEnd(28) + "# preview at http://localhost:4400",
      ]);
    } catch (err) {
      console.error(`wikipilot: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command("build")
  .description("Build the wiki content into a static HTML site (no server required)")
  .argument("[wikiDir]", "wiki directory to build from", "./wiki")
  .option("-o, --out <dir>", "output directory for the built site", "./wiki-dist")
  .option("--site-name <name>", "site name shown in the header (defaults to the name init derived)")
  .option("--agent-port <n>", "local dev: point the chat widget at an agent server on this port", (v) => parseInt(v, 10))
  .option("--agent-url <url>", "hosting: absolute URL of the agent API the chat widget should call")
  .action((wikiDirArg: string, opts: { out: string; siteName?: string; agentPort?: number; agentUrl?: string }) => {
    const wikiDir = resolve(process.cwd(), wikiDirArg);
    const outDir = resolve(process.cwd(), opts.out);

    const result = buildSite({
      wikiDir,
      outDir,
      siteName: opts.siteName,
      agent: opts.agentUrl || opts.agentPort ? { port: opts.agentPort, url: opts.agentUrl } : undefined,
    });
    console.log(`wikipilot: built ${result.pagesBuilt} page(s) into ${short(result.outDir)}`);

    const serveArg = opts.out === "./wiki-dist" ? "" : ` ${short(result.outDir)}`;
    nextSteps([
      `wikipilot serve${serveArg}`.padEnd(28) + "# preview at http://localhost:4400",
    ]);
  });

program
  .command("serve")
  .description("Serve a built wiki site locally (preview only — the built site is static)")
  .argument("[dir]", "built site directory to serve", "./wiki-dist")
  .option("-p, --port <n>", "port to serve on", (v) => parseInt(v, 10), 4400)
  .action(async (dirArg: string, opts: { port: number }) => {
    const dir = resolve(process.cwd(), dirArg);
    await serveSite(dir, opts.port);
    console.log(`wikipilot: serving ${short(dir)} at http://localhost:${opts.port}`);
    console.log("           press Ctrl+C to stop");
  });

program
  .command("agent")
  .description("Run the 'ask the wiki' AI assistant server (grounded in wiki content only)")
  .argument("[wikiDir]", "wiki directory to answer questions from", "./wiki")
  .option("-p, --port <n>", "port to serve the agent API on", (v) => parseInt(v, 10), 4402)
  .option("--model <name>", "Anthropic model to use", "claude-haiku-4-5-20251001")
  .option("--host <addr>", "address to bind to; defaults to loopback since this endpoint spends your API key", "127.0.0.1")
  .option("--allow-origin <url...>", "browser origin(s) allowed to call the API (localhost is always allowed)")
  .action(async (wikiDirArg: string, opts: { port: number; model: string; host: string; allowOrigin?: string[] }) => {
    const wikiDir = resolve(process.cwd(), wikiDirArg);
    await startAgentServer({
      wikiDir,
      port: opts.port,
      model: opts.model,
      host: opts.host,
      allowedOrigins: opts.allowOrigin,
    });
    console.log(`wikipilot: agent server running at http://${opts.host}:${opts.port}/api/chat`);
    if (opts.host === "127.0.0.1") {
      console.log("wikipilot: bound to loopback only — pass --host 0.0.0.0 to expose it, and --allow-origin for the site's domain.");
    }
    if (opts.allowOrigin?.includes("*")) {
      console.log("wikipilot: warning — --allow-origin '*' lets any website spend your API key.");
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log("wikipilot: no ANTHROPIC_API_KEY found — the assistant will report it needs setup until one is set.");
    }
  });

program.parseAsync();
