import { readFileSync } from "fs";

export interface ModelPricing {
  input: number; // USD per 1K tokens
  output: number; // USD per 1K tokens
}

export interface PricingTable {
  [modelName: string]: ModelPricing;
}

export const DEFAULT_PRICING: PricingTable = {
  "claude-opus-4-6": { input: 0.015, output: 0.075 },
  "claude-sonnet-4-6": { input: 0.003, output: 0.015 },
  "claude-haiku-4-5": { input: 0.0008, output: 0.004 },
};

export function loadPricingTable(filePath: string): PricingTable {
  try {
    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("Pricing table must be a JSON object");
    }
    const table = parsed as Record<string, unknown>;
    for (const [model, pricing] of Object.entries(table)) {
      if (
        typeof pricing !== "object" ||
        pricing === null ||
        typeof (pricing as Record<string, unknown>).input !== "number" ||
        typeof (pricing as Record<string, unknown>).output !== "number"
      ) {
        throw new Error(
          `Invalid pricing entry for model "${model}": must have numeric input and output fields`,
        );
      }
    }
    return table as PricingTable;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to load pricing table from "${filePath}": ${message}`,
    );
  }
}

export function estimateCost(
  tokenCount: number,
  model: string,
  pricing: PricingTable,
): number | null {
  const entry = pricing[model];
  if (!entry) return null;
  // Treat all tokens as input tokens for simple estimation
  return (tokenCount / 1000) * entry.input;
}
