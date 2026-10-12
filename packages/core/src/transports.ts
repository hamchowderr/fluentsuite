import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { type StdioServerHandle, serveStdio } from "@modelcontextprotocol/server/stdio";
import type { FluentSuiteConfig } from "./config.js";
import type { ServerFactory } from "./server.js";

/** Serve over stdio (Claude Desktop, Claude Code). Logs go to stderr only. */
export function runStdio(factory: ServerFactory): StdioServerHandle {
  const handle = serveStdio(() => factory());
  factory.logger.info("FluentSuite listening on stdio", {
    products: factory.products.map((p) => p.id),
    writes: factory.guard.writesEnabled,
  });
  return handle;
}

/** The web-standard handler, for runtimes with their own HTTP layer. Stateless per request. */
export function createHttpHandler(factory: ServerFactory): McpHttpHandler {
  return createMcpHandler(() => factory());
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function bearerMatches(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match?.[1]) return false;
  const given = Buffer.from(match[1].trim());
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export interface HttpServerHandle {
  server: Server;
  url: string;
  close(): Promise<void>;
}

/**
 * Serve Streamable HTTP for hosted use.
 *
 * - Stateless: a fresh MCP server instance per request, no sessions (MCP 2026-07-28).
 * - Loopback binds get DNS-rebinding protection (Host and Origin checks).
 * - Non-loopback binds refuse to start without a bearer token; every request must carry it.
 * - `GET /healthz` answers without auth and reveals nothing about the site.
 */
export async function startHttp(
  factory: ServerFactory,
  http: FluentSuiteConfig["http"],
): Promise<HttpServerHandle> {
  const loopback = LOOPBACK.has(http.host);
  if (!loopback && !http.token) {
    throw new Error(
      `Refusing to listen on ${http.host} without http.token (FLUENTSUITE_HTTP_TOKEN). Bind 127.0.0.1 or set a token.`,
    );
  }
  const handler = createHttpHandler(factory);
  const nodeHandler = toNodeHandler(handler);
  const validateHost = loopback
    ? localhostHostValidation()
    : http.allowedHosts.length
      ? hostHeaderValidation(http.allowedHosts)
      : null;
  const validateOrigin = loopback ? localhostOriginValidation() : null;

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/healthz" && req.method === "GET") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (path !== http.path) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (validateHost && !validateHost(req, res)) return;
    if (validateOrigin && !validateOrigin(req, res)) return;
    if (http.token && !bearerMatches(req, http.token)) {
      sendJson(
        res,
        401,
        { error: "unauthorized" },
        { "WWW-Authenticate": 'Bearer realm="fluentsuite"' },
      );
      return;
    }
    void nodeHandler(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(http.port, http.host, () => resolve());
  });
  const address = server.address() as AddressInfo;
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  const url = `http://${host}:${address.port}${http.path}`;
  factory.logger.info("FluentSuite listening on Streamable HTTP", {
    url,
    products: factory.products.map((p) => p.id),
    writes: factory.guard.writesEnabled,
    auth: http.token ? "bearer" : "none (loopback)",
  });
  return {
    server,
    url,
    close: async () => {
      await handler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
