import { DatabaseSync } from "node:sqlite";
export interface OTLPSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, string | number | boolean>;
  status: {
    code: number;
    message?: string;
  };
}
export interface OTLPTrace {
  traceId: string;
  spans: OTLPSpan[];
}
export declare function exportToOTLP(
  db: DatabaseSync,
  traceId: string,
): OTLPTrace;
export declare function exportAllOTLP(db: DatabaseSync): OTLPTrace[];
