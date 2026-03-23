import { describe, it, expect } from "vitest";
import { handleListPrompts, handleGetPrompt } from "../src/prompts.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

describe("Prompts handler", () => {
  it("lists the analyze-trace prompt", () => {
    const result = handleListPrompts();
    expect(result.prompts).toHaveLength(1);

    const prompt = result.prompts[0];
    expect(prompt.name).toBe("analyze-trace");
    expect(prompt.description).toBeTruthy();
    expect(prompt.arguments).toHaveLength(1);
    expect(prompt.arguments[0].name).toBe("trace_id");
    expect(prompt.arguments[0].required).toBe(true);
  });

  it("returns the analyze-trace prompt template with trace_id substituted", () => {
    const result = handleGetPrompt("analyze-trace", {
      trace_id: "abc-123-def-456",
    });

    expect(result.description).toBeTruthy();
    expect(result.messages).toHaveLength(1);

    const msg = result.messages[0];
    expect(msg.role).toBe("user");
    expect(msg.content.type).toBe("text");
    expect(msg.content.text).toContain("abc-123-def-456");
    // Should not contain unsubstituted placeholder
    expect(msg.content.text).not.toContain("{{trace_id}}");
  });

  it("returns template with placeholder when no trace_id argument provided", () => {
    const result = handleGetPrompt("analyze-trace", undefined);

    const text = result.messages[0].content.text;
    expect(text).toContain("<trace_id>");
    expect(text).not.toContain("{{trace_id}}");
  });

  it("returns template with placeholder when empty args provided", () => {
    const result = handleGetPrompt("analyze-trace", {});

    const text = result.messages[0].content.text;
    expect(text).toContain("<trace_id>");
  });

  it("throws McpError for unknown prompt name", () => {
    expect(() => handleGetPrompt("nonexistent-prompt", {})).toThrow(McpError);
  });

  it("prompt template includes investigation sections", () => {
    const result = handleGetPrompt("analyze-trace", { trace_id: "test-id" });
    const text = result.messages[0].content.text;

    expect(text).toContain("Performance Analysis");
    expect(text).toContain("Error Detection");
    expect(text).toContain("Reasoning Chain");
    expect(text).toContain("Optimization");
    expect(text).toContain("get_trace_summary");
  });
});
