import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { getPackageVersion } from "../src/version.js";

describe("getPackageVersion", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(getPackageVersion()).toBe(pkg.version);
  });

  it("returns a semver-like string", () => {
    expect(getPackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
