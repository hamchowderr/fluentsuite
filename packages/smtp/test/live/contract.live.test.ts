import { createServerFactory, parseConfig } from "@fluentsuite/core";
import { connectInProcess, textOf } from "@fluentsuite/core/testing";
import { describe, expect, it } from "vitest";
import { smtpProduct } from "../../src/index.js";

/**
 * Live contract tests: the real server, read-only, against the FluentSuite test site (FluentSMTP in simulate
 * mode, FluentSuite Bridge active, fictional log). Skipped unless FLUENTSUITE_LIVE_SITE_URL,
 * FLUENTSUITE_LIVE_WP_USER and FLUENTSUITE_LIVE_APP_PASSWORD are set. Never point this at a real business site.
 */
const env = process.env;
const live = Boolean(
  env.FLUENTSUITE_LIVE_SITE_URL &&
    env.FLUENTSUITE_LIVE_WP_USER &&
    env.FLUENTSUITE_LIVE_APP_PASSWORD,
);

describe.skipIf(!live)("live: FluentSMTP test site", () => {
  const factory = () =>
    createServerFactory({
      config: parseConfig({
        site: {
          url: env.FLUENTSUITE_LIVE_SITE_URL,
          username: env.FLUENTSUITE_LIVE_WP_USER,
          applicationPassword: env.FLUENTSUITE_LIVE_APP_PASSWORD,
        },
        products: ["smtp"],
        writes: { enabled: false },
        logLevel: "silent",
      }),
      products: [smtpProduct],
    });

  it("reports simulate mode and a connection that cannot deliver", async () => {
    const conn = await connectInProcess(factory());
    try {
      const res = await conn.client.callTool({ name: "smtp_status", arguments: {} });
      expect(res.isError).toBeFalsy();
      const s = res.structuredContent as {
        simulate_mode: boolean;
        connections: Array<{ host?: string | null; port?: string | null }>;
      };
      // The test site must never be able to send: if this fails, stop and fix the site first.
      expect(s.simulate_mode).toBe(true);
      expect(s.connections.every((c) => c.host === "127.0.0.1" && c.port === "1")).toBe(true);
    } finally {
      await conn.close();
    }
  });

  it("searches the log, masks the seeded reset link and builds a report", async () => {
    const conn = await connectInProcess(factory());
    try {
      const find = await conn.client.callTool({
        name: "smtp_find_email_logs",
        arguments: { subject: "Password reset for your account", per_page: 1 },
      });
      const id = (find.structuredContent as { emails: Array<{ id: number }> }).emails[0]?.id;
      expect(id).toBeTypeOf("number");
      const detail = await conn.client.callTool({
        name: "smtp_email_detail",
        arguments: { id, include_body: true },
      });
      expect(textOf(detail)).toContain("wp-login.php?[masked]");
      expect(JSON.stringify(detail)).not.toContain("FAKEkey");
      const report = await conn.client.callTool({ name: "smtp_delivery_report", arguments: {} });
      expect(report.isError).toBeFalsy();
    } finally {
      await conn.close();
    }
  });
});
