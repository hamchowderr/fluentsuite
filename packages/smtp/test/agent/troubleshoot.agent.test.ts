import { fileURLToPath } from "node:url";
import { LLMock } from "@copilotkit/aimock";
import { runAgent } from "@fluentsuite/core/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { connectSmtp } from "../helpers.js";

/**
 * Agent-level: a scripted model investigates failing email with the SMTP read tools, against the recorded
 * test-site log. Proves the tool outputs carry what the model needs, and that the reset link it reads stays
 * masked all the way to the model.
 */
const mock = new LLMock({ port: 0, strict: true, logLevel: "silent" });
mock.loadFixtureFile(fileURLToPath(new URL("./troubleshoot.fixtures.json", import.meta.url)));
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

describe("agent: email troubleshooting", () => {
  it("reads the report, then one failed email, and never sees the reset key", async () => {
    const conn = await connectSmtp();
    close = conn.close;
    const run = await runAgent({
      client: conn.client,
      modelUrl: mock.url,
      prompt: "Why are our emails failing?",
    });
    expect(run.toolCalls.map((c) => [c.name, c.isError])).toEqual([
      ["smtp_delivery_report", false],
      ["smtp_email_detail", false],
    ]);
    expect(run.toolCalls[0]?.result).toMatch(/Could not connect to SMTP host/);
    for (const call of run.toolCalls) {
      expect(call.result).not.toContain("FAKEkey");
      expect(call.result).not.toContain("action=rp");
    }
    expect(run.answer).toContain("reset link is masked");
  });
});
