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
