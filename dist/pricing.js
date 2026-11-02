import { readFileSync } from "fs";
export const DEFAULT_PRICING = {
    "claude-opus-4-6": { input: 0.015, output: 0.075 },
    "claude-sonnet-4-6": { input: 0.003, output: 0.015 },
    "claude-haiku-4-5": { input: 0.0008, output: 0.004 },
};
export function loadPricingTable(filePath) {
    try {
        const content = readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(content);
        if (typeof parsed !== "object" ||
            parsed === null ||
            Array.isArray(parsed)) {
            throw new Error("Pricing table must be a JSON object");
        }
        const table = parsed;
        for (const [model, pricing] of Object.entries(table)) {
            if (typeof pricing !== "object" ||
                pricing === null ||
                typeof pricing.input !== "number" ||
                typeof pricing.output !== "number") {
                throw new Error(`Invalid pricing entry for model "${model}": must have numeric input and output fields`);
            }
            const entry = pricing;
            if (!Number.isFinite(entry.input) ||
                !Number.isFinite(entry.output) ||
                entry.input < 0 ||
                entry.output < 0) {
                throw new Error(`Invalid pricing entry for model "${model}": input and output must be finite, non-negative numbers`);
            }
        }
        // Treat the custom file as an override layer: models it does not mention
        // keep their built-in rates. This avoids silently disabling cost
        // estimation (and audit cost) for the default model.
        return { ...DEFAULT_PRICING, ...table };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to load pricing table from "${filePath}": ${message}`);
    }
}
export function estimateCost(tokenCount, model, pricing) {
    const entry = pricing[model];
    if (!entry)
        return null;
    // Treat all tokens as input tokens for simple estimation
    return (tokenCount / 1000) * entry.input;
}
