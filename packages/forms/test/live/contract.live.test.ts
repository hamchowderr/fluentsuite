import { createServerFactory, parseConfig } from "@fluentsuite/core";
import { connectInProcess, textOf } from "@fluentsuite/core/testing";
import { describe, expect, it } from "vitest";
import { formsProduct } from "../../src/index.js";

/**
 * Live contract tests: the real server, read-only, against the FluentSuite test site (Fluent Forms 6.2.15, fictional
 * entries). Skipped unless FLUENTSUITE_LIVE_SITE_URL, FLUENTSUITE_LIVE_WP_USER and FLUENTSUITE_LIVE_APP_PASSWORD are
 * set. Never point this at a real business site.
 */
const env = process.env;
const live = Boolean(
  env.FLUENTSUITE_LIVE_SITE_URL &&
    env.FLUENTSUITE_LIVE_WP_USER &&
    env.FLUENTSUITE_LIVE_APP_PASSWORD,
);

describe.skipIf(!live)("live: Fluent Forms test site", () => {
  const factory = () =>
    createServerFactory({
      config: parseConfig({
        site: {
          url: env.FLUENTSUITE_LIVE_SITE_URL,
          username: env.FLUENTSUITE_LIVE_WP_USER,
          applicationPassword: env.FLUENTSUITE_LIVE_APP_PASSWORD,
        },
        products: ["forms"],
        writes: { enabled: false },
        logLevel: "silent",
      }),
      products: [formsProduct],
    });

  it("lists the test forms and opens an unread entry without marking it read", async () => {
    const conn = await connectInProcess(factory());
    try {
      const list = await conn.client.callTool({
        name: "forms_list",
        arguments: { search: "Contact (test)" },
      });
      const form = (list.structuredContent as { forms: Array<{ id: number; unread: number }> })
        .forms[0];
      expect(form?.id).toBeTypeOf("number");
      const unread = await conn.client.callTool({
        name: "forms_find_entries",
        arguments: { form_id: form?.id, status: "unread", per_page: 1 },
      });
      const entry = (unread.structuredContent as { entries: Array<{ id: number }> }).entries[0];
      const detail = await conn.client.callTool({
        name: "forms_entry_detail",
        arguments: { id: entry?.id, form_id: form?.id },
      });
      expect(detail.isError).toBeFalsy();
      expect(JSON.stringify(detail)).not.toMatch(/wp-content\/uploads|FAKE-TAX|192\.0\.2\./);
      expect((detail.structuredContent as { status: string }).status).toBe("unread");
      const again = await conn.client.callTool({
        name: "forms_list",
        arguments: { search: "Contact (test)" },
      });
      const after = (again.structuredContent as { forms: Array<{ unread: number }> }).forms[0];
      expect(after?.unread).toBe(form?.unread);
    } finally {
      await conn.close();
    }
  });

  it("builds a report", async () => {
    const conn = await connectInProcess(factory());
    try {
      const report = await conn.client.callTool({ name: "forms_report", arguments: {} });
      expect(report.isError).toBeFalsy();
      expect(textOf(report)).toMatch(/entries/);
    } finally {
      await conn.close();
    }
  });
});
