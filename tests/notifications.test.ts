import { describe, it, expect, vi, afterEach } from "vitest";
import { safeNotify } from "../src/notifications.js";

describe("safeNotify", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does nothing when no server is supplied", async () => {
    await expect(
      safeNotify(undefined, {
        method: "notifications/message",
        params: { level: "info", data: "ignored" },
      }),
    ).resolves.toBeUndefined();
  });

  it("delivers notifications when the server supports them", async () => {
    const notification = vi.fn().mockResolvedValue(undefined);
    await safeNotify({ notification } as never, {
      method: "notifications/message",
      params: { level: "info", data: "hello" },
    });
    expect(notification).toHaveBeenCalledTimes(1);
  });

  it("swallows transport failures and logs a warning", async () => {
    const notification = vi
      .fn()
      .mockRejectedValue(new Error("transport closed"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      safeNotify({ notification } as never, {
        method: "notifications/message",
        params: { level: "info", data: "hello" },
      }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to send MCP notification"),
    );
  });
});
