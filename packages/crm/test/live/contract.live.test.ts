import { createServerFactory, parseConfig } from "@fluentsuite/core";
import { connectInProcess, textOf } from "@fluentsuite/core/testing";
import { describe, expect, it } from "vitest";
import { crmProduct } from "../../src/index.js";
import type { ContactProfile } from "../../src/tools/contact-profile.js";

/**
 * Live contract tests: the real server, read-only, against the FluentSuite test site. Skipped unless
 * FLUENTSUITE_LIVE_SITE_URL, FLUENTSUITE_LIVE_WP_USER and FLUENTSUITE_LIVE_APP_PASSWORD are set (the
 * "Live contract" workflow sets them from repository secrets). Never point this at a real business site.
 */
const env = process.env;
const live = Boolean(
  env.FLUENTSUITE_LIVE_SITE_URL &&
    env.FLUENTSUITE_LIVE_WP_USER &&
    env.FLUENTSUITE_LIVE_APP_PASSWORD,
);

describe.skipIf(!live)("live: FluentCRM test site", () => {
  const factory = () =>
    createServerFactory({
      config: parseConfig({
        site: {
          url: env.FLUENTSUITE_LIVE_SITE_URL,
          username: env.FLUENTSUITE_LIVE_WP_USER,
          applicationPassword: env.FLUENTSUITE_LIVE_APP_PASSWORD,
        },
        writes: { enabled: false },
        logLevel: "silent",
      }),
      products: [crmProduct],
    });

  it("is read-only and answers a seeded contact's profile", async () => {
    const conn = await connectInProcess(factory());
    try {
      const { tools } = await conn.client.listTools();
      expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
      // Seeded contact 1 is always ava.<surname>1@example.com; look it up by id, then by its email.
      const byId = await conn.client.callTool({
        name: "crm_contact_profile",
        arguments: { id: 1 },
      });
      expect(byId.isError).toBeFalsy();
      const email = (byId.structuredContent as ContactProfile).contact.email;
      expect(email).toMatch(/^ava\.[a-z]+1@example\.com$/);
      const byEmail = await conn.client.callTool({
        name: "crm_contact_profile",
        arguments: { email },
      });
      expect(textOf(byEmail)).toContain("(contact #1)");
    } finally {
      await conn.close();
    }
  });

  it("runs the segment and summary tools against the real site", async () => {
    const conn = await connectInProcess(factory());
    try {
      const find = await conn.client.callTool({
        name: "crm_find_contacts",
        arguments: { lists_any: ["Newsletter"], statuses: ["subscribed"], per_page: 1 },
      });
      expect(find.isError).toBeFalsy();
      expect((find.structuredContent as { total: number }).total).toBeGreaterThan(0);
      const summary = await conn.client.callTool({
        name: "crm_audience_summary",
        arguments: { days: 30 },
      });
      expect(summary.isError).toBeFalsy();
      expect(
        (summary.structuredContent as { total_contacts: number }).total_contacts,
      ).toBeGreaterThanOrEqual(50);
      const sequences = await conn.client.callTool({
        name: "crm_sequence_overview",
        arguments: {},
      });
      expect(textOf(sequences)).toContain("New lead nurture (test)");
    } finally {
      await conn.close();
    }
  });

  it("reports an unknown contact as not_found", async () => {
    const conn = await connectInProcess(factory());
    try {
      const result = await conn.client.callTool({
        name: "crm_contact_profile",
        arguments: { email: "nobody@example.com" },
      });
      expect(textOf(result)).toContain("Error (not_found)");
    } finally {
      await conn.close();
    }
  });
});
