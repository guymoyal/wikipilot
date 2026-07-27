# Releasing

CI verifies; **you publish**. Tagging runs the release checks, and the actual
`npm publish` happens from your machine.

This is deliberate. The alternative — an npm automation token stored in GitHub
Actions secrets — means a long-lived credential that can publish under your name
and bypasses 2FA by design. Since you're the only person who releases, CI
publishing would buy convenience and cost you that. So: **no npm token exists in
this repo, in GitHub secrets, or anywhere in CI.**

**The tradeoff:** npm provenance attestations require publishing from a
supported CI system, so manual publishing means no provenance badge on the npm
page. If you later want it, see *Switching to trusted publishing* at the bottom
— it gets provenance back without storing a token.

## One-time setup

### 1. npm account

The name `wikipilot` was unclaimed as of 2026-07-27. Claim it before someone
else does.

```bash
npm login                    # browser-based; then check it took:
npm whoami
```

Enable 2FA on the account if you haven't: <https://www.npmjs.com/settings/~/profile>
→ **Two-Factor Authentication** → require it for **authorization and publishing**.
With manual publishing this actually protects you, because every publish prompts.

### 2. GitHub CLI (optional)

`gh auth login` uses a browser flow — it prints a one-time code, you approve it
in the browser, and it manages its own credential. Nothing to paste, and it's
only needed if you want to drive repo settings from the terminal instead of the
web UI.

### 3. Make the repo public

**Settings → General → Danger Zone → Change visibility → Public.**

Already verified safe: no `.env`, `.dev.vars`, key, or credential file is
tracked, and none appears anywhere in git history.

### 4. Protect `main`

You asked that only you can merge to `main` and cut releases. GitHub's terms for
that, under **Settings → Rules → Rulesets → New branch ruleset**:

- **Target**: `main` (Default branch)
- **Enforcement**: Active
- **Restrict deletions** ✔
- **Block force pushes** ✔
- **Require a pull request before merging** ✔ — set **Required approvals** to 0
  if you're solo (you can't approve your own PR, and 1 would lock you out)
- **Require status checks to pass** ✔ → add `build-and-test`
- **Bypass list**: add yourself (Repository admin) so you can still merge

Then, to stop anyone else from merging even if you later add collaborators:

- **Settings → Collaborators and teams** — give others `Write` at most, and rely
  on the ruleset's bypass list containing only you.

For tags, add a second ruleset:

- **Target**: Tags, pattern `v*`
- **Restrict creation** ✔ with only you in the bypass list — so only you can cut
  a release.

CLI equivalent for the branch ruleset, if you prefer:

```bash
gh api repos/guymoyal/wikipilot/rulesets --method POST --input - <<'JSON'
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    }
  ],
  "bypass_actors": [
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }
  ]
}
JSON
```

(`actor_id: 5` is the repository-admin role.)

## Cutting a release

1. Make sure `main` is green and you're on it.
2. Bump the version. Don't hand-edit `package.json` — `npm version` also creates
   the matching commit and tag:

   ```bash
   npm version minor    # or patch / major
   ```

   **The first release should be `0.2.0`, not `0.1.1`.** The wizard work renamed
   `BuildOptions.agentPort` → `BuildOptions.agent` and `RenderOptions.agentPort`
   → `RenderOptions.agent`, both exported from `src/lib/index.ts` and documented
   as programmatic API in the README. Nothing is published yet so nobody breaks,
   but a minor bump is the honest tag.

3. Push the commit and the tag:

   ```bash
   git push origin main --follow-tags
   ```

4. Wait for the **Release checks** workflow to go green. It:
   - runs the test suite on Node 18, 20, and 22
   - checks the tag matches `package.json` (`v0.2.0` ↔ `0.2.0`)
   - verifies the tarball actually contains `dist/bin/wikipilot.js` and the site
     assets — `dist` is in `.gitignore`, so this guards against the `files`
     allowlist ever stopping overriding that
   - installs the packed tarball into a clean directory and runs
     `init --preset user-guide` → `build` end to end

   ```bash
   gh run watch          # or just watch the Actions tab
   ```

5. Publish:

   ```bash
   npm publish           # prompts for 2FA
   ```

   `prepublishOnly` rebuilds first, so you can't ship a stale `dist/`.

## Dry run

Check what would be published without publishing it:

```bash
npm publish --dry-run     # prints the exact file list and package size
```

To exercise the full CI path without tagging: **Actions → Release checks → Run
workflow**.

## After the first publish

- Check the page: <https://www.npmjs.com/package/wikipilot>
- In a clean shell: `npm install -g wikipilot && wikipilot --version`
- Run `wikipilot init` somewhere real and confirm the wizard prompts.
- The site's install snippets and the guide's "build from source" fallback are
  already written assuming the package exists.

## Version policy

Pre-1.0, so `0.x` minor bumps may break things. Once the CLI flags settle, tag
`1.0.0` and follow semver properly: flag removals and output-shape changes
become major.

## Switching to trusted publishing later

If you eventually want CI to publish *and* want the provenance badge, npm's
trusted publishing (OIDC) does it without storing a token — npm verifies the
workflow's identity directly.

Rough shape, once the package exists on npm:

1. npmjs.com → the package → **Settings → Trusted Publisher** → add
   `guymoyal/wikipilot` and the workflow filename.
2. Add a publish job with `permissions: id-token: write` and
   `npm publish --provenance`.
3. Bump npm inside the workflow — trusted publishing needs a newer npm CLI than
   `actions/setup-node` ships by default (`npm install -g npm@latest`).

Verify the current setup steps against npm's docs when you do this; the feature
is newer than the rest of this file and the UI has moved before.

