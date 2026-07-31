# Professional Init Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `wikipilot init` (with the AI deep investigation) produce a wiki with a product story, user-flow diagrams, a first-class developer-onboarding section, and tech pages that explain why each technology is here.

**Architecture:** A new `onboarding` section is added to the `technical` and `all` presets (config + section briefs + a mechanical draft stub). The investigation system prompt in `src/lib/investigate.ts` gains a product-investigation step, a required-page contract keyed to the wiki's sections, and a pre-finish self-check. `docs/wiki-init-skills.md` (the human-facing mirror of that prompt) is updated in sync.

**Tech Stack:** TypeScript (ESM, Node ≥18), `node --test` via tsx (`npm test`), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-31-professional-init-docs-design.md`

## Global Constraints

- Existing wikis must be untouched: `readConfig` already treats an explicit `sections` array as authoritative — never change that behaviour.
- The `user-guide` preset does NOT get the `onboarding` section.
- No emoji anywhere in generated content or prompts (existing rule).
- `docs/wiki-init-skills.md` and `buildSystemPrompt` mirror each other — a change to one requires the matching change to the other (this plan does both).
- Run tests with `npm test` from the repo root. Commit after every task.

---

### Task 1: Add the `onboarding` section to presets and section briefs

**Files:**
- Modify: `src/lib/config.ts:22-36` (`TECHNICAL_SECTIONS`, `ALL_SECTIONS`)
- Modify: `src/lib/skill.ts:8-18` (`SECTION_BRIEFS`)
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `sectionsForPreset("technical")` and `sectionsForPreset("all")` now include `"onboarding"`; `SECTION_BRIEFS["onboarding"]` exists (used by Task 3's prompt and the scaffolded update-wiki skill automatically).

- [ ] **Step 1: Write the failing tests** — append to `test/config.test.ts`:

```ts
test("technical and all presets include onboarding; user-guide does not", () => {
  assert.ok(sectionsForPreset("technical").includes("onboarding"));
  assert.ok(sectionsForPreset("all").includes("onboarding"));
  assert.ok(!sectionsForPreset("user-guide").includes("onboarding"));
  // Reader order: onboarding opens the dev-facing half.
  const technical = sectionsForPreset("technical");
  assert.equal(technical[1], "onboarding");
  const all = sectionsForPreset("all");
  assert.equal(all.indexOf("onboarding"), all.indexOf("guides") + 1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test 2>&1 | grep -A3 "onboarding"`
Expected: FAIL — `onboarding` not in the lists.

- [ ] **Step 3: Implement** — in `src/lib/config.ts` replace the two constants:

```ts
export const TECHNICAL_SECTIONS = ["start-here", "onboarding", "how-it-works", "technologies", "reference", "cookbook"];
export const USER_GUIDE_SECTIONS = ["start-here", "getting-started", "guides", "faq", "troubleshooting"];

/** Union, ordered so a reader moves from onboarding → usage → internals → lookup. */
export const ALL_SECTIONS = [
  "start-here",
  "getting-started",
  "guides",
  "onboarding",
  "how-it-works",
  "technologies",
  "cookbook",
  "faq",
  "troubleshooting",
  "reference",
];
```

In `src/lib/skill.ts`, add to `SECTION_BRIEFS` (after the `"getting-started"` entry, matching the object's reading order):

```ts
  onboarding:
    "A new developer's first week: environment setup with verified commands, a guided repo tour, where to make a first change, how to run and read the tests. Written for someone who joined yesterday.",
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS (no other test hardcodes the full lists; if one fails, it is asserting stale section order — update it to the new lists, not the other way round).

- [ ] **Step 5: Commit**

```bash
git add src/lib/config.ts src/lib/skill.ts test/config.test.ts
git commit -m "Add an onboarding section to the technical and all presets"
```

---

### Task 2: Mechanical draft stub for `onboarding`

**Files:**
- Modify: `src/lib/draft.ts` (new `draftOnboarding`, wired into `draftContent` at `src/lib/draft.ts:584-599`)
- Test: `test/draft.test.ts`

**Interfaces:**
- Consumes: `sectionsForPreset` including `"onboarding"` (Task 1); existing `ScannedDir`, `PackageJson`, `DraftedPage` types in `draft.ts`.
- Produces: `draftContent(dir, "technical" | "all")` emits one page `{ section: "onboarding", slug: "index" }`.

- [ ] **Step 1: Write the failing tests** — append to `test/draft.test.ts`:

```ts
test("draftContent emits an onboarding stub for the all preset with real detected commands", () => {
  const dir = makeFixtureRepo();
  try {
    const pages = draftContent(dir);
    const onboarding = pages.find((p) => p.section === "onboarding" && p.slug === "index");
    assert.ok(onboarding, "expected an onboarding/index page");
    assert.ok(onboarding.body.includes("npm run test"), "detected scripts appear as day-one commands");
    assert.ok(onboarding.body.includes("`src/`"), "repo tour lists top-level directories");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("draftContent omits onboarding for the user-guide preset", () => {
  const dir = makeFixtureRepo();
  try {
    const pages = draftContent(dir, "user-guide");
    assert.ok(!pages.some((p) => p.section === "onboarding"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test 2>&1 | grep -B1 -A5 "onboarding"`
Expected: first new test FAILS ("expected an onboarding/index page"); second passes trivially — that's fine, it pins the behaviour.

- [ ] **Step 3: Implement** — add to `src/lib/draft.ts` (next to the other drafters, before `draftContent`):

```ts
function draftOnboarding(tree: ScannedDir, pkg: PackageJson | null, sha: string): DraftedPage[] {
  const name = pkg?.name ?? tree.name;
  const lines: string[] = [
    `The page a developer opens on their first day working on ${name}. This stub lists what was mechanically detectable — replace each section with what a new teammate genuinely needs.`,
    "",
    "## Day-one setup",
    "",
  ];

  const engines = pkg?.engines ? Object.entries(pkg.engines) : [];
  for (const [engine, range] of engines) {
    lines.push(`- ${engine} \`${range}\``);
  }
  if (engines.length) lines.push("");

  const scripts = pkg?.scripts ?? {};
  const dayOne = ["install", "dev", "test", "build"].filter((s) => scripts[s]);
  if (dayOne.length) {
    lines.push("```bash");
    if (!scripts.install) lines.push("npm install");
    for (const script of dayOne) lines.push(`npm run ${script}`);
    lines.push("```", "");
  } else {
    lines.push("No standard scripts detected — write the exact commands that take a fresh clone to passing tests.", "");
  }

  lines.push("## Repo tour", "");
  for (const sub of tree.subdirs) {
    lines.push(`- \`${sub.name}/\` — say what lives here and when a new dev touches it`);
  }
  lines.push(
    "",
    "## Your first change",
    "",
    "Point at a real, low-risk place to make a first change, and describe how to verify it worked. Until then, a new dev has to guess.",
  );

  return [
    {
      section: "onboarding",
      slug: "index",
      frontmatter: {
        title: "Developer onboarding",
        description: `A new developer's first week on ${name}: setup, repo tour, first change.`,
        section: "onboarding",
        order: 1,
        sources: ["package.json"],
        last_synced: sha,
        locale: "en",
      },
      body: lines.join("\n"),
    },
  ];
}
```

Wire it into `draftContent`'s `drafted` array, after `...draftGuides(tree, pkg, sha),`:

```ts
    ...draftOnboarding(tree, pkg, sha),
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/draft.ts test/draft.test.ts
git commit -m "Draft a mechanical onboarding stub for the technical and all presets"
```

---

### Task 3: Investigation prompt — product lens, required pages, pre-finish self-check

**Files:**
- Modify: `src/lib/investigate.ts:179-234` (`buildSystemPrompt`, plus a new `requiredPagesGuidance` helper next to `sectionGuidance`)
- Test: `test/investigate.test.ts`

**Interfaces:**
- Consumes: `SECTION_BRIEFS` including `onboarding` (Task 1); `config.sections` from `WikipilotConfig`.
- Produces: `buildSystemPrompt(config, facts)` output containing the new blocks, conditional on `config.sections`. (Exported signature unchanged.)

- [ ] **Step 1: Write the failing tests** — append to `test/investigate.test.ts` (it already imports `buildSystemPrompt` — if not, add it to the existing import from `../src/lib/investigate.js`):

```ts
test("buildSystemPrompt demands product narrative, user-flow diagram, onboarding, and tech rationale for the all preset", () => {
  const prompt = buildSystemPrompt(configForPreset("all"), { sha: "abc1234", locale: "en" });
  assert.match(prompt, /user's journey/);
  assert.match(prompt, /start-here\/overview/);
  assert.match(prompt, /user-flow diagram/);
  assert.match(prompt, /onboarding\/index/);
  assert.match(prompt, /why this technology serves this project/i);
  assert.match(prompt, /Before you call finish/);
});

test("buildSystemPrompt omits required pages whose sections are not in this wiki", () => {
  const prompt = buildSystemPrompt(configForPreset("user-guide"), { sha: "abc1234", locale: "en" });
  assert.ok(!prompt.includes("onboarding/index"));
  assert.ok(!prompt.includes("why this technology serves this project"));
  // The product narrative applies to every preset.
  assert.match(prompt, /start-here\/overview/);
  assert.match(prompt, /Before you call finish/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test 2>&1 | grep -B1 -A5 "buildSystemPrompt demands"`
Expected: FAIL on the first new assertion.

- [ ] **Step 3: Implement** — three edits to `src/lib/investigate.ts`.

**(a)** Add a helper next to `sectionGuidance` (after `src/lib/investigate.ts:173`):

```ts
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
```

**(b)** In `buildSystemPrompt`, extend Phase 1's numbered list: renumber the existing items and insert as item 2 (after "Entry points"):

```text
2. The product surface: UI routes or screens, CLI commands, API endpoints, exported entry points. From these, answer: who uses this, what problem it solves for them, and the user's journey — the sequence of user-visible steps from first contact to the core result. For a library or CLI the journey is the primary usage path; never invent a funnel the code does not show.
```

**(c)** In the Phase 2 block of the prompt (after the existing paragraph ending "three real FAQ entries beat ten invented ones."), append:

```text

Required pages — this wiki is rejected without them:

${requiredPagesGuidance(config.sections)}
```

**(d)** After the "Anti-patterns" block and before "## This wiki", insert:

```text
## Before you call finish

Walk this checklist page by page; a failed item means fix it, then finish:

- Every required page above exists and meets its stated bar.
- No mechanical-draft placeholder text survives anywhere.
- Cross-section links use the ../../<section>/<slug>/ form; same-section links use ../<slug>/.
- Every diagram has one intro sentence and at most ~12 nodes.
- Every page's sources are the narrowest globs that truly cover it.
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS, including all existing scripted-model `investigate` tests (the prompt change must not affect the tool loop).

- [ ] **Step 5: Commit**

```bash
git add src/lib/investigate.ts test/investigate.test.ts
git commit -m "Demand product story, user flows, onboarding, and tech rationale from the investigation"
```

---

### Task 4: Sync `docs/wiki-init-skills.md` with the new prompt

**Files:**
- Modify: `docs/wiki-init-skills.md` (preset table ~line 37-41, Phase 1 list ~line 83-107, Phase 2 table ~line 129-140, Phase 4 checklist ~line 251-264)

**Interfaces:**
- Consumes: the exact wording landed in Task 3 (keep the two surfaces saying the same thing).
- Produces: nothing code-facing; this is the human/skill-facing mirror.

- [ ] **Step 1: Update the preset table** — replace the two changed rows:

```markdown
| `all` (the default) | `start-here`, `getting-started`, `guides`, `onboarding`, `how-it-works`, `technologies`, `cookbook`, `faq`, `troubleshooting`, `reference` |
| `technical` | `start-here`, `onboarding`, `how-it-works`, `technologies`, `reference`, `cookbook` |
```

- [ ] **Step 2: Add the product-surface step to Phase 1** — insert as item 2 (renumber the rest):

```markdown
2. **The product surface.** UI routes or screens, CLI commands, API endpoints,
   exported entry points. From these, answer: who uses this, what problem it
   solves for them, and the user's journey — the sequence of user-visible
   steps from first contact to the core result. For a library or CLI the
   journey is the primary usage path; never invent a funnel the code does
   not show.
```

- [ ] **Step 3: Extend the Phase 2 table and add the required-pages note** — add the row (after `guides`):

```markdown
| `onboarding` | scripts, repo tour, tests | a new developer's day one: verified setup commands, where things live and why, a first-change walkthrough, how to run the tests |
```

and after the table's "Skip a section rather than pad it" paragraph, add:

```markdown
Four pages are required whenever their section exists, and each has a bar:
`start-here/overview` opens with the product narrative (what it does, who
uses it, the 2-4 main use cases) and ends with a map for each reader type;
one `how-it-works` page carries an end-to-end **user-flow diagram** (the
user's journey, distinct from the architecture diagram); `onboarding/index`
covers day one as described above; every `technologies` page says why the
technology serves *this* project — verified or marked as an open question —
with a copied snippet and links to the importing files.
```

- [ ] **Step 4: Add the self-check to Phase 4** — insert as new items in the numbered list (before the final "Land it as a reviewable commit" item):

```markdown
6. Walk the required pages: overview opens with the product narrative,
   how-it-works has its user-flow diagram, onboarding covers day one,
   technologies pages carry their "why" and a copied snippet.
7. Confirm no mechanical-draft placeholder text survives anywhere.
```

(renumber the former item 6 to 8).

- [ ] **Step 5: Verify and commit**

Run: `npm test` (docs change — suite must still pass untouched).

```bash
git add docs/wiki-init-skills.md
git commit -m "Mirror the new investigation requirements in the wiki-init skill doc"
```

---

### Task 5: End-to-end verification

**Files:** none created; smoke-test artifacts go to the scratchpad, not the repo.

- [ ] **Step 1: Full suite and build**

Run: `npm test && npm run build`
Expected: both PASS.

- [ ] **Step 2: Smoke the mechanical init** — from the repo root:

Run (where `$SCRATCHPAD` is the session scratchpad directory):
```bash
node ./dist/bin/wikipilot.js init . --preset technical --no-ai --no-skill --yes -o "$SCRATCHPAD/smoke-wiki" 2>&1 | tail -5
ls "$SCRATCHPAD/smoke-wiki/content/en"
```
Expected: an `onboarding/` directory with `index.md` alongside the other technical sections, and `$SCRATCHPAD/smoke-wiki/wikipilot.config.json` listing `onboarding`.

- [ ] **Step 3: Confirm the built site renders the new section**

Run: `node ./dist/bin/wikipilot.js build "$SCRATCHPAD/smoke-wiki" -o "$SCRATCHPAD/smoke-dist" 2>&1 | tail -3`
Expected: build succeeds and `$SCRATCHPAD/smoke-dist/onboarding/index.html` exists.

- [ ] **Step 4: Final commit if anything was fixed**

If the smoke test surfaced fixes, commit them with a message describing the fix. Otherwise nothing to commit.
