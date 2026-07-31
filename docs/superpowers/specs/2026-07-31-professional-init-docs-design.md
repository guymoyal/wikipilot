# Professional init docs — design

**Date:** 2026-07-31
**Goal:** `wikipilot init` (with the AI deep investigation) produces a wiki good enough that a dev team wants it in the repo: a real product story, user-flow diagrams, a first-class developer-onboarding path, and tech-stack pages that explain *why* each technology is here — with code receipts.

## Decisions already made (with the user)

- **AI-first.** The top-tier output requires the deep investigation (`src/lib/investigate.ts`). The mechanical draft (`src/lib/draft.ts`) stays as an honest fallback floor; it gains only a stub for the new section.
- **Must-have content:** product story & usage narrative, user-flow/funnel diagrams, developer onboarding path, deeper tech-stack rationale.
- **Structure:** add a new `onboarding` section to the `technical` and `all` presets; the other must-haves land inside existing sections (`start-here`, `how-it-works`, `guides`, `technologies`).
- **Cost:** single investigation pass, stronger prompt with a self-check before `finish`. No second critique pass.

## 1. New `onboarding` section

Dev-facing: the page a new hire opens on day one.

- `src/lib/config.ts`:
  - `TECHNICAL_SECTIONS`: insert `onboarding` after `start-here`.
  - `ALL_SECTIONS`: insert `onboarding` after `guides` (reader order stays onboarding-for-users first, then the technical half opens with onboarding-for-devs).
  - `user-guide` preset unchanged — onboarding is for people working *on* the code.
- `src/lib/skill.ts` `SECTION_BRIEFS`: add
  `onboarding` — "A new developer's first week: environment setup with verified commands, a guided repo tour, where to make a first change, how to run and read the tests. Written for someone who joined yesterday."
  (The scaffolded update-wiki skill and the investigation prompt both derive from `SECTION_BRIEFS`, so this flows into both automatically.)
- `src/lib/draft.ts`: new `draftOnboarding()` producing a mechanical stub from what is detectable — `engines`, install/dev/test/build scripts, top-level workspace layout — plus explicit guidance on what a human (or the investigation) should fill in. Included in `technical`/`all` via the existing section filter.

**Backward compatibility:** `readConfig` treats an existing config's explicit `sections` array as authoritative and never rewrites it, so existing wikis are untouched. Only new inits get the section.

## 2. Investigation prompt overhaul (`buildSystemPrompt`)

The prompt already enforces evidence discipline (snippets copied, diagrams derived, no filler). It gains a **product lens**, a **required-page contract**, and a **pre-finish self-check**.

### Phase 1 addition — investigate the product, not just the code

New investigation step: identify what the *product* is from its user-facing surface — UI routes/screens, CLI commands, API endpoints, exported entry points. Answer: who uses this, what problem it solves for them, and what the user's journey through it looks like (the sequence of user-visible steps from first contact to the core result). For a library/CLI with no funnel, the "journey" is the primary usage path — the prompt must say diagrams follow the evidence and funnels are never invented.

### Phase 2 addition — required pages

When the preset includes the section, these pages are required and have a stated bar:

| Page | Bar |
|---|---|
| `start-here/overview` | Opens with the product narrative: what it does, who it's for, the 2–4 main use cases — before any repo detail. Ends with a map of where each reader type goes next. Never a directory listing. |
| `how-it-works` (one page) | At least one end-to-end **user-flow diagram**: the user's journey as a mermaid `flowchart` or `sequenceDiagram` (user action → system steps → visible result), distinct from the internal architecture diagram, both derived from traced code. |
| `onboarding/index` (+ pages as evidence supports) | Day-one environment setup with verified commands; a repo tour explaining where things live and why; a "your first change" walkthrough pointing at a real, low-risk location; how to run the tests and what CI expects. |
| `technologies/*` | Each page states **why this technology serves this project** — verified from code/config, or explicitly marked as an open question — plus a snippet copied from this repo showing characteristic use, and links to the importing files. |

### Pre-finish self-check

Before calling `finish`, the agent must confirm, page by page: every required page above exists and meets its bar; no mechanical-draft placeholder text survives; cross-section links use `../../section/slug/` form; every diagram has an intro sentence and ≤ ~12 nodes; every page's `sources` are narrow globs. A failed check means fix, not finish.

## 3. Sync surfaces

`docs/wiki-init-skills.md` is the human/skill-facing mirror of the investigation prompt and must be updated in the same change: preset table gains `onboarding`, Phase 1 gains the product-lens step, Phase 2's table gains the required-page bars, Phase 4 gains the self-check items.

## 4. Testing

- `configForPreset` reflects the new section lists; `readConfig` leaves legacy explicit `sections` untouched (existing behaviour, re-asserted).
- `draftContent` emits the onboarding stub for `technical`/`all` and not for `user-guide`.
- `buildSystemPrompt` contains the required-page contract and self-check for included sections, and omits `onboarding` guidance when the preset lacks it.
- Existing scripted-model `investigate` tests (injected `createMessage`) still pass; add one asserting a `write_page` to `onboarding` is accepted under the `all` preset.

## Non-goals

- No second critique/review pass (rejected on cost).
- No changes to the site renderer, serve, or build pipeline.
- No mechanical-draft intelligence beyond the onboarding stub.
- No changes to existing wikis' configs or sections.
