import { createServerFactory, parseConfig } from "@fluentsuite/core";
import { connectInProcess } from "@fluentsuite/core/testing";
import { formsProduct } from "../src/index.js";
import { createMockForms, forbiddenCalls } from "./mock-forms.js";

/**
 * A FluentSuite server with only the Fluent Forms module, wired to the mock Fluent Forms site.
 *
 * Closing the connection fails the test if any tool called GET submissions/{id} (marks entries read) or form-submit
 * (creates entries, fires notifications and feeds). Every test that connects gets this check, for every tool.
 */
export async function connectForms(
  options: { active?: boolean; writes?: boolean; redactFields?: string[] } = {},
) {
  const site = createMockForms(options);
  const config = parseConfig({
    site: {
      url: site.siteUrl,
      username: "fluentsuite-test",
      applicationPassword: "test pass word abcd efgh ijkl",
    },
    products: ["forms"],
    writes: { enabled: options.writes ?? false },
    forms: { redactFields: options.redactFields ?? [] },
    request: { retries: 0 },
    logLevel: "silent",
  });
  const conn = await connectInProcess(
    createServerFactory({ config, products: [formsProduct], fetch: site.fetch }),
  );
  const call = (name: string, args: Record<string, unknown> = {}) =>
    conn.client.callTool({ name, arguments: args });
  const close = async () => {
    await conn.close();
    const forbidden = forbiddenCalls(site);
    if (forbidden.length) {
      throw new Error(
        `Forbidden Fluent Forms route called: ${forbidden.map((r) => `${r.method} ${r.route}`).join(", ")}`,
      );
    }
  };
  return { ...conn, close, site, call };
}
