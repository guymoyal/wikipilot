import { DEFAULT_PRESET, PRESETS, isWikiPreset, type WikiPreset } from "./config.js";

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
  /** Key for this run — from the environment/.env, or freshly typed. */
  apiKey?: string;
  /** The user asked for a freshly-typed key to be persisted to the repo's .env. */
  saveKey: boolean;
}

/** Commander tri-state: `--ai` → true, `--no-ai` → false, neither → undefined. */
export interface AiOptions {
  ai?: boolean;
}

const YES = /^(y|yes)$/i;
const NO = /^(n|no)$/i;

/**
 * Decides whether init runs the AI deep-investigation pass, and with which key.
 * Non-interactive runs never prompt: they need an explicit `--ai` plus a key
 * already in the environment, so CI can't hang and can't spend money by accident.
 */
export async function resolveAiPlan(
  options: AiOptions,
  io: PromptIO,
  envKey: string | undefined,
): Promise<AiPlan> {
  if (options.ai === false) return { enabled: false, saveKey: false };

  if (!io.interactive) {
    if (options.ai === true && envKey) return { enabled: true, apiKey: envKey, saveKey: false };
    return { enabled: false, saveKey: false };
  }

  if (options.ai === undefined) {
    const answer = (await io.ask("\nRun the AI deep investigation now? [Y/n] ")).trim();
    if (answer && !YES.test(answer)) {
      if (!NO.test(answer)) io.print("  Taking that as a no.");
      return { enabled: false, saveKey: false };
    }
  }

  if (envKey) return { enabled: true, apiKey: envKey, saveKey: false };

  io.print("  This needs an Anthropic API key (console.anthropic.com/settings/keys).");
  const typed = (await io.ask("  Paste your Anthropic API key: ")).trim();
  if (!typed) {
    io.print("  No key — keeping the mechanical draft. Re-run with a key to upgrade it.");
    return { enabled: false, saveKey: false };
  }

  const save = (await io.ask("  Save it to .env for next time? [y/N] ")).trim();
  return { enabled: true, apiKey: typed, saveKey: YES.test(save) };
}
