import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import type * as z from "zod/v4";
import { describeError } from "./errors.js";
import type { Logger } from "./logger.js";
import type { SafetyGuard } from "./safety.js";

/** What every tool handler receives besides its arguments. */
export interface ToolContext {
  /** Aborted when the client cancels the request. Pass it to every REST call. */
  signal: AbortSignal;
  guard: SafetyGuard;
  logger: Logger;
}

export interface ToolResult<O> {
  /** Short, human-readable answer. This is what most models read. */
  text: string;
  /** Machine-readable result, validated against `output` when declared. */
  structured?: O;
}

export type ToolKind = "read" | "write";

/**
 * A task-shaped tool. One tool does one whole job (for example "contact profile by email"),
 * instead of mirroring one REST endpoint.
 */
export interface ToolDefinition<I extends z.ZodObject = z.ZodObject, O = unknown> {
  name: string;
  title: string;
  description: string;
  kind: ToolKind;
  /** Deletes or irreversibly changes data (write tools only). */
  destructive?: boolean;
  /** Calling twice with the same arguments has no extra effect. */
  idempotent?: boolean;
  /** Sends or schedules email: listed only when writes AND sending are enabled. */
  sendsEmail?: boolean;
  input: I;
  output?: z.ZodType<O>;
  /** MCP Apps view rendered for this tool's results. */
  ui?: { resourceUri: string };
  handler: (args: z.infer<I>, ctx: ToolContext) => Promise<ToolResult<O>>;
}

/** Identity helper that keeps the handler's argument types tied to the input schema. */
export function defineTool<I extends z.ZodObject, O>(
  def: ToolDefinition<I, O>,
): ToolDefinition<I, O> {
  return def;
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool lists need an erased type.
export type AnyToolDefinition = ToolDefinition<any, any>;

export function toCallToolResult<O>(result: ToolResult<O>): CallToolResult {
  const out: CallToolResult = { content: [{ type: "text", text: result.text }] };
  if (result.structured !== undefined) {
    out.structuredContent = result.structured as Record<string, unknown>;
  }
  return out;
}

export function errorResult(error: unknown): CallToolResult {
  const { code, text } = describeError(error);
  return {
    content: [{ type: "text", text: `Error (${code}): ${text}` }],
    isError: true,
  };
}

/**
 * Register tools on a server. Write tools are skipped entirely while writes are disabled, so a
 * read-only server never even advertises them. Errors become `isError` results with safe text.
 */
export function registerTools(
  server: McpServer,
  tools: readonly AnyToolDefinition[],
  deps: { guard: SafetyGuard; logger: Logger },
): string[] {
  const registered: string[] = [];
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  for (const tool of sorted) {
    if (tool.kind === "write" && !deps.guard.writesEnabled) continue;
    if (tool.sendsEmail && !deps.guard.sendingEnabled) continue;
    const annotations = {
      title: tool.title,
      readOnlyHint: tool.kind === "read",
      destructiveHint: tool.kind === "write" ? Boolean(tool.destructive) : false,
      idempotentHint: tool.kind === "read" ? true : Boolean(tool.idempotent),
      openWorldHint: false,
    };
    const callback = async (args: unknown, extra: { mcpReq: { signal: AbortSignal } }) => {
      const started = Date.now();
      try {
        const result = await tool.handler(args, {
          signal: extra.mcpReq.signal,
          guard: deps.guard,
          logger: deps.logger,
        });
        deps.logger.debug("tool ok", { tool: tool.name, ms: Date.now() - started });
        return toCallToolResult(result);
      } catch (error) {
        const { code } = describeError(error);
        deps.logger.warn("tool failed", { tool: tool.name, code, ms: Date.now() - started });
        return errorResult(error);
      }
    };
    const config = {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.input,
      ...(tool.output ? { outputSchema: tool.output } : {}),
      annotations,
    };
    if (tool.ui) {
      registerAppTool(
        server,
        tool.name,
        { ...config, _meta: { ui: { resourceUri: tool.ui.resourceUri } } },
        callback,
      );
    } else {
      server.registerTool(tool.name, config, callback);
    }
    registered.push(tool.name);
  }
  return registered;
}
