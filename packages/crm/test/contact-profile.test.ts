import { textOf } from "@fluentsuite/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { CONTACT_CARD_URI } from "../src/index.js";
import type { ContactProfile } from "../src/tools/contact-profile.js";
import { createCrmTestServer } from "./helpers.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup() {
  const server = createCrmTestServer();
  const conn = await server.connect();
  close = conn.close;
  return { ...server, client: conn.client };
}

describe("crm_contact_profile", () => {
  it("is listed as a read-only tool with the contact card view", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "crm_contact_profile");
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(tool?._meta).toMatchObject({ ui: { resourceUri: CONTACT_CARD_URI } });
    expect(tool?.outputSchema).toBeDefined();
  });

  it("returns the whole profile by email in one call", async () => {
    const { client, mock } = await setup();
    const result = await client.callTool({
      name: "crm_contact_profile",
      arguments: { email: "jane.doe@example.test" },
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("Jane Doe <jane.doe@example.test> (contact #1532)");
    expect(text).toContain("Tags: int:pricing, stage:customer, VIP");
    expect(text).toContain("Lists: Newsletter, Product updates");
    expect(text).toContain("Email stats: 12 sent, 7 opened, 2 clicked");
    expect(text).toContain('2026-10-05 "October product update" opened, 2 clicks');
    expect(text).toContain("[call] Call recap: asked about annual pricing");
    expect(text).toContain("plan=Pro");

    const p = result.structuredContent as ContactProfile;
    expect(p.contact).toMatchObject({
      id: 1532,
      status: "subscribed",
      type: "customer",
      lifetime_value: 420,
    });
    expect(p.recent_emails).toHaveLength(3);
    expect(p.contact.url).toBe(
      "https://crm.example.test/wp-admin/admin.php?page=fluentcrm-admin#/subscribers/1532",
    );

    // One lookup by email with the right expansions, then emails and notes for that id.
    const show = mock.calls("GET", "fluent-crm/v2/subscribers/0");
    expect(show).toHaveLength(1);
    expect(show[0]?.query.get("get_by_email")).toBe("jane.doe@example.test");
    expect(show[0]?.query.getAll("with[]")).toEqual(["stats", "subscriber.custom_values"]);
    expect(
      mock.calls("GET", "fluent-crm/v2/subscribers/1532/emails")[0]?.query.get("per_page"),
    ).toBe("5");
    expect(
      mock.calls("GET", "fluent-crm/v2/subscribers/1532/notes")[0]?.query.get("per_page"),
    ).toBe("3");
  });

  it("looks up by id and skips sections set to zero", async () => {
    const { client, mock } = await setup();
    const result = await client.callTool({
      name: "crm_contact_profile",
      arguments: { id: 1534, recent_emails: 0, recent_notes: 0 },
    });
    const text = textOf(result);
    expect(text).toContain("Status: unsubscribed (reason: Too many emails)");
    expect(text).toContain("Lists: none");
    expect(mock.calls("GET", /emails|notes/)).toHaveLength(0);
  });

  it("explains a missing contact instead of failing obscurely", async () => {
    const { client } = await setup();
    const result = await client.callTool({
      name: "crm_contact_profile",
      arguments: { email: "nobody@example.test" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Error (not_found): No contact matches that email or id.");
    expect(textOf(result)).toContain("crm_find_contacts");
  });

  it("rejects calls with neither email nor id, and malformed emails", async () => {
    const { client } = await setup();
    const none = await client.callTool({ name: "crm_contact_profile", arguments: {} });
    expect(none.isError).toBe(true);
    const bad = await client.callTool({
      name: "crm_contact_profile",
      arguments: { email: "not-an-email" },
    });
    expect(bad.isError).toBe(true);
  });

  it("surfaces bad credentials with a hint, without leaking them", async () => {
    const server = createCrmTestServer({ applicationPassword: "wrong pass word zzzz yyyy xxxx" });
    const conn = await server.connect();
    close = conn.close;
    const result = await conn.client.callTool({
      name: "crm_contact_profile",
      arguments: { id: 1532 },
    });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Error (auth_failed)");
    expect(text).toContain("Application Password");
    expect(text).not.toContain("wrong pass word");
  });

  it("serves the contact card view as a self-contained MCP App", async () => {
    const { client } = await setup();
    const read = await client.readResource({ uri: CONTACT_CARD_URI });
    const view = read.contents[0] as { mimeType: string; text: string };
    expect(view.mimeType).toBe("text/html;profile=mcp-app");
    expect(view.text).toContain('<div id="app"');
    expect(view.text).not.toMatch(/<script[^>]+src=/);
  });
});
