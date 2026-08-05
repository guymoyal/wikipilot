import { DEFAULT_PRESET, PRESETS, isWikiPreset, type WikiPreset } from "./config.js";
import { PROVIDERS, PROVIDER_IDS, isProviderId, type ProviderId } from "./providers.js";

export interface PresetChoice {
  preset: WikiPreset;
  label: string;
  blurb: string;
}

export const PRESET_CHOICES: PresetChoice[] = [
  {
    preset: "all",
    label: "Everything",
    blurb: "Technical and user guide together — both audiences, one wiki.",
  },
  {
    preset: "technical",
    label: "Technical",
    blurb: "For people working on this codebase — architecture, dependencies, internals.",
  },
  {
    preset: "user-guide",
    label: "User guide",
    blurb: "For people using what it produces — install, guides, FAQ, troubleshooting.",
  },
];

/** Injected so the prompt is testable without a real TTY. */
export interface PromptIO {
  interactive: boolean;
  ask(question: string): Promise<string>;
  print(line: string): void;
}

export interface PresetOptions {
  preset?: string;
  yes?: boolean;
}

export const MAX_PROMPT_ATTEMPTS = 3;

/**
 * Decides which wiki type to draft. An explicit `--preset` always wins; `--yes`
 * and non-interactive stdin fall back to the default rather than blocking, so
 * CI never hangs waiting on a prompt nobody can answer.
 */
export async function resolvePreset(options: PresetOptions, io: PromptIO): Promise<WikiPreset> {
  if (options.preset) {
    if (!isWikiPreset(options.preset)) {
      throw new Error(`unknown preset "${options.preset}" — expected one of: ${PRESETS.join(", ")}`);
    }
    return options.preset;
  }

  if (options.yes || !io.interactive) return DEFAULT_PRESET;

  io.print("\nWhat kind of wiki should this be?\n");
  PRESET_CHOICES.forEach((choice, i) => {
    io.print(`  ${i + 1}) ${choice.label}`);
    io.print(`     ${choice.blurb}\n`);
  });

  for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt++) {
    const answer = (await io.ask(`Choose 1-${PRESET_CHOICES.length} [1]: `)).trim().toLowerCase();
    if (!answer) return PRESET_CHOICES[0].preset;

    const byNumber = PRESET_CHOICES[Number(answer) - 1];
    if (byNumber && /^\d+$/.test(answer)) return byNumber.preset;
    if (isWikiPreset(answer)) return answer;

    io.print(`  Not one of the options — enter 1-${PRESET_CHOICES.length}.`);
  }

  io.print(`  Falling back to ${PRESET_CHOICES[0].label}.`);
  return PRESET_CHOICES[0].preset;
}

export interface AiPlan {
  enabled: boolean;
  provider: ProviderId;
  /** Only set for a custom provider — the model the user typed. Other providers
   *  leave this undefined so `investigate` falls through to the registry default /
   *  WIKI_INIT_MODEL / --model. */
  model?: string;
  /** Only set for a custom provider — its OpenAI-compatible endpoint. */
  baseUrl?: string;
  /** Key for this run — from the environment/.env, or freshly typed. */
  apiKey?: string;
  /** The user asked for a freshly-typed key to be persisted to the repo's .env. */
  saveKey: boolean;
  /**
   * Why `enabled` is false, when it's worth naming: lets the CLI report the
   * real cause instead of defaulting to "no API key found" for every case.
   * Absent when the user simply declined, or `enabled` is true.
   */
  disabledReason?: "custom-incomplete";
}

/** Commander tri-state: `--ai` → true, `--no-ai` → false, neither → undefined. */
export interface AiOptions {
  ai?: boolean;
  provider?: string;
  baseUrl?: string;
  model?: string;
}

const YES = /^(y|yes)$/i;
const NO = /^(n|no)$/i;

/** Mirrors `resolvePreset`'s loop shape: numbered list, re-ask on a miss, fall back to the first option. */
async function askProvider(io: PromptIO): Promise<ProviderId> {
  io.print("\nWhich AI provider should draft the wiki?\n");
  PROVIDER_IDS.forEach((id, i) => {
    io.print(`  ${i + 1}) ${PROVIDERS[id].label}`);
  });

  for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt++) {
    const answer = (await io.ask(`Choose 1-${PROVIDER_IDS.length} [1]: `)).trim().toLowerCase();
    if (!answer) return PROVIDER_IDS[0];

    const byNumber = PROVIDER_IDS[Number(answer) - 1];
    if (byNumber && /^\d+$/.test(answer)) return byNumber;
    if (isProviderId(answer)) return answer;

    io.print(`  Not one of the options — enter 1-${PROVIDER_IDS.length}.`);
  }

  io.print("  Falling back to Claude.");
  return PROVIDER_IDS[0];
}

/**
 * Decides whether init runs the AI deep-investigation pass, with which provider,
 * and with which key. Non-interactive runs never prompt: they need an explicit
 * `--ai` plus a key already in the environment (and, for a custom provider, a
 * base URL and model), so CI can't hang and can't spend money by accident.
 */
export async function resolveAiPlan(
  options: AiOptions,
  io: PromptIO,
  env: Record<string, string | undefined>,
): Promise<AiPlan> {
  if (options.ai === false) return { enabled: false, provider: "anthropic", saveKey: false };

  let provider: ProviderId = "anthropic";
  const providerGiven = options.provider !== undefined;
  if (providerGiven) {
    if (!isProviderId(options.provider!)) {
      throw new Error(`unknown provider "${options.provider}" — expected one of: ${PROVIDER_IDS.join(", ")}`);
    }
    provider = options.provider!;
  }

  if (!io.interactive) {
    if (options.ai !== true) return { enabled: false, provider, saveKey: false };

    const key = env[PROVIDERS[provider].envVar];
    if (!key) return { enabled: false, provider, saveKey: false };
    if (provider === "custom" && !(options.baseUrl && options.model)) {
      return { enabled: false, provider, saveKey: false, disabledReason: "custom-incomplete" };
    }

    return {
      enabled: true,
      provider,
      apiKey: key,
      saveKey: false,
      ...(provider === "custom" ? { baseUrl: options.baseUrl, model: options.model } : {}),
    };
  }

  if (options.ai === undefined) {
    const answer = (await io.ask("\nRun the AI deep investigation now? [Y/n] ")).trim();
    if (answer && !YES.test(answer)) {
      if (!NO.test(answer)) io.print("  Taking that as a no.");
      return { enabled: false, provider, saveKey: false };
    }
  }

  if (!providerGiven) provider = await askProvider(io);
  const info = PROVIDERS[provider];

  let baseUrl: string | undefined;
  let model: string | undefined;
  if (provider === "custom") {
    // A flag already answers the question — don't make the user retype it.
    const typedBaseUrl = options.baseUrl?.trim() || (await io.ask("  OpenAI-compatible base URL: ")).trim();
    const typedModel = options.model?.trim() || (await io.ask("  Model name: ")).trim();
    if (!typedBaseUrl || !typedModel) {
      io.print("  Both a base URL and a model are required for a custom provider — keeping the mechanical draft.");
      return { enabled: false, provider, saveKey: false, disabledReason: "custom-incomplete" };
    }
    baseUrl = typedBaseUrl;
    model = typedModel;
  }

  const extra = provider === "custom" ? { baseUrl, model } : {};

  const envKey = env[info.envVar];
  if (envKey) return { enabled: true, provider, apiKey: envKey, saveKey: false, ...extra };

  const whereToGetOne = info.keyUrl ? ` — get one at ${info.keyUrl}` : "";
  io.print(`  This needs an API key (it will be read as ${info.envVar})${whereToGetOne}.`);
  const typed = (await io.ask("  Paste your API key: ")).trim();
  if (!typed) {
    io.print("  No key — keeping the mechanical draft. Re-run with a key to upgrade it.");
    return { enabled: false, provider, saveKey: false };
  }

  const save = (await io.ask("  Save it to .env for next time? [y/N] ")).trim();
  return { enabled: true, provider, apiKey: typed, saveKey: YES.test(save), ...extra };
}
