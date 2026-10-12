import { createServerFactory, parseConfig } from "@fluentsuite/core";
import { connectInProcess } from "@fluentsuite/core/testing";
import { smtpProduct } from "../src/index.js";
import { createMockBridge } from "./mock-bridge.js";

/** A FluentSuite server with only the SMTP module, wired to the mock bridge site. */
export async function connectSmtp(
  options: {
    bridge?: boolean;
    fluentsmtp?: boolean;
    writes?: boolean;
    allowSending?: boolean;
    bridgeSending?: boolean;
  } = {},
) {
  const site = createMockBridge(options);
  const config = parseConfig({
    site: {
      url: site.siteUrl,
      username: "fluentsuite-test",
      applicationPassword: "test pass word abcd efgh ijkl",
    },
    products: ["smtp"],
    writes: { enabled: options.writes ?? false, allowSending: options.allowSending ?? false },
    request: { retries: 0 },
    logLevel: "silent",
  });
  const conn = await connectInProcess(
    createServerFactory({ config, products: [smtpProduct], fetch: site.fetch }),
  );
  const call = (name: string, args: Record<string, unknown> = {}) =>
    conn.client.callTool({ name, arguments: args });
  return { ...conn, site, call };
}
