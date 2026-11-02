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
export declare function exportToOTLP(db: DatabaseSync, traceId: string): OTLPTrace;
export declare function exportAllOTLP(db: DatabaseSync): OTLPTrace[];
export interface OTLPAttributeValue {
    stringValue?: string;
    intValue?: string;
    doubleValue?: number;
    boolValue?: boolean;
}
export interface OTLPAttribute {
    key: string;
    value: OTLPAttributeValue;
}
export interface OTLPDocumentSpan {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    name: string;
    kind: number;
    startTimeUnixNano: string;
    endTimeUnixNano: string;
    attributes: OTLPAttribute[];
    status: {
        code: number;
        message?: string;
    };
}
export interface OTLPExportDocument {
    resourceSpans: Array<{
        resource: {
            attributes: OTLPAttribute[];
        };
        scopeSpans: Array<{
            scope: {
                name: string;
                version: string;
            };
            spans: OTLPDocumentSpan[];
        }>;
    }>;
}
/**
 * Build an OTLP/JSON export document (resourceSpans → scopeSpans → spans)
 * suitable for sending to an OTLP-compatible backend or collector.
 *
 * When `traceId` is omitted all traces are exported. Exported span IDs are
 * stable hashes of the local trace/step IDs; no runtime state is inferred.
 */
export declare function exportOtlpDocument(db: DatabaseSync, traceId?: string): OTLPExportDocument;
