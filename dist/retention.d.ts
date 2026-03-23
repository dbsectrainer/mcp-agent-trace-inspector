import { DatabaseSync } from "node:sqlite";
export interface RetentionResult {
  archived: number;
  deleted: number;
}
/**
 * Applies retention policy:
 * - Marks traces older than `retentionDays` as archived (archived=1)
 * - Deletes archived traces that are older than 2× retentionDays (plus their steps)
 *
 * Returns counts of archived and deleted traces.
 */
export declare function applyRetentionPolicy(
  db: DatabaseSync,
  retentionDays: number,
): RetentionResult;
