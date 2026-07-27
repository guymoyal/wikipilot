---
name: human-content
description: Use whenever writing or editing any user-facing copy in this repo — marketing site (site/data/*.json, site/src/templates/*.mjs), README, CLI output strings, FAQ, error messages. Catches and prevents copy that reads as AI-generated instead of written by a person who works on this specific product.
---

# Writing copy that doesn't sound like AI wrote it

The wikipilot site content kept drifting into a recognizable LLM voice even when the underlying facts were accurate. This skill is the checklist for catching that before it ships, and the reference for what "good" looks like for this project specifically.

## The tells (grep for these before calling copy done)

1. **A phrase repeated near-verbatim across sections.** "Quietly going stale" / "silently going out of date" / "quietly rotted" showing up in the hero, a feature card, and the FAQ is the single biggest tell — a person editing the whole page at once notices they've used the same line three times and varies it. An LLM writing each section in isolation doesn't. Before shipping a content change, grep the changed file(s) for any word repeated in more than one section (`quietly`, `silently`, `honest`, `stale`, `real`, etc. are the current repeat offenders) and rewrite the second and third occurrences differently.
2. **The "no X, no Y, no Z" triad as a default.** "No server, no database, no vendor lock-in." "No config, no annotations, no blank templates." One of these on the page is a nice rhythm. Four or five of them is a tic. Cap it at one per page section, and vary the list length (two items here, four there, one blunt item somewhere else) instead of defaulting to three.
3. **Every list item built on identical grammar.** If every feature card is `[Gerund/noun phrase]. [Sentence explaining what it does].` — same length, same shape — vary it. Let one card be a single short sentence. Let another run long. Real feature lists are uneven because a person wrote each one when they had something specific to say, not to fill a template slot.
4. **Corporate-blog adjectives with nothing under them.** Seamless, powerful, robust, cutting-edge, effortless, blazing-fast, world-class, game-changing, unlock, elevate, empower, supercharge. If the sentence still makes its point after deleting the adjective, delete it. Replace vague superlatives with the specific fact that justifies them (not "blazing-fast search" — "search that runs in the browser, no server round-trip").
5. **Contrast-crutch sentences.** "It's not just a docs generator — it's a freshness contract." One of these per page, maybe. Every other sentence built on "not just X, it's Y" reads as a template, not a person explaining something they built.
6. **Uniform sentence rhythm.** All short and punchy, or all long and explanatory, reads as generated. Real writing mixes a six-word sentence next to a thirty-word one. If you read a paragraph out loud and it has a metronome beat, break it.
7. **Headline wordplay in every single heading.** One clever turn of phrase per page can land. If every h2 is straining for the same kind of cleverness, most of them should just say the plain thing. The site used to lead with a pun about docs "lying" — it was retired in July 2026 because it described a feeling rather than the product. The h1 now states what the tool does; keep the cleverness budget small and spend it below the fold.

## What to do instead

- **Be concrete, not superlative.** Name the actual command, the actual file, the actual number. "wikipilot build outputs plain HTML/CSS/JS" beats "blazing-fast static output."
- **Let sections have different voices for different jobs.** The pricing table should read like a pricing table (terse, scannable). A FAQ answer can be a little more conversational. The hero can have one moment of style. They shouldn't all sound like the same paragraph restyled.
- **Cut hedge-free absolutes.** "Every competitor has the same failure mode" is a strong, specific claim from `PRODUCT.md` — keep claims like that only when they're actually true and defensible, not as a rhetorical default.
- **Read the whole page in one pass before shipping.** Most of these tells are only visible at the page level — a single sentence in isolation looks fine; three sentences using the same construction across three sections is the problem. Read hero → stats → steps → features → FAQ → pricing back to back and flag anything that echoes something said two sections ago.

## Process

When asked to write or edit site copy:
1. Read `docs/PRODUCT.md` first — the actual positioning and claims should come from there, not be reinvented.
2. Draft the section.
3. Before finishing, re-read the *whole affected page* (not just the section you touched) and check it against the tells above.
4. Fix repeats and template-y patterns inline. Don't ship a first draft.
