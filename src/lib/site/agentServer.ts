import { createServer, type Server } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import MiniSearch from "minisearch";
import { readConfig } from "../config.js";
import { loadDotEnv } from "../env.js";
import { loadWikiContent, resolveLocalePages, type LoadedPage } from "./loadContent.js";

const SEARCH_TOOL: Anthropic.Tool = {
  name: "search_wiki",
  description: "Search the wiki for pages relevant to a query. Returns titles, URLs, and short snippets.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "Search terms" } },
    required: ["query"],
  },
};

const READ_TOOL: Anthropic.Tool = {
  name: "read_page",
  description: "Read the full content of a wiki page by its URL path (e.g. /start-here/overview/).",
  input_schema: {
    type: "object",
    properties: { url: { type: "string", description: "The page's urlPath" } },
    required: ["url"],
  },
};

export interface AgentServerOptions {
  wikiDir: string;
  port: number;
  model?: string;
  /** Loopback by default — this endpoint spends the operator's API key. */
  host?: string;
  /** Extra browser origins allowed to call the API. Localhost is always allowed. */
  allowedOrigins?: string[];
  allowAnon?: boolean;
}

/** A question and a short conversation can't legitimately be large. */
const MAX_BODY_BYTES = 64 * 1024;
const MAX_HISTORY_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 4000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;

const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function isAllowedOrigin(origin: string | undefined, allowed: string[]): string | null {
  if (!origin) return null; // same-origin or non-browser: no CORS header needed
  if (LOCALHOST_ORIGIN.test(origin)) return origin;
  if (allowed.includes("*")) return origin;
  return allowed.includes(origin) ? origin : null;
}

/**
 * The client controls `history`, and it is replayed straight into a paid model
 * call. Accept only the shape we produce ourselves, and cap how much of it there
 * can be, so a caller can't smuggle in a long forged conversation.
 */
function sanitizeHistory(history: unknown): Anthropic.MessageParam[] {
  if (!Array.isArray(history)) return [];

  const clean: Anthropic.MessageParam[] = [];
  for (const entry of history.slice(-MAX_HISTORY_MESSAGES)) {
    if (!entry || typeof entry !== "object") continue;
    const { role, content } = entry as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string" || !content.trim()) continue;
    clean.push({ role, content: content.slice(0, MAX_MESSAGE_CHARS) });
  }
  return clean;
}

/** Coarse per-client cap so an open port can't run up an unbounded bill. */
function createRateLimiter() {
  const hits = new Map<string, number[]>();

  return function allow(key: string): boolean {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (recent.length >= RATE_LIMIT_MAX) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 1000) hits.clear(); // bounded memory; a reset just forgives everyone
    return true;
  };
}

function buildPageIndex(pages: LoadedPage[]): string {
  return pages.map((p) => `- ${p.urlPath} — ${p.frontmatter.title}${p.frontmatter.description ? `: ${p.frontmatter.description}` : ""}`).join("\n");
}

function systemPrompt(pageIndex: string): string {
  return [
    "You are 'Ask the wiki', an assistant that answers questions using ONLY the content of this wiki.",
    "You have two tools: search_wiki (keyword search) and read_page (fetch a page's full body by urlPath).",
    "Always ground answers in wiki content you have actually read via these tools — never invent facts, APIs, or file paths that aren't in the wiki.",
    "If the wiki doesn't cover something, say so plainly instead of guessing.",
    "Cite the pages you used as markdown links using their urlPath.",
    "Here is the current page index (titles + urlPaths) so you know what exists before searching:",
    pageIndex,
  ].join("\n\n");
}

export function startAgentServer(options: AgentServerOptions): Promise<Server> {
  loadDotEnv(process.cwd());
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = options.model ?? process.env.WIKI_AGENT_MODEL ?? "claude-haiku-4-5-20251001";

  const config = readConfig(options.wikiDir);
  const allPages = loadWikiContent(options.wikiDir, config);
  const defaultLocale = config.locales[0] ?? "en";
  const pages = resolveLocalePages(allPages, config, defaultLocale).filter((p) => !p.fallback);

  const miniSearch = new MiniSearch({ fields: ["title", "body"], storeFields: ["title", "url"] });
  for (const p of pages) {
    miniSearch.add({ id: p.urlPath, title: p.frontmatter.title, body: p.body, url: p.urlPath });
  }

  const pageIndex = buildPageIndex(pages);
  const client = apiKey ? new Anthropic({ apiKey }) : null;

  function runSearch(query: string) {
    return miniSearch
      .search(query, { prefix: true, fuzzy: 0.2 })
      .slice(0, 5)
      .map((hit) => {
        const page = pages.find((p) => p.urlPath === hit.url);
        return { title: hit.title, url: hit.url, snippet: page ? page.body.slice(0, 240) : "" };
      });
  }

  function runReadPage(url: string) {
    const page = pages.find((p) => p.urlPath === url);
    if (!page) return { error: `No page at ${url}` };
    return { title: page.frontmatter.title, url: page.urlPath, body: page.body };
  }

  async function answer(message: string, history: Anthropic.MessageParam[]): Promise<{ answer: string }> {
    if (!client) {
      return { answer: "The AI assistant isn't configured yet — set ANTHROPIC_API_KEY in your environment or a repo-root .env file to enable it." };
    }

    const messages: Anthropic.MessageParam[] = [...history, { role: "user", content: message }];

    for (let i = 0; i < 5; i++) {
      const response = await client.messages.create({
        model,
        max_tokens: 1024,
        system: systemPrompt(pageIndex),
        tools: [SEARCH_TOOL, READ_TOOL],
        messages,
      });

      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) {
        const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
        return { answer: text };
      }

      messages.push({ role: "assistant", content: response.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = toolUses.map((use) => {
        const input = use.input as { query?: string; url?: string };
        const result = use.name === "search_wiki" ? runSearch(input.query ?? "") : runReadPage(input.url ?? "");
        return { type: "tool_result", tool_use_id: use.id, content: JSON.stringify(result) };
      });
      messages.push({ role: "user", content: toolResults });
    }

    return { answer: "I wasn't able to find a grounded answer within the tool-call budget — try rephrasing your question." };
  }

  const allowedOrigins = options.allowedOrigins ?? [];
  const allowRequest = createRateLimiter();

  const server = createServer(async (req, res) => {
    const origin = isAllowedOrigin(req.headers.origin, allowedOrigins);
    const corsHeaders: Record<string, string> = origin
      ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
      : {};

    const send = (code: number, payload: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify(payload));
    };

    if (req.method === "OPTIONS") {
      // No echoed origin means the browser preflight fails, which is the point.
      res.writeHead(origin ? 204 : 403, {
        ...corsHeaders,
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Max-Age": "600",
      });
      res.end();
      return;
    }

    if (req.method === "POST" && req.url === "/api/chat") {
      if (req.headers.origin && !origin) {
        return send(403, { error: "Origin not allowed. Start the agent with --allow-origin <url>." });
      }

      const callerKey = req.socket.remoteAddress ?? "unknown";
      if (!allowRequest(callerKey)) {
        return send(429, { error: "Too many requests — wait a minute and try again." });
      }

      let body = "";
      let aborted = false;

      req.on("data", (chunk) => {
        if (aborted) return;
        body += chunk;
        if (body.length > MAX_BODY_BYTES) {
          aborted = true;
          send(413, { error: "Request too large." });
          req.destroy();
        }
      });

      req.on("end", async () => {
        if (aborted) return;
        try {
          const parsed = JSON.parse(body || "{}");
          const message = parsed?.message;
          if (typeof message !== "string" || !message.trim()) {
            return send(400, { error: "message is required" });
          }

          const result = await answer(message.slice(0, MAX_MESSAGE_CHARS), sanitizeHistory(parsed?.history));
          send(200, result);
        } catch (err) {
          // Upstream errors can carry request details and key fragments — log
          // them for the operator, return something generic to the caller.
          console.error("wikipilot agent:", err);
          send(500, { error: "The assistant failed to answer. Check the agent server logs." });
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(options.port, options.host ?? "127.0.0.1", () => resolve(server));
  });
}
