/**
 * Read the package version from the nearest package.json.
 *
 * Works from both `src/` (tsx / vitest) and the compiled `dist/` output, so
 * the MCP server always advertises the same version as the npm package.
 */
export declare function getPackageVersion(): string;
