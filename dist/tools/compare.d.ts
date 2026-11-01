import { DatabaseSync } from "node:sqlite";
export interface CompareTracesArgs {
  trace_id_a: string;
  trace_id_b: string;
}
export declare function handleCompareTraces(
  db: DatabaseSync,
  args: CompareTracesArgs,
): {
  content: Array<{
    type: string;
    text: string;
  }>;
};
