import { fileURLToPath } from "node:url";
import { LLMock } from "@copilotkit/aimock";
import { createServerFactory, parseConfig } from "@fluentsuite/core";
import { connectInProcess, runAgent } from "@fluentsuite/core/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { crmProduct } from "../../src/index.js";
import { createRecordedSite } from "../mock-recorded-site.js";

/** Agent-level: a scripted model uses the read tools against the recorded test-site dataset. */
const mock = new LLMock({ port: 0, strict: true, logLevel: "silent" });
mock.loadFixtureFile(fileURLToPath(new URL("./read-tools.fixtures.json", import.meta.url)));
beforeAll(async () => {
  await mock.start();
});
afterAll(async () => {
  await mock.stop();
});

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function connect() {
  const site = createRecordedSite();
  const config = parseConfig({
    site: {
      url: site.siteUrl,
      username: "fluentsuite-test",
      applicationPassword: "test pass word abcd efgh ijkl",
    },
    logLevel: "silent",
  });
  const conn = await connectInProcess(
    createServerFactory({ config, products: [crmProduct], fetch: site.fetch }),
  );
  close = conn.close;
  return conn.client;
}

describe("agent: read tools", () => {
  it("answers a 'how many' question with one crm_find_contacts call", async () => {
    const client = await connect();
    const run = await runAgent({
      client,
      modelUrl: mock.url,
      prompt: "How many subscribed contacts are interested in pricing?",
    });
    expect(run.toolCalls.map((c) => [c.name, c.isError])).toEqual([["crm_find_contacts", false]]);
    expect(run.answer).toContain("interested in pricing");
  });

  it("previews an audience with exclusions via crm_segment_preview", async () => {
    const client = await connect();
    const run = await runAgent({
      client,
      modelUrl: mock.url,
      prompt: "Preview the Newsletter audience without customers",
    });
    expect(run.toolCalls.map((c) => [c.name, c.isError])).toEqual([["crm_segment_preview", false]]);
    expect(run.answer).toContain("ready to review");
  });
});
