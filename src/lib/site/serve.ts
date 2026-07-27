import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, resolve, sep } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
};

export interface ServeOptions {
  /** Defaults to loopback: this is a local preview server, not a web server. */
  host?: string;
}

/**
 * Resolves a request path inside `root`, or returns null if it escapes.
 *
 * The escape has to be checked after resolution, not by scanning the raw path
 * for "..": the path arrives percent-encoded, so `%2e%2e%2f` is only recognisable
 * as `../` once decoded, and `path.resolve` is what collapses it either way.
 */
function resolveInside(root: string, urlPath: string): string | null {
  if (urlPath.includes("\0")) return null;

  const candidate = resolve(root, urlPath.replace(/^\/+/, ""));
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

export function serveSite(outDir: string, port: number, options: ServeOptions = {}): Promise<void> {
  const root = resolve(outDir);
  const host = options.host ?? "127.0.0.1";

  return new Promise((resolveServer, reject) => {
    const server = createServer(async (req, res) => {
      const deny = (code: number, message: string) => {
        res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(message);
      };

      if (req.method !== "GET" && req.method !== "HEAD") {
        return deny(405, "Method not allowed");
      }

      let urlPath: string;
      try {
        urlPath = decodeURIComponent((req.url ?? "/").split(/[?#]/)[0]);
      } catch {
        return deny(400, "Bad request");
      }

      const requested = resolveInside(root, urlPath);
      if (!requested) return deny(403, "Forbidden");

      try {
        let filePath = requested;
        const stats = await stat(filePath).catch(() => null);
        if (stats?.isDirectory()) {
          filePath = join(filePath, "index.html");
        } else if (!stats) {
          filePath = join(filePath, "index.html");
        }

        // join() can't escape here, but re-check rather than reason about it.
        if (filePath !== root && !filePath.startsWith(root + sep)) return deny(403, "Forbidden");

        const content = await readFile(filePath);
        res.writeHead(200, {
          "Content-Type": MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(req.method === "HEAD" ? undefined : content);
      } catch {
        deny(404, "Not found");
      }
    });

    server.on("error", reject);
    server.listen(port, host, () => resolveServer());
  });
}
