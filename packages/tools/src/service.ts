import type {
  ToolContext,
  ToolDefinition,
  ToolResult,
  ToolService,
} from '@witcode/protocol';

function failure(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, content: '', error: message };
}

/**
 * A tiny registry. The only interesting guarantee is that `run` never throws:
 * missing tools, bad input and exceptions from `execute` all become ToolResult.
 */
export function createToolService(): ToolService {
  const tools = new Map<string, ToolDefinition>();

  return {
    register(tool: ToolDefinition): () => void {
      tools.set(tool.name, tool);
      return () => {
        // Do not unregister a newer tool that replaced this name.
        if (tools.get(tool.name) === tool) {
          tools.delete(tool.name);
        }
      };
    },

    list(): ToolDefinition[] {
      return [...tools.values()];
    },

    async run(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const tool = tools.get(name);
      if (!tool) return failure(new Error(`unknown tool: ${name}`));

      // Normalize once, before any side effect. The resolved object is the only
      // one handed to execute, so an approval preview and the real execution
      // describe the same bytes. A normalization failure is fail-closed.
      let resolved: unknown = input;
      if (tool.resolveInput) {
        try {
          resolved = await tool.resolveInput(input, ctx);
        } catch {
          return { ok: false, content: '', error: '输入无法归一化' };
        }
      }

      try {
        return await tool.execute(resolved, ctx);
      } catch (error) {
        return failure(error);
      }
    },
  };
}
