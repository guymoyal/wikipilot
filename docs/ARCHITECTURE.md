# Architecture (v2 direction)

wikipilot is pivoting from "flat markdown dump of a directory tree" to: **`wikipilot init` scaffolds a real dev/product/user portal into any repo**, generalizing the design proven in the GrandPagesCMS `wiki/` package (Astro Starlight-based) but with wikipilot's own lightweight static-site templater instead of an Astro dependency.

Reference for design decisions: `/Users/guymoy/moonshot/test/GrandPagesCMS/wiki/README.md` (sectioned nav, freshness contract, AI assistant, bilingual). None of that is GrandPagesCMS-specific — it's all generalizable *except* the actual page content, which is repo-specific and either hand-written or AI-drafted per project.

## Content model

Every page is a Markdown file with frontmatter:

```yaml
---
title: The Publish Pipeline
description: What clicking Publish actually does.
section: how-it-works        # maps to sidebar group; see sections below
order: 3
sources:                      # repo globs this page documents
  - packages/publish-service/**
last_synced: "d70bf9ba"       # commit SHA when prose was last verified against sources
stale: false                  # set true (+ reason) when sources changed and nobody's patched the prose yet
locale: en                    # or e.g. "he" for a translated mirror
---
```

- `sources` + `last_synced` is the freshness contract — see "Sync & audit" below.
- Files live at `wiki/content/<locale>/<section>/<slug>.md`. Default locale (`en`) has no prefix requirement in the URL; other locales are optional mirrors, falling back to `en` when missing.

## Default sections (configurable, not hardcoded)

Ship a default section set, but let a repo override via `wikipilot.config.json`:

- `start-here` — what the project is, architecture map, running it locally
- `technologies` — one page per stack technology
- `how-it-works` — cross-cutting flow walkthroughs
- `cookbook` — task recipes
- `reference` — glossary, service tables, maintenance guide

`wikipilot init` seeds these as empty section folders with a placeholder page; actual content generation (via scanning + optionally an LLM pass) is a separate step from scaffolding.

## Static site generator (own template, no Astro)

- Build step (`wikipilot build`) reads all Markdown under `wiki/content/`, renders to static HTML via a minimal templater (markdown-it or remark, no framework runtime dependency).
- Sidebar: grouped by `section`, ordered by `order`, generated at build time from frontmatter — not hand-maintained.
- Search: client-side, pure-JS index (e.g. minisearch) built at `wikipilot build` time and shipped as a static JSON asset — no server needed for search.
- Diagrams: Mermaid via a bundled/CDN-free client script, rendered from ` ```mermaid ` fences.
- Theme: light/dark toggle, CSS variables, no framework.
- i18n: locale switcher in the header; a page missing in a non-default locale renders the default-locale version with a "not yet translated" banner.
- Output is fully static (HTML/CSS/JS) — deployable anywhere, served locally via `wikipilot serve`.

## AI assistant ("ask the wiki")

- Optional local Node server scaffolded by `init` (`wiki/agent/server.mjs` equivalent), started by `wikipilot serve --agent` or a dedicated `wikipilot agent` command.
- Two tools only: `search_wiki` (hits the same search index as the static site) and `read_page`. Answers only from indexed content, cites pages, refuses to invent.
- Requires `ANTHROPIC_API_KEY` from env/`.env`; without it, the chat widget shows a setup message instead of failing silently.
- Model/port configurable via env vars, defaulting to the cheapest capable model.

## Sync & audit (generalized `update-wiki`)

Rather than wikipilot embedding its own AI-patching logic, `init` scaffolds a **Claude Code skill** (`.claude/skills/update-wiki/SKILL.md`) into the target repo, since the actual prose-patching needs an agent with codebase access — which Claude Code already provides. The skill instructions:

1. For each page, run `git diff --name-only <last_synced>..HEAD -- <sources>`; skip pages with no changes.
2. For changed pages, read the real diff and either patch the prose (re-reading live source, never guessing) or mark `stale: true` with a reason.
3. Detect drift: config-declared "sources of truth" (e.g. a service registry file, defined per-repo in `wikipilot.config.json`) vs. what pages currently document — flag new entities with no covering page.
4. Re-translate any changed page's locale mirrors.
5. Run `wikipilot build` as a correctness check, then land as a small PR.

Ongoing sync stays skill-driven — wikipilot bundles no LLM orchestration for keeping pages fresh, and ships the exact workflow proven in Grand-Wiki as a skill instead. Init is the one deliberate exception: it can run a single bounded investigation pass (opt-in, key required, capped in turns and bytes read) that rewrites the first draft, because that is a one-shot build step rather than a maintenance loop — see `src/lib/investigate.ts`. The runtime "ask the wiki" assistant above is a separate, simpler concern (read-only Q&A) and does need wikipilot to ship real server code.

## Config file (`wikipilot.config.json`, scaffolded by `init`)

```json
{
  "sections": ["start-here", "technologies", "how-it-works", "cookbook", "reference"],
  "locales": ["en"],
  "sourcesOfTruth": []
}
```

Kept minimal at v1 — grows as real repos need overrides.
