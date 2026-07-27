import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";

const DEFAULT_IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
]);

export interface ScannedDir {
  path: string;
  name: string;
  readme?: string;
  files: string[];
  subdirs: ScannedDir[];
}

export interface ScanOptions {
  ignore?: string[];
  maxDepth?: number;
}

function isIgnored(name: string, ignore: Set<string>): boolean {
  return ignore.has(name) || name.startsWith(".");
}

function findReadme(dirPath: string, entries: string[]): string | undefined {
  const readmeName = entries.find((e) => /^readme\.md$/i.test(e));
  if (!readmeName) return undefined;
  try {
    return readFileSync(join(dirPath, readmeName), "utf8");
  } catch {
    return undefined;
  }
}

export function scanDirectory(
  rootPath: string,
  dirPath: string = rootPath,
  options: ScanOptions = {},
  depth = 0
): ScannedDir {
  const ignore = new Set([...DEFAULT_IGNORE, ...(options.ignore ?? [])]);
  const maxDepth = options.maxDepth ?? Infinity;

  const entries = readdirSync(dirPath);
  const files: string[] = [];
  const subdirs: ScannedDir[] = [];

  for (const entry of entries) {
    if (isIgnored(entry, ignore)) continue;
    const fullPath = join(dirPath, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      if (depth < maxDepth) {
        subdirs.push(scanDirectory(rootPath, fullPath, options, depth + 1));
      }
    } else if (stat.isFile()) {
      files.push(entry);
    }
  }

  return {
    path: relative(rootPath, dirPath) || ".",
    name: dirPath === rootPath ? "." : basename(dirPath),
    readme: findReadme(dirPath, entries),
    files: files.sort(),
    subdirs: subdirs.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function collectExtensionStats(dir: ScannedDir, stats = new Map<string, number>()): Map<string, number> {
  for (const file of dir.files) {
    const ext = extname(file) || "(no extension)";
    stats.set(ext, (stats.get(ext) ?? 0) + 1);
  }
  for (const sub of dir.subdirs) {
    collectExtensionStats(sub, stats);
  }
  return stats;
}
