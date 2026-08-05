# Multi-provider init investigation — design

**Date:** 2026-08-05
**Goal:** `wikipilot init` works with the user's model of choice: the wizard asks which provider (Claude / OpenAI / Gemini / custom OpenAI-compatible), prompts for the matching API key, and runs the deep investigation through that provider. Keys can be used for one run only (never written to the project) — that behaviour already exists and is preserved per provider.

## Decisions made with the user

- Full multi-provider, not just a Claude model picker.
- Ephemeral keys stay the default: pasting a key uses it for this run; "Save it to .env?" defaults to No. When saved, it goes under the *provider's* env var.
- Claude (`claude-sonnet-5`) remains the default and the best-tested path — the wizard's first option.

## Architecture: one OpenAI-compatible adapter, not three SDKs

The investigation loop already speaks Anthropic's message format through one injected function:
`CreateMessage = (req: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>` (`src/lib/investigate.ts`).

We keep the loop untouched and add a fetch-based adapter that satisfies that same signature against any OpenAI-compatible `/chat/completions` endpoint. That single adapter covers OpenAI, Gemini (Google's compatibility endpoint), OpenRouter, Ollama, LM Studio — anything speaking the de-facto standard. No new npm dependencies (Node ≥18 has fetch).

### Provider registry (`src/lib/providers.ts`, new)

| id | label | env var | default model | base URL |
|---|---|---|---|---|
| `anthropic` | Claude (recommended) | `ANTHROPIC_API_KEY` | `claude-sonnet-5` | — (Anthropic SDK) |
| `openai` | OpenAI | `OPENAI_API_KEY` | `gpt-5.5` | `https://api.openai.com/v1` |
| `gemini` | Google Gemini | `GEMINI_API_KEY` | `gemini-3.5-flash` | `https://generativelanguage.googleapis.com/v1beta/openai` |
| `custom` | Other (OpenAI-compatible) | `WIKI_INIT_API_KEY` | none — user must supply | user must supply |

Model IDs verified against provider docs on 2026-08-05.

### Adapter translation rules (`createOpenAICompatMessage`)

Anthropic request → OpenAI request:
- `system` text blocks → one leading `{role:"system"}` message (concatenated; `cache_control` dropped — OpenAI and Gemini cache implicitly).
- user message content: text blocks → user message; `tool_result` blocks → one `{role:"tool", tool_call_id, content}` message each (stringify non-string content; propagate error text as content).
- assistant content: text blocks → `content`; `tool_use` blocks → `tool_calls[{id, type:"function", function:{name, arguments: JSON.stringify(input)}}]`.
- `tools` → `[{type:"function", function:{name, description, parameters: input_schema}}]`.
- `max_tokens` → `max_completion_tokens`; if the endpoint 400s mentioning that param, retry once with `max_tokens` (Gemini/older servers).

OpenAI response → Anthropic `Message`:
- `content` string → one text block; `tool_calls` → `tool_use` blocks with `input: JSON.parse(arguments)` (parse failure → `{}` so the tool layer reports the error conversationally).
- `finish_reason`: `tool_calls` → `tool_use`, `length` → `max_tokens`, else `end_turn`.
- `usage`: `prompt_tokens` → `input_tokens`, `completion_tokens` → `output_tokens`, `prompt_tokens_details.cached_tokens` → `cache_read_input_tokens` (0 when absent).
- Non-2xx → throw with status + response-body excerpt so the CLI surfaces a real reason.

## Wizard flow (`src/lib/wizard.ts`)

After the existing "Run the AI deep investigation now?" yes:

1. **Provider question** (new): numbered list from the registry, default 1 (Claude). Skipped when `--provider` was passed.
2. **Key resolution** (per provider): use the provider's env var from the environment/.env if present; otherwise prompt to paste, then the existing "Save it to .env for next time? [y/N]" — writing under the provider's var name.
3. **Custom provider** additionally prompts for base URL and model (both required).

`AiPlan` grows `provider`, `model?`, `baseUrl?`. `resolveAiPlan(options, io, env)` now takes the whole env lookup instead of a single pre-resolved key. Non-interactive runs need `--ai` plus the chosen provider's key already in the environment — unchanged spirit: CI can't hang or spend by accident.

## CLI (`src/bin/wikipilot.ts`)

- New `init` flags: `--provider <anthropic|openai|gemini|custom>`, `--base-url <url>` (custom only). `--model` already exists and now defaults per provider.
- `.env` saving writes the provider's env var (today it hardcodes `ANTHROPIC_API_KEY` — check `src/lib/env.ts` and generalize).

## investigate.ts changes

- `InvestigateOptions` gains `provider?`, `baseUrl?`. When `createMessage` isn't injected: `anthropic` → existing SDK path; anything else → the adapter.
- Default model resolves from the provider registry when unset (`WIKI_INIT_MODEL` still overrides).
- Read budget: unchanged rule (haiku → 512 KB, else 2 MB).
- The cost readout stays Claude-only (it already keys off `claude-sonnet-5`); other providers just get the token counts.
- Cache marking (`withCacheMark`, `cache_control` on system) is harmless to leave — the adapter strips it.

## Docs and site

- README: the AI-pass section documents the provider choice, env vars table, and that Claude is the default/best-tested. `.env.example` gains the new var names, commented.
- Site (separate private repo `wikipilot-web`): guide's AI-pass section + "Do I need an API key?" FAQ mention OpenAI/Gemini/any OpenAI-compatible endpoint. Deployed after the CLI ships.

## Testing

- Adapter unit tests with a scripted `fetch`: request translation (system, tool_result, tool_use round-trips), response translation (tool_calls, finish_reasons, usage), the max_tokens retry, error surfacing, malformed tool arguments.
- Wizard tests: provider selection by number and name, default on Enter, per-provider env-var pickup, ephemeral vs saved key, custom-provider prompts, non-interactive rules.
- investigate tests: adapter-backed run end-to-end with scripted fetch writing a page and finishing.
- Existing 91 tests keep passing.

## Non-goals

- The ask-the-wiki assistant (`wikipilot agent`) stays Anthropic-only for now.
- No per-provider prompt tuning; the investigation prompt is shared.
- No streaming, no provider SDKs as dependencies.
- No change to the mechanical (no-AI) path.
