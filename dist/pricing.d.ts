export interface ModelPricing {
  input: number;
  output: number;
}
export interface PricingTable {
  [modelName: string]: ModelPricing;
}
export declare const DEFAULT_PRICING: PricingTable;
export declare function loadPricingTable(filePath: string): PricingTable;
export declare function estimateCost(
  tokenCount: number,
  model: string,
  pricing: PricingTable,
): number | null;
