export declare function handleListPrompts(): {
  prompts: Array<{
    name: string;
    description: string;
    arguments: Array<{
      name: string;
      description: string;
      required: boolean;
    }>;
  }>;
};
export declare function handleGetPrompt(
  name: string,
  args: Record<string, string> | undefined,
): {
  description: string;
  messages: Array<{
    role: string;
    content: {
      type: string;
      text: string;
    };
  }>;
};
