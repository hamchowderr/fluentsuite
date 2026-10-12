import { readdirSync, readFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { ServerFactory } from "./server.js";
import { createHttpHandler } from "./transports.js";

/** MCP Apps client capability, so servers see a UI-capable host. */
export const UI_CLIENT_EXTENSION = {
  "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
};

/**
 * Connect a real MCP client to a server factory, in process, over the 2026-07-28 protocol.
 * No port, no socket: the client transport calls the stateless HTTP handler's `fetch` directly,
 * so tests exercise exactly the code path that is deployed.
 */
export async function connectInProcess(factory: ServerFactory, options: { ui?: boolean } = {}) {
  const handler = createHttpHandler(factory);
  const transport = new StreamableHTTPClientTransport(new URL("http://fluentsuite.test/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client(
    { name: "fluentsuite-tests", version: "0.0.0" },
    {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
      capabilities: options.ui === false ? {} : { extensions: UI_CLIENT_EXTENSION },
    },
  );
  await client.connect(transport);
  return {
    client,
    async close() {
      await client.close();
      await handler.close();
    },
  };
}

/** The text of a tool result's first content block. */
export function textOf(result: { content?: unknown }): string {
  const content = result.content as Array<{ type: string; text?: string }> | undefined;
  return content?.find((c) => c.type === "text")?.text ?? "";
}

/** Third-party hosts that recorded fixtures may mention (avatars and help links in plugin responses). */
export const FIXTURE_THIRD_PARTY_HOSTS = ["www.gravatar.com", "www.youtube.com"];

/**
 * Every host or IPv4 address in the JSON files under `dir` (recursively) that is not a `*.example.test` host, one of
 * `FIXTURE_THIRD_PARTY_HOSTS`, loopback, or a documentation address (RFC 5737: 192.0.2.x, 198.51.100.x,
 * 203.0.113.x). Recorded fixtures must come back empty, so no real site leaks into the repo.
 */
export function unexpectedFixtureHosts(dir: URL): string[] {
  const found = new Set<string>();
  const scan = (d: URL) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) scan(new URL(`${e.name}/`, d));
      else if (e.name.endsWith(".json")) {
        const raw = readFileSync(new URL(e.name, d), "utf8").replaceAll("\\/", "/");
        for (const m of raw.matchAll(/[a-z][a-z0-9+.-]*:\/\/([^/"'\s?#:\\]+)/gi))
          found.add(m[1] as string);
        for (const m of raw.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) found.add(m[0]);
      }
    }
  };
  scan(dir.href.endsWith("/") ? dir : new URL(`${dir.href}/`));
  return [...found]
    .map((h) => h.toLowerCase())
    .filter(
      (h) =>
        !h.endsWith(".example.test") &&
        !FIXTURE_THIRD_PARTY_HOSTS.includes(h) &&
        !/^(127\.\d{1,3}\.\d{1,3}|192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/.test(h),
    )
    .sort();
}

/** A recorded request to the mock WordPress site. */
export interface RecordedRequest {
  method: string;
  /** Path below /wp-json/, e.g. `fluent-crm/v2/subscribers/0` */
  route: string;
  query: URLSearchParams;
  body: unknown;
}

export interface MockContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

type MockHandler = (ctx: MockContext) => unknown | Response | Promise<unknown | Response>;

/** JSON response helper for mock handlers. */
export function mockJson(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/**
 * An in-memory WordPress REST API, driven through `fetch`. Product test suites register routes
 * shaped after the plugin's REST docs; the client under test talks to it exactly as it would talk
 * to a real site (Basic auth, query encoding, JSON bodies, WP error shapes).
 *
 * Unknown routes answer with WordPress's real `rest_no_route` 404, so a tool calling an endpoint
 * the mock does not know fails loudly instead of passing by accident.
 */
export class MockWordPress {
  readonly requests: RecordedRequest[] = [];
  private readonly routes: Array<{
    method: string;
    pattern: RegExp;
    keys: string[];
    handler: MockHandler;
  }> = [];
  private readonly expectedAuth: string;

  constructor(
    readonly siteUrl = "https://crm.example.test",
    credentials = {
      username: "fluentsuite-test",
      applicationPassword: "test pass word abcd efgh ijkl",
    },
  ) {
    this.expectedAuth = `Basic ${Buffer.from(
      `${credentials.username}:${credentials.applicationPassword.replace(/\s+/g, "")}`,
    ).toString("base64")}`;
  }

  /** Register a route, e.g. `on("GET", "fluent-crm/v2/subscribers/:id", handler)`. */
  on(method: string, route: string, handler: MockHandler): this {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${route.replace(/:([a-z_]+)/g, (_m, key: string) => {
        keys.push(key);
        return "([^/]+)";
      })}$`,
    );
    this.routes.push({ method, pattern, keys, handler });
    return this;
  }

  /** Requests whose route matches, for assertions. */
  calls(method: string, route: string | RegExp): RecordedRequest[] {
    return this.requests.filter(
      (r) =>
        r.method === method &&
        (typeof route === "string" ? r.route === route : route.test(r.route)),
    );
  }

  readonly fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const prefix = "/wp-json/";
    const route = url.pathname.startsWith(prefix)
      ? url.pathname.slice(prefix.length)
      : url.pathname;
    const text = req.method === "GET" ? "" : await req.text();
    const body: unknown = text ? JSON.parse(text) : undefined;
    this.requests.push({ method: req.method, route, query: url.searchParams, body });

    if (req.headers.get("authorization") !== this.expectedAuth) {
      return mockJson(
        {
          code: "incorrect_password",
          message: "The provided password is an invalid application password.",
          data: { status: 401 },
        },
        401,
      );
    }
    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      const match = r.pattern.exec(route);
      if (!match) continue;
      const params = Object.fromEntries(
        r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1] ?? "")]),
      );
      const result = await r.handler({ params, query: url.searchParams, body });
      return result instanceof Response ? result : mockJson(result);
    }
    return mockJson(
      {
        code: "rest_no_route",
        message: "No route was found matching the URL and request method.",
        data: { status: 404 },
      },
      404,
    );
  };
}

type McpClient = Awaited<ReturnType<typeof connectInProcess>>["client"];

interface AnthropicBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
}

export interface AgentRun {
  /** The model's final text answer. */
  answer: string;
  /** Every tool call the model made, in order, with the text result it got back. */
  toolCalls: Array<{ name: string; arguments: unknown; isError: boolean; result: string }>;
}

/**
 * A minimal agent loop for agent-level tests. It speaks the Anthropic Messages wire format to a
 * model endpoint (AIMock in tests), offers the server's real tool list, executes the tool calls the
 * model makes against the real MCP server, and feeds the results back until the model answers.
 *
 * With a mocked model, the whole run is deterministic: it proves our tool names, descriptions and
 * schemas are what a model sees, and that the outputs carry what the model needs to answer.
 */
export async function runAgent(options: {
  client: McpClient;
  modelUrl: string;
  prompt: string;
  model?: string;
  maxTurns?: number;
}): Promise<AgentRun> {
  const { tools } = await options.client.listTools();
  const offered = tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema,
  }));
  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [
    { role: "user", content: options.prompt },
  ];
  const toolCalls: AgentRun["toolCalls"] = [];
  for (let turn = 0; turn < (options.maxTurns ?? 6); turn++) {
    const res = await fetch(`${options.modelUrl.replace(/\/+$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "test",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: options.model ?? "claude-test",
        max_tokens: 1024,
        stream: false,
        tools: offered,
        messages,
      }),
    });
    if (!res.ok) throw new Error(`model endpoint returned ${res.status}: ${await res.text()}`);
    const reply = (await res.json()) as { content: AnthropicBlock[]; stop_reason: string };
    messages.push({ role: "assistant", content: reply.content });
    const uses = reply.content.filter((b) => b.type === "tool_use");
    if (uses.length === 0) {
      return {
        answer: reply.content
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join(""),
        toolCalls,
      };
    }
    const results = [];
    for (const use of uses) {
      const result = await options.client.callTool({
        name: use.name ?? "",
        arguments: (use.input ?? {}) as Record<string, unknown>,
      });
      const text = textOf(result);
      toolCalls.push({
        name: use.name ?? "",
        arguments: use.input,
        isError: Boolean(result.isError),
        result: text,
      });
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: text,
        is_error: Boolean(result.isError),
      });
    }
    messages.push({ role: "user", content: results });
  }
  throw new Error("agent did not finish within maxTurns");
}
