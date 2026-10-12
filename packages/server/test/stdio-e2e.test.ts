import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { textOf } from "@fluentsuite/core/testing";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockFluentCrm } from "../../crm/test/mock-fluentcrm.js";

/**
 * End to end: spawn the built `fluentsuite` binary over stdio, exactly as Claude Desktop does,
 * pointed at the mock FluentCRM site served over real HTTP. Requires `pnpm build` (CI does it).
 */
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const built = existsSync(bin);
if (!built && process.env.CI)
  throw new Error("packages/server/dist/bin.js is missing: run pnpm build first");

describe.skipIf(!built)("fluentsuite binary over stdio", () => {
  const mock = createMockFluentCrm();
  let site: Server;
  let siteUrl = "";

  beforeAll(async () => {
    site = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers))
        if (typeof value === "string") headers.set(key, value);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const response = await mock.fetch(
        new Request(`${siteUrl}${req.url}`, { method: req.method ?? "GET", headers, body }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => site.close(() => resolve())));

  it("starts read-only, negotiates 2026-07-28 and answers a contact profile", async () => {
    const client = new Client(
      { name: "e2e", version: "0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [bin, "--stdio"],
        env: {
          PATH: process.env.PATH ?? "",
          FLUENTSUITE_SITE_URL: siteUrl,
          FLUENTSUITE_ALLOW_INSECURE_HTTP: "true",
          FLUENTSUITE_WP_USER: "fluentsuite-test",
          FLUENTSUITE_WP_APP_PASSWORD: "test pass word abcd efgh ijkl",
          FLUENTSUITE_LOG_LEVEL: "error",
        },
        stderr: "pipe",
      }),
    );
    try {
      expect(client.getProtocolEra()).toBe("modern");
      expect(client.getServerVersion()?.name).toBe("fluentsuite");
      const { tools } = await client.listTools();
      expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
      const result = await client.callTool({
        name: "crm_contact_profile",
        arguments: { email: "omar@example.test" },
      });
      expect(textOf(result)).toContain("Omar Haddad <omar@example.test> (contact #1533)");
    } finally {
      await client.close();
    }
  });
});
