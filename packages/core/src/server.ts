import { McpServer } from "@modelcontextprotocol/server";
import type { FluentSuiteConfig, ProductId } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { SafetyGuard } from "./safety.js";
import { registerSkills, type Skill } from "./skills.js";
import { type AnyToolDefinition, registerTools } from "./tool.js";
import { registerViews, type ViewDefinition } from "./ui/views.js";
import { type FetchLike, WordPressClient } from "./wp/client.js";

export const SERVER_NAME = "fluentsuite";
export const SERVER_VERSION = "0.1.0";

/** Everything a product needs to build its tools. Built once per process. */
export interface ProductContext {
  config: FluentSuiteConfig;
  wp: WordPressClient;
  logger: Logger;
}

/**
 * A product module (FluentCRM, FluentSMTP, …). Products are plain data plus a tool factory, so
 * the combined server and each standalone server are assembled the same way.
 */
export interface Product {
  id: ProductId;
  /** Display name, e.g. "FluentCRM". */
  title: string;
  /** One paragraph for the server instructions: what the tools cover and how to use them. */
  instructions: string;
  tools: (ctx: ProductContext) => readonly AnyToolDefinition[];
  views?: readonly ViewDefinition[];
  skills?: readonly Skill[];
}

export interface ServerFactoryOptions {
  config: FluentSuiteConfig;
  /** All products this binary ships; only those enabled in config are served. */
  products: readonly Product[];
  /** Injected for tests (mock WordPress). */
  fetch?: FetchLike;
  logger?: Logger;
}

export interface ServerFactory {
  (): McpServer;
  /** Names of the products actually served. */
  products: readonly Product[];
  guard: SafetyGuard;
  logger: Logger;
}

function instructionsFor(products: readonly Product[], guard: SafetyGuard): string {
  const mode = guard.writesEnabled
    ? `Writes are ENABLED. Every write tool previews by default (dry_run=true). Bulk (over ${guard.policy.bulkThreshold} records), destructive and email-sending actions need the user's explicit approval: show the preview, then pass the confirmation_token from it.`
    : "This server is READ-ONLY. Write tools are not available.";
  const sending = guard.sendingEnabled
    ? "Email sending is ENABLED: sending tools always preview the audience first and need a confirmation token. Never send without the user's explicit yes."
    : "Email sending is DISABLED: no tool can send or schedule email.";
  return [
    "FluentSuite: task-shaped tools for the Fluent WordPress plugins (not affiliated with WPManageNinja).",
    mode,
    sending,
    "Never invent contact data. Prefer one task-shaped call over many small ones. Paginated tools return a cursor; pass it back unchanged to get the next page.",
    ...products.map((p) => `${p.title}: ${p.instructions}`),
  ].join("\n\n");
}

/**
 * Build the per-request server factory. Both transports call it: Streamable HTTP once per request
 * (stateless), stdio once per connection. Everything expensive (config, WordPress client, safety
 * guard, skills) is created once here and shared.
 */
export function createServerFactory(options: ServerFactoryOptions): ServerFactory {
  const { config } = options;
  const logger = options.logger ?? createLogger(config.logLevel);
  const guard = new SafetyGuard(config.writes);
  const enabled = options.products.filter((p) => config.products.includes(p.id));
  const missing = config.products.filter((id) => !options.products.some((p) => p.id === id));
  if (missing.length) {
    logger.warn("products enabled in config are not available in this build", { missing });
  }
  if (!enabled.length) {
    throw new Error(
      `None of the configured products (${config.products.join(", ")}) are available.`,
    );
  }

  const wp = new WordPressClient({
    siteUrl: config.site.url,
    username: config.site.username,
    applicationPassword: config.site.applicationPassword,
    timeoutMs: config.request.timeoutMs,
    retries: config.request.retries,
    logger,
    userAgent: `FluentSuite/${SERVER_VERSION}`,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const ctx: ProductContext = { config, wp, logger };
  const tools = enabled.flatMap((p) => p.tools(ctx));
  const views = enabled.flatMap((p) => p.views ?? []);
  const skills = enabled.flatMap((p) => p.skills ?? []);
  const instructions = instructionsFor(enabled, guard);

  const factory = (() => {
    const server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION, title: "FluentSuite" },
      { instructions },
    );
    registerTools(server, tools, { guard, logger });
    registerViews(server, views);
    if (skills.length) registerSkills(server, skills);
    return server;
  }) as ServerFactory;
  factory.products = enabled;
  factory.guard = guard;
  factory.logger = logger;
  return factory;
}
