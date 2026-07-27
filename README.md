# wikipilot

Generate a documentation wiki from your codebase. `wikipilot` scans a repo, drafts a sectioned wiki from what's actually there, and builds it into a static site with search, dark/light theme, Mermaid diagrams, i18n, and an optional AI assistant that answers only from the wiki's own content.

Every page records the source files it was built from (`sources` + `last_synced`), so when those files change, the page says so instead of quietly going out of date.

## Try it in 30 seconds

From the root of any repo — no install, no config, no API key:

```bash
npx wikipilot init
```

It asks one question, drafts the wiki, and tells you what to run next:

```
wikipilot: drafted 7 page(s) into ./wiki — "My App"
           preset "technical": start-here, how-it-works, technologies, reference, cookbook
           added ./.claude/skills/update-wiki/SKILL.md so Claude Code can keep it in sync

Next:
  wikipilot build             # render it into a static site
  wikipilot serve             # preview at http://localhost:4400
```

Follow those two and you have a browsable site at <http://localhost:4400>.

## Install

For repeat use:

```bash
npm install -g wikipilot
```

Requires Node.js 18 or newer. Nothing else — no config file, no account, no key.

## The whole loop

```bash
wikipilot init      # pick a wiki type, draft real content into ./wiki
wikipilot build     # render ./wiki into ./wiki-dist as static HTML
wikipilot serve     # preview ./wiki-dist at http://localhost:4400
```

The defaults line up, so those three commands work with no arguments. Every flag below is optional.

`init` asks who the wiki is for and drafts sections to match:

| Preset | Sections |
|---|---|
| `technical` | `start-here`, `how-it-works`, `technologies`, `reference`, `cookbook` |
| `user-guide` | `start-here`, `getting-started`, `guides`, `faq`, `troubleshooting` |
| `all` | both, ordered from onboarding through to lookup material |

Pass `--preset <type>` to answer up front, or `--yes` to take the default. The prompt only appears on an interactive terminal — piped and CI runs take the default instead of hanging.

It doesn't scaffold empty placeholders: pages are drafted from your `package.json` and README (an overview, install and quick-start steps, one page per dependency, script-derived recipes, a file map) and stamped with the current commit SHA. The site is named after your project — `@acme/billing-service` becomes "Billing Service" — and `--site-name` overrides that.

It also writes a `.claude/skills/update-wiki` skill so Claude Code can author new pages and keep existing ones in sync — ask it to "update the wiki" or "audit the wiki".

> **No API key needed for any of the above.** `init`, `build`, and `serve` are fully local. An `ANTHROPIC_API_KEY` is only needed for the optional `wikipilot agent` chat widget — see [The AI assistant](#the-ai-assistant) below.

## Commands

| Command | What it does |
|---|---|
| `wikipilot init [target] -o <dir>` | Scan `target` (default `.`) and draft wiki content into `<dir>` (default `./wiki`). `--preset <technical\|user-guide\|all>` skips the prompt, `--yes` takes the default, `--no-skill` skips the Claude Code skill scaffold. |
| `wikipilot build [wikiDir] -o <dir> --site-name <name>` | Render content into static HTML. `--agent-port <n>` points the chat widget at a local agent server; `--agent-url <url>` points it at a hosted one. |
| `wikipilot serve [dir] -p <port>` | Preview a built site locally (default port 4400, loopback only). |
| `wikipilot agent [wikiDir] -p <port> --model <name>` | Run the "ask the wiki" assistant server (default port 4402, loopback only). Needs `ANTHROPIC_API_KEY` in the environment or a repo-root `.env` — without it, the widget shows a setup message instead of failing silently. Use `--host` and `--allow-origin` to expose it deliberately. |
| `wikipilot generate [source] -o <dir>` | Legacy flat-markdown mode: one `.md` per directory, no frontmatter/sections. Kept for simple cases. |

## Content model

Pages live at `wiki/content/<locale>/<section>/<slug>.md` with frontmatter:

```yaml
---
title: The Publish Pipeline
section: how-it-works
sources:
  - packages/publish-service/**
last_synced: "d70bf9ba"
stale: false
---
```

`wikipilot.config.json` (scaffolded by `init`) records the preset and controls sections, locales, and any repo-specific "sources of truth" files for drift detection:

```json
{
  "preset": "technical",
  "sections": ["start-here", "how-it-works", "technologies", "reference", "cookbook"],
  "locales": ["en"],
  "sourcesOfTruth": []
}
```

`sections` is authoritative — edit it directly to add or reorder sections beyond what the preset gives you.

Add a locale to `locales` and mirror content under `content/<locale>/...` — pages missing a translation automatically fall back to the default locale with a visible banner, so translation is incremental and never blocking.

## Writing pages

Beyond plain Markdown, two things are worth knowing:

**Caption a snippet with the file it came from.** The path renders above the block, and it's how the sync skill knows which file to re-read when checking the snippet is still accurate:

````markdown
```ts title="src/billing/refunds.ts"
export async function issueRefund(chargeId: string) { /* … */ }
```
````

**Mermaid renders natively** — `flowchart`, `sequenceDiagram`, `erDiagram`, `stateDiagram-v2`, `classDiagram` — from a fenced ` ```mermaid ` block.

Raw HTML is disabled in page bodies, so use Markdown or Mermaid for layout.

## The AI assistant

A floating chat widget answers questions grounded only in the wiki's own content via two tools (`search_wiki`, `read_page`) — it cites the pages it used and refuses to invent facts. Run `wikipilot agent` alongside `wikipilot serve` (or pass `--agent-port` to `build`) to wire it up. Runs on the cheapest capable Claude model by default (`claude-haiku-4-5`).

The wiki itself stays static — the assistant is the only piece that needs a server, and it's the only place your API key lives. To host the API separately from the site, build with `--agent-url https://api.example.com/api/chat` and start the agent with `--host 0.0.0.0 --allow-origin https://docs.example.com`. See [SECURITY.md](SECURITY.md) before exposing it.

## Programmatic use

```ts
import { init, buildSite, generateWiki } from "wikipilot";

init({ targetDir: "./my-project", wikiDir: "./my-project/wiki" });
buildSite({ wikiDir: "./my-project/wiki", outDir: "./my-project/wiki-dist" });
```

## Development

```bash
npm run build   # tsc + copy static assets
npm test        # node:test via tsx
```

No environment variables are needed to develop or use the CLI. Copy
[`.env.example`](.env.example) to `.env` only if you want the optional
assistant.

See `docs/` for architecture, product framing, and the phased roadmap —
[RELEASING.md](docs/RELEASING.md) for how a version gets published, and
[SEO.md](docs/SEO.md) for the marketing site's search setup.

## Security

Loopback-only by default for both `serve` and `agent`. Report vulnerabilities
privately — see [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).
