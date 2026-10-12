import { createServerFactory, parseConfig } from "@fluentsuite/core";
import { connectInProcess } from "@fluentsuite/core/testing";
import { crmProduct } from "../src/index.js";
import { createMockFluentCrm } from "./mock-fluentcrm.js";

/** A FluentSuite server with only the CRM module, wired to the mock FluentCRM site. */
export function createCrmTestServer(
  options: { writes?: boolean; applicationPassword?: string } = {},
) {
  const mock = createMockFluentCrm();
  const config = parseConfig({
    site: {
      url: mock.siteUrl,
      username: "fluentsuite-test",
      applicationPassword: options.applicationPassword ?? "test pass word abcd efgh ijkl",
    },
    products: ["crm"],
    writes: { enabled: options.writes ?? false },
    request: { retries: 0 },
    logLevel: "silent",
  });
  const factory = createServerFactory({ config, products: [crmProduct], fetch: mock.fetch });
  return { mock, factory, connect: (opts?: { ui?: boolean }) => connectInProcess(factory, opts) };
}
