import { fileURLToPath } from "node:url";
import { LLMock } from "@copilotkit/aimock";
import { runAgent } from "@fluentsuite/core/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { connectForms } from "../helpers.js";
import { forbiddenCalls } from "../mock-forms.js";

/**
 * Agent-level: a scripted model looks at new contact-form entries, then opens one. Proves the outputs carry what
 * the model needs, that the PII rules hold all the way to the model, and that opening the entry doesn't mark it read.
 */
const mock = new LLMock({ port: 0, strict: true, logLevel: "silent" });
mock.loadFixtureFile(fileURLToPath(new URL("./triage.fixtures.json", import.meta.url)));
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

describe("agent: form entries", () => {
  it("finds unread entries, opens one, and never sees the file URL, tax id or IP", async () => {
    const conn = await connectForms();
    close = conn.close;
    const run = await runAgent({
      client: conn.client,
      modelUrl: mock.url,
      prompt: "What came in on the contact form?",
    });
    expect(run.toolCalls.map((c) => [c.name, c.isError])).toEqual([
      ["forms_find_entries", false],
      ["forms_entry_detail", false],
    ]);
    for (const call of run.toolCalls) {
      expect(call.result).not.toMatch(/wp-content\/uploads|FAKE-TAX|192\.0\.2\./);
    }
    expect(run.toolCalls[1]?.result).toMatch(/fake-\d+-quote-request\.pdf/);
    expect(forbiddenCalls(conn.site)).toEqual([]);
    expect(run.answer).toContain("tax id is redacted");
  });
});
