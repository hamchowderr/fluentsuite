import { fileURLToPath } from "node:url";
import { LLMock } from "@copilotkit/aimock";
import { runAgent } from "@fluentsuite/core/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createCrmTestServer } from "../helpers.js";

/**
 * Agent-level tests: a mocked model (AIMock) drives our real MCP server through a real agent loop.
 * The model's moves are scripted, so the run is deterministic; what is real is everything on our
 * side: the tool list the model is offered, argument validation, REST calls, and tool output.
 */

const mock = new LLMock({ port: 0, strict: true, logLevel: "silent" });
mock.loadFixtureFile(fileURLToPath(new URL("./contact-lookup.fixtures.json", import.meta.url)));

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

describe("agent: contact lookup", () => {
  it("answers a question about a contact with one crm_contact_profile call", async () => {
    const server = createCrmTestServer();
    const conn = await server.connect();
    close = conn.close;

    const run = await runAgent({
      client: conn.client,
      modelUrl: mock.url,
      prompt: "What do we know about jane.doe@example.test?",
    });

    expect(run.toolCalls).toHaveLength(1);
    expect(run.toolCalls[0]).toMatchObject({ name: "crm_contact_profile", isError: false });
    expect(run.answer).toContain("opened 7 of 12 emails");
    // The model saw our tool, and our server made exactly the REST calls the task needs.
    expect(server.mock.requests.map((r) => r.route)).toEqual([
      "fluent-crm/v2/subscribers/0",
      "fluent-crm/v2/subscribers/1532/emails",
      "fluent-crm/v2/subscribers/1532/notes",
    ]);
  });

  it("recovers gracefully when the contact does not exist", async () => {
    const conn = await createCrmTestServer().connect();
    close = conn.close;
    const run = await runAgent({
      client: conn.client,
      modelUrl: mock.url,
      prompt: "Look up nobody@example.test",
    });
    expect(run.toolCalls[0]?.isError).toBe(true);
    expect(run.answer).toBe("There is no contact with that email in FluentCRM.");
  });
});
