export interface PageFrontmatter {
  title: string;
  description?: string;
  section: string;
  order?: number;
  sources: string[];
  last_synced: string;
  stale?: boolean;
  locale?: string;
}

function yamlScalar(value: string): string {
  if (/^[\w./-]*$/.test(value) && value.length > 0) return value;
  return JSON.stringify(value);
}

export function stringifyFrontmatter(fm: PageFrontmatter): string {
  const lines: string[] = [];
  lines.push(`title: ${yamlScalar(fm.title)}`);
  if (fm.description) lines.push(`description: ${yamlScalar(fm.description)}`);
  lines.push(`section: ${yamlScalar(fm.section)}`);
  if (fm.order !== undefined) lines.push(`order: ${fm.order}`);
  lines.push("sources:");
  for (const src of fm.sources) lines.push(`  - ${yamlScalar(src)}`);
  lines.push(`last_synced: ${yamlScalar(fm.last_synced)}`);
  if (fm.stale !== undefined) lines.push(`stale: ${fm.stale}`);
  if (fm.locale) lines.push(`locale: ${yamlScalar(fm.locale)}`);
  return lines.join("\n");
}

export function renderPage(fm: PageFrontmatter, body: string): string {
  return `---\n${stringifyFrontmatter(fm)}\n---\n\n${body.trim()}\n`;
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

export function parseFrontmatter(fileContents: string): { frontmatter: PageFrontmatter; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(fileContents);
  if (!match) {
    throw new Error("No frontmatter block found");
  }
  const [, yamlBlock, body] = match;
  const lines = yamlBlock.split("\n");

  const result: Record<string, unknown> = { sources: [] };
  let currentListKey: string | null = null;

  for (const rawLine of lines) {
    const listItem = /^\s*-\s+(.*)$/.exec(rawLine);
    if (listItem && currentListKey) {
      (result[currentListKey] as string[]).push(unquote(listItem[1]));
      continue;
    }
    const kv = /^(\w+):\s*(.*)$/.exec(rawLine);
    if (!kv) continue;
    const [, key, rest] = kv;
    if (rest === "") {
      result[key] = [];
      currentListKey = key;
      continue;
    }
    currentListKey = null;
    if (rest === "true" || rest === "false") {
      result[key] = rest === "true";
    } else if (/^-?\d+$/.test(rest)) {
      result[key] = parseInt(rest, 10);
    } else {
      result[key] = unquote(rest);
    }
  }

  const frontmatter: PageFrontmatter = {
    title: String(result.title ?? ""),
    section: String(result.section ?? ""),
    sources: Array.isArray(result.sources) ? (result.sources as string[]) : [],
    last_synced: String(result.last_synced ?? ""),
    ...(result.description ? { description: String(result.description) } : {}),
    ...(typeof result.order === "number" ? { order: result.order } : {}),
    ...(typeof result.stale === "boolean" ? { stale: result.stale } : {}),
    ...(result.locale ? { locale: String(result.locale) } : {}),
  };

  return { frontmatter, body: body ?? "" };
}
