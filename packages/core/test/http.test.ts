import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { parseConfig } from "../src/config.js";
import { createServerFactory, type Product } from "../src/server.js";
import { defineTool } from "../src/tool.js";
import { type HttpServerHandle, startHttp } from "../src/transports.js";

const product: Product = {
  id: "crm",
  title: "Demo",
  instructions: "Demo.",
  tools: () => [
    defineTool({
      name: "demo_ping",
      title: "Ping",
      description: "Ping.",
      kind: "read",
      input: z.object({}),
      handler: async () => ({ text: "pong" }),
    }),
  ],
};

const TOKEN = "t".repeat(32);
let handle: HttpServerHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

function factory() {
  const config = parseConfig({
    site: { url: "https://crm.example.test", username: "u", applicationPassword: "p" },
    logLevel: "silent",
  });
  return createServerFactory({ config, products: [product] });
}

describe("Streamable HTTP transport", () => {
  it("refuses to bind a public interface without a token", async () => {
    await expect(
      startHttp(factory(), { host: "0.0.0.0", port: 0, path: "/mcp", allowedHosts: [] }),
    ).rejects.toThrow(/without http.token/);
  });

  it("requires the bearer token, serves the 2026-07-28 protocol statelessly, and exposes /healthz", async () => {
    handle = await startHttp(factory(), {
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
      token: TOKEN,
      allowedHosts: [],
    });
    const health = await fetch(handle.url.replace("/mcp", "/healthz"));
    expect(await health.json()).toEqual({ ok: true });

    const anonymous = await fetch(handle.url, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(anonymous.status).toBe(401);

    const client = new Client(
      { name: "http-test", version: "0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(handle.url), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    expect(client.getProtocolEra()).toBe("modern");
    const result = await client.callTool({ name: "demo_ping", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "pong" }]);
    await client.close();
  });

  it("blocks DNS-rebinding style Host headers on loopback binds", async () => {
    handle = await startHttp(factory(), {
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
      allowedHosts: [],
    });
    const { request } = await import("node:http");
    const url = new URL(handle.url);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: url.hostname,
          port: url.port,
          path: "/mcp",
          method: "POST",
          headers: { Host: "evil.example", "content-type": "application/json" },
        },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on("error", reject);
      req.end("{}");
    });
    expect(status).toBe(403);
  });
});
