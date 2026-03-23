/**
 * Ensures the traces table has an `archived` column.
 * If it already exists, the ALTER TABLE is a no-op.
 */
function ensureArchivedColumn(db) {
  try {
    db.exec(
      "ALTER TABLE traces ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
    );
  } catch {
    // Column already exists — ignore
  }
}
/**
 * Applies retention policy:
 * - Marks traces older than `retentionDays` as archived (archived=1)
 * - Deletes archived traces that are older than 2× retentionDays (plus their steps)
 *
 * Returns counts of archived and deleted traces.
 */
export function applyRetentionPolicy(db, retentionDays) {
  if (retentionDays <= 0) {
    return { archived: 0, deleted: 0 };
  }
  ensureArchivedColumn(db);
  const now = Date.now();
  const archiveCutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const deleteCutoff = now - 2 * retentionDays * 24 * 60 * 60 * 1000;
  // Archive traces older than retentionDays that aren't already archived
  const archiveResult = db
    .prepare(
      `UPDATE traces SET archived = 1 WHERE started_at < ? AND archived = 0`,
    )
    .run(archiveCutoff);
  const archived = archiveResult.changes;
  // Delete steps for archived traces past 2× threshold
  db.prepare(
    `DELETE FROM steps WHERE trace_id IN (
       SELECT id FROM traces WHERE archived = 1 AND started_at < ?
     )`,
  ).run(deleteCutoff);
  // Delete the archived traces past 2× threshold
  const deleteResult = db
    .prepare(`DELETE FROM traces WHERE archived = 1 AND started_at < ?`)
    .run(deleteCutoff);
  const deleted = deleteResult.changes;
  return { archived, deleted };
}
