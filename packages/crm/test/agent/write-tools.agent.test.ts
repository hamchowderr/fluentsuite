import { fileURLToPath } from "node:url";
import { LLMock } from "@copilotkit/aimock";
import { createServerFactory, parseConfig } from "@fluentsuite/core";
import { connectInProcess, runAgent } from "@fluentsuite/core/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { crmProduct } from "../../src/index.js";
import { createRecordedSite } from "../mock-recorded-site.js";

/** Agent-level: the model follows the write protocol (preview first, then apply) and the change lands. */
const mock = new LLMock({ port: 0, strict: true, logLevel: "silent" });
mock.loadFixtureFile(fileURLToPath(new URL("./write-tools.fixtures.json", import.meta.url)));
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

describe("agent: write tools", () => {
  it("previews, then applies a small tag change", async () => {
    const site = createRecordedSite();
    const config = parseConfig({
      site: {
        url: site.siteUrl,
        username: "fluentsuite-test",
        applicationPassword: "test pass word abcd efgh ijkl",
      },
      writes: { enabled: true },
      logLevel: "silent",
    });
    const conn = await connectInProcess(
      createServerFactory({ config, products: [crmProduct], fetch: site.fetch }),
    );
    close = conn.close;
    const run = await runAgent({
      client: conn.client,
      modelUrl: mock.url,
      prompt: "Tag yara.khan50@example.com as VIP",
    });
    expect(run.toolCalls.map((c) => [c.name, c.isError])).toEqual([
      ["crm_tag_contacts", false],
      ["crm_tag_contacts", false],
    ]);
    expect(run.toolCalls[0]?.result).toContain("DRY RUN");
    expect(
      site.state.contacts
        .find((c) => c.email === "yara.khan50@example.com")
        ?.tags.map((t) => t.title),
    ).toContain("VIP");
    expect(run.answer).toContain("tagged VIP");
  });
});
