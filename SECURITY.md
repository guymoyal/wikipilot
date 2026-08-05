# Security policy

## Reporting a vulnerability

Email **guysites1@gmail.com** with the details. Please don't open a public issue
for anything exploitable — send it privately first and give me a chance to ship
a fix.

Useful things to include: what an attacker can do, the steps to reproduce it, and
the version or commit you tested. A proof of concept helps but isn't required.

I'll acknowledge within a few days. This is a small project maintained by one
person, so there's no formal SLA and no bug bounty — but real reports get real
fixes and credit in the release notes if you want it.

## Supported versions

Fixes land on the latest published version. There are no long-term support
branches.

## Threat model

Worth being explicit about what this tool does and doesn't defend against.

**wikipilot reads untrusted repositories.** `wikipilot init` scans a repo's
README, package manifest, and directory tree and turns them into wiki page
content. Anything drafted from a repo you don't control should be treated as
untrusted input — it's escaped when rendered, but review generated content
before publishing it.

**The built site is static.** `wikipilot build` emits plain HTML/CSS/JS with no
server-side code. It executes nothing at request time.

**`wikipilot serve` is a local preview server.** It binds to `127.0.0.1` and
serves only files inside the built output directory. It is not hardened for
public hosting — use a real web server for that.

**`wikipilot init` can spend an API key too.** The optional deep-investigation
pass is a bounded one-shot run from your terminal: the key comes from your
environment or the repo's `.env`, and its tool loop is capped in turns and
bytes read. Where the conversation goes depends on `--provider`: with the
default (Anthropic), requests go to the Anthropic API; choosing `openai` or
`gemini` sends the conversation and that provider's key to that provider's
own endpoint; choosing `custom` sends both to whatever OpenAI-compatible URL
you pass as `--base-url` — only point it at an endpoint you trust. If you
choose to save a typed key, init appends it to `.env` and makes sure `.env`
is gitignored.

**`wikipilot agent` spends your Anthropic API key.** It binds to `127.0.0.1` by
default. Exposing it (`--host 0.0.0.0`) means anyone who can reach the port can
make model calls billed to you. If you do expose it, put it behind
authentication and restrict `--allow-origin` to your own site. Browser origins
other than localhost are rejected unless you allow them explicitly, and
`--allow-origin '*'` lets any website on the internet spend your key.

**Wiki content reaches the assistant's context.** The assistant answers from the
wiki's own pages, so anyone who can edit the wiki can influence its answers.
Treat wiki write access as equivalent to influencing assistant output.
