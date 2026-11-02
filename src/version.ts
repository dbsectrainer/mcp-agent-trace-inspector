import { readFileSync } from "node:fs";

let cachedVersion: string | undefined;

/**
 * Read the package version from the nearest package.json.
 *
 * Works from both `src/` (tsx / vitest) and the compiled `dist/` output, so
 * the MCP server always advertises the same version as the npm package.
 */
export function getPackageVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;

  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const parsed = JSON.parse(readFileSync(pkgUrl, "utf8")) as {
      version?: unknown;
    };
    cachedVersion =
      typeof parsed.version === "string" && parsed.version.length > 0
        ? parsed.version
        : "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }

  return cachedVersion;
}
