import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Minimal .env loader — real environment variables always win over the file,
 * so an exported key can't be silently shadowed by a stale .env entry.
 */
export function loadDotEnv(repoRoot: string): void {
  const path = join(repoRoot, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([\w.-]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    const value = rawValue.replace(/^["']|["']$/g, "");
    process.env[key] = value;
  }
}

function envHasKey(envPath: string, key: string): boolean {
  if (!existsSync(envPath)) return false;
  return readFileSync(envPath, "utf8")
    .split("\n")
    .some((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
}

function gitignoreCoversEnv(gitignorePath: string): boolean {
  if (!existsSync(gitignorePath)) return false;
  return readFileSync(gitignorePath, "utf8")
    .split("\n")
    .some((line) => {
      const entry = line.trim();
      return entry === ".env" || entry === "/.env" || entry === ".env*" || entry === "*.env";
    });
}

/**
 * Persist a secret into the repo's .env, and make sure that .env is
 * gitignored so the secret can never end up in a commit. Appending (not
 * rewriting) preserves whatever else the user keeps in either file.
 */
export function saveEnvKey(repoRoot: string, key: string, value: string): void {
  const envPath = join(repoRoot, ".env");
  if (!envHasKey(envPath, key)) {
    const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    appendFileSync(envPath, `${separator}${key}=${value}\n`, "utf8");
  }

  const gitignorePath = join(repoRoot, ".gitignore");
  if (!gitignoreCoversEnv(gitignorePath)) {
    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, ".env\n", "utf8");
    } else {
      const existing = readFileSync(gitignorePath, "utf8");
      const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
      appendFileSync(gitignorePath, `${separator}.env\n`, "utf8");
    }
  }
}
