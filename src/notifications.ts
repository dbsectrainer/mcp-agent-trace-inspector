import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

type ServerNotification = Parameters<Server["notification"]>[0];

/**
 * Best-effort MCP notification delivery.
 *
 * Notifications (logging/progress) are advisory. A disconnected client or a
 * transport that has already closed must never turn a successful database
 * write into a reported tool failure, because clients may retry and duplicate
 * the step.
 */
export async function safeNotify(
  server: Server | undefined,
  notification: ServerNotification,
): Promise<void> {
  if (!server) return;
  try {
    await server.notification(notification);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[warn] Failed to send MCP notification: ${message}`);
  }
}
