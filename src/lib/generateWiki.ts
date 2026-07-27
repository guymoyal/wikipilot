import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanDirectory, collectExtensionStats, type ScannedDir } from "./scan.js";

export interface GenerateWikiOptions {
  sourceDir: string;
  outputDir: string;
  maxDepth?: number;
  ignore?: string[];
}

function firstParagraph(readme: string): string {
  const withoutHeading = readme.replace(/^#.*\n+/, "");
  const paragraph = withoutHeading.split(/\n\s*\n/)[0]?.trim();
  return paragraph ?? "";
}

function pageFileName(dirPath: string): string {
  if (dirPath === ".") return "index.md";
  return `${dirPath.replace(/[\\/]/g, "-")}.md`;
}

function renderDirPage(dir: ScannedDir): string {
  const lines: string[] = [`# ${dir.name}`, ""];

  if (dir.readme) {
    const summary = firstParagraph(dir.readme);
    if (summary) lines.push(summary, "");
  }

  if (dir.subdirs.length) {
    lines.push("## Subdirectories", "");
    for (const sub of dir.subdirs) {
      lines.push(`- [${sub.name}](./${pageFileName(sub.path)})`);
    }
    lines.push("");
  }

  if (dir.files.length) {
    lines.push("## Files", "");
    for (const file of dir.files) {
      lines.push(`- \`${file}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function writeDirPages(dir: ScannedDir, outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, pageFileName(dir.path)), renderDirPage(dir), "utf8");
  for (const sub of dir.subdirs) {
    writeDirPages(sub, outputDir);
  }
}

export function generateWiki(options: GenerateWikiOptions): { pagesWritten: number } {
  const tree = scanDirectory(options.sourceDir, options.sourceDir, {
    maxDepth: options.maxDepth,
    ignore: options.ignore,
  });

  mkdirSync(options.outputDir, { recursive: true });
  writeDirPages(tree, options.outputDir);

  const extStats = collectExtensionStats(tree);
  const summaryLines = [
    "# File type summary",
    "",
    ...[...extStats.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([ext, count]) => `- ${ext}: ${count}`),
  ];
  writeFileSync(join(options.outputDir, "_file-types.md"), summaryLines.join("\n"), "utf8");

  const countPages = (d: ScannedDir): number => 1 + d.subdirs.reduce((sum, s) => sum + countPages(s), 0);
  return { pagesWritten: countPages(tree) + 1 };
}
