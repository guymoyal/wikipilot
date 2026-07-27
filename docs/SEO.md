# Search & answer-engine setup

Everything the build already produces, plus the one-time steps that have to be
done by a human in someone else's web UI. Work top to bottom the first time;
after that only the **After each deploy** section matters.

## What the build already handles

`site/scripts/build.mjs` writes these into `site/dist/` on every run. You don't
maintain them by hand:

| File | What it's for |
|---|---|
| `robots.txt` | Allows all crawlers, explicitly allows GPTBot / ClaudeBot / PerplexityBot / Google-Extended, points at the sitemap. |
| `sitemap.xml` | One entry per page in the `PAGES` table in `build.mjs`, with `lastmod` set to the build date. |
| `llms.txt` | A plain-text brief for AI answer engines: what the tool is, install command, key facts, commands, full FAQ. |
| `og.svg` | Source form of the share image. |
| JSON-LD | `Organization`, `WebSite`, `SoftwareApplication`, `FAQPage`, `HowTo`, `BreadcrumbList`, injected per page. |

**Adding a page?** Add it to the `PAGES` array in `build.mjs`. The sitemap is
generated from that array, so a page missing from it is a page missing from the
sitemap.

**Canonical URLs use clean paths** (`/guide`, not `/guide.html`) because
Cloudflare Pages serves `guide.html` at `/guide` and 301-redirects the `.html`
form. Pointing a canonical at a URL that redirects wastes the signal. If you
ever move off Pages to a host that doesn't do this rewrite, change the `path`
values in `PAGES` and the internal links in `site/data/site.json` together.

## Regenerating the share image

`og.png` is what the meta tags point at — social platforms don't render SVG. It
lives at `site/static/og.png` (committed) and is copied into `dist/` at build
time. To regenerate after changing `ogImageSvg()` in `site/scripts/seo.mjs`:

```bash
# With a proper renderer (preferred — install one of these):
npx --yes sharp-cli --input site/dist/og.svg --output site/static/og.png resize 1200 630
# or
rsvg-convert -w 1200 -h 630 site/dist/og.svg -o site/static/og.png
```

macOS without either tool: `qlmanage` renders SVG but aspect-*fills* into a
square, which crops the design. Render from a 1200×1200 canvas with the artwork
centred in the middle 630px band, then crop:

```bash
qlmanage -t -s 1200 -o /tmp square.svg
sips -c 630 1200 /tmp/square.svg.png --out site/static/og.png
```

Check the result before committing — a silently cropped share image is worse
than none. Target: 1200×630, under ~1MB.

## One-time: Google Search Console

1. Go to <https://search.google.com/search-console> and add a property.
2. Choose **Domain** property if you control DNS for `wikipilot.dev` (verifies
   all subdomains at once), otherwise **URL prefix** for `https://wikipilot.dev`.
3. Verification:
   - **Domain property** → add the TXT record it gives you to the `wikipilot.dev`
     zone in Cloudflare DNS. Nothing to change in this repo.
   - **URL prefix** → either the same DNS TXT record, or download the HTML
     verification file and drop it in `site/static/`. Anything in that folder is
     copied verbatim into `dist/`, so it'll be served at the root after deploy.
4. Once verified, **Sitemaps** → submit `sitemap.xml`.
5. **URL Inspection** → paste `https://wikipilot.dev/` → *Request indexing*.

## One-time: Bing Webmaster Tools

Bing feeds Copilot and several other answer engines, so this is worth the ten
minutes.

1. Go to <https://www.bing.com/webmasters> and sign in.
2. Easiest path: **Import from Google Search Console** — one OAuth click and it
   copies the property and sitemap over. Do that if GSC is already set up.
3. Manual path: **Add a site** → `https://wikipilot.dev` → verify by one of:
   - **XML file** — download `BingSiteAuth.xml`, put it in `site/static/`,
     rebuild, deploy. It'll be live at `https://wikipilot.dev/BingSiteAuth.xml`.
   - **Meta tag** — add to `layout.mjs` in the `<head>`, above the OG block:
     ```js
     <meta name="msvalidate.01" content="YOUR_VERIFICATION_ID">
     ```
   - **CNAME** — add the record Bing gives you in Cloudflare DNS.
4. **Sitemaps** → submit `https://wikipilot.dev/sitemap.xml`.
5. **Configure My Site → Crawl Control** — leave the default unless you see
   crawl pressure, which you won't at this size.

### IndexNow (Bing, Yandex, Seznam — instant recrawl)

IndexNow pings participating engines the moment a URL changes, instead of
waiting for a crawl. Bing Webmaster Tools generates the key for you under
**IndexNow**.

1. Generate the key in Bing Webmaster Tools. It's a hex string, e.g. `a1b2c3…`.
2. Save it as `site/static/<key>.txt`, containing the key and nothing else. The
   build copies it to the root, which is how engines verify you own the domain.
3. After a deploy, submit the changed URLs:

```bash
KEY=your-key-here
curl -X POST https://api.indexnow.org/IndexNow \
  -H "Content-Type: application/json" \
  -d "{
    \"host\": \"wikipilot.dev\",
    \"key\": \"$KEY\",
    \"keyLocation\": \"https://wikipilot.dev/$KEY.txt\",
    \"urlList\": [
      \"https://wikipilot.dev/\",
      \"https://wikipilot.dev/guide\",
      \"https://wikipilot.dev/pricing\",
      \"https://wikipilot.dev/cloud\"
    ]
  }"
```

A `200` or `202` means accepted. Don't submit unchanged URLs repeatedly — it's
rate-limited and pointless.

## Answer engines (AEO/GEO)

Traditional SEO gets you ranked; answer engines need something quotable. What's
in place and what to keep doing:

- **`llms.txt`** at the root, generated from `site.json` and `faq.json`. Keep it
  factual — every line should be something you'd defend in writing.
- **`FAQPage` JSON-LD** on `/pricing` (full FAQ) and `/` (first four). This is
  the highest-leverage structured data here: assistants quote Q&A pairs directly.
- **`SoftwareApplication` JSON-LD** on `/` with `featureList`, `offers`, and
  `softwareRequirements` — the fields that answer "what is it, what does it cost,
  what do I need."
- **`HowTo` JSON-LD** on `/guide` with the four install-to-preview steps.
- **Answer the question in the first two sentences** of any new FAQ entry, before
  elaborating. Assistants extract the opening, not the paragraph that builds to a
  conclusion.
- **Write the question the way a person types it.** "Do I need an API key to use
  it?" beats "API key requirements."

When adding an FAQ entry to `site/data/faq.json`, it flows into the page, the
`FAQPage` schema, and `llms.txt` automatically. One edit, three places.

## After each deploy

1. `cd site && npm run build` — confirm no `warning: no site/static/og.png`.
2. Spot-check the deployed output:
   ```bash
   curl -s https://wikipilot.dev/robots.txt | head -3
   curl -s https://wikipilot.dev/sitemap.xml | grep -c "<loc>"     # expect 4
   curl -sI https://wikipilot.dev/og.png | head -1                 # expect 200
   curl -s https://wikipilot.dev/ | grep -o 'rel="canonical"[^>]*'

   # Every canonical assumes Pages serves guide.html at /guide. Verify it does:
   curl -sI https://wikipilot.dev/guide | head -1                  # expect 200
   ```
   If that last one returns 404, this host doesn't do the extensionless rewrite.
   Revert the `path` values in `PAGES` (`site/scripts/build.mjs`) and the nav and
   footer hrefs in `site/data/site.json` to the `.html` form — together, or the
   canonicals and the links disagree.
3. If pages changed materially, fire the IndexNow request above.
4. Validate structured data — paste a URL into:
   - <https://search.google.com/test/rich-results>
   - <https://validator.schema.org/>

## The www duplicate

The `wikipilot-site` Pages project is attached to **both** `wikipilot.dev` and
`www.wikipilot.dev`, and both return `200` directly — neither redirects. So the
same content is reachable on two hostnames.

Every page's `rel="canonical"` points at the apex (`https://wikipilot.dev/...`),
which is what tells search engines to consolidate on one. That's sufficient, and
it's why the canonical tag matters here more than usual.

If you want to remove the ambiguity entirely, add a bulk redirect or a redirect
rule in Cloudflare: `www.wikipilot.dev/*` → `https://wikipilot.dev/$1`, 301.
Optional — the canonical already handles the SEO side.

**Deploying:**

```bash
cd site && npm run deploy      # build + wrangler pages deploy dist
```

Cloudflare serves HTML with `cache-control: max-age=0, must-revalidate`, but
edges can still hand you one stale response right after a deploy. If a fetch
looks like the old build, re-request with a cache-busting query
(`curl "https://wikipilot.dev/?cb=1"`) before concluding the deploy failed.

## Two things that look broken but aren't

**`curl` shows no email address on the live pages.** Cloudflare's Email Address
Obfuscation (Scrape Shield) rewrites `mailto:` links at the edge into
`/cdn-cgi/l/email-protection#…`, and browsers decode them with JavaScript. Real
visitors see `guysites1@gmail.com` and the link works. Verify in a browser, not
with `curl`.

Worth knowing what it does *not* touch: the address stays plaintext inside the
JSON-LD `Organization.email` and in `llms.txt`, because obfuscation only applies
to rendered HTML. So search engines and answer engines still get the real
address while scrapers get the obfuscated one. That's the outcome you want —
don't "fix" it.

**Assets are content-hashed.** `styles.css?v=<hash>` and `client.js?v=<hash>`,
computed from file contents in `build.mjs`. Without this, browsers keep serving
the previously cached CSS after a deploy — the new HTML renders against old
styles, which looks like a layout bug and is invisible to `curl` (which doesn't
use the browser cache). If you add another asset, hash it the same way via
`copyHashedAsset()`.

## Known gaps

- **No analytics.** Nothing measures whether any of this works. Cloudflare Web
  Analytics is free and cookieless if you want a signal; it's a `<script>` in
  `layout.mjs` plus a token.
- **`lastmod` is the build date, not the content date.** Every page claims to
  have changed whenever the site was rebuilt. Fine at this size; if the sitemap
  grows, track real per-page modification times instead.
- **The `baseUrl` in `site.json` is the single source of truth** for canonicals,
  the sitemap, `og:url`, and `llms.txt`. Change it there and only there.
