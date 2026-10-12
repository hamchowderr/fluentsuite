import { defineTool, plural } from "@fluentsuite/core";
import * as z from "zod/v4";
import type { SmtpApi } from "../api.js";
import { EmailRow, emailLine, failureRate, toEmailRow } from "../format.js";

const Counts = z.object({ sent: z.number(), failed: z.number() });

const Output = z.object({
  fluentsmtp_version: z.string().nullable(),
  bridge_version: z.string(),
  simulate_mode: z.boolean(),
  logging: z.object({ enabled: z.boolean(), retention_days: z.number().nullable() }),
  connections: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      provider: z.string(),
      sender_email: z.string().nullable(),
      senders: z.array(z.string()),
      is_default: z.boolean(),
      is_fallback: z.boolean(),
      host: z.string().nullable().optional(),
      port: z.string().nullable().optional(),
    }),
  ),
  totals: Counts,
  last_7_days: Counts,
  failure_rate_7_days: z
    .number()
    .nullable()
    .describe("Percent of the last 7 days' emails that failed."),
  last_failure: EmailRow.nullable(),
  warnings: z.array(z.string()),
});

export function smtpStatusTool(api: SmtpApi) {
  return defineTool({
    name: "smtp_status",
    title: "Email sending status",
    description:
      "Health check for the site's email (FluentSMTP): connections and sender addresses, simulate mode, logging, sent/failed totals, the last 7 days, and the most recent failure. Never shows credentials. Start here for any email-delivery question.",
    kind: "read",
    input: z.object({}),
    output: Output,
    handler: async (_args, ctx) => {
      const s = await api.status(ctx.signal);
      const rate = failureRate(s.last_7_days);
      const warnings: string[] = [];
      if (s.simulate.enabled) {
        warnings.push(
          `Simulate mode is ON${s.simulate.by_constant ? " (set in wp-config.php)" : ""}: FluentSMTP logs emails but sends none.`,
        );
      }
      if (!s.connections.length)
        warnings.push("No connection is set up, so the site cannot send email.");
      if (!s.logging.enabled) warnings.push("Email logging is off, so failures leave no trace.");
      if (rate !== null && rate >= 10) warnings.push(`${rate}% of the last 7 days' emails failed.`);

      const connections = s.connections.map((c) => ({
        id: c.id,
        title: c.title,
        provider: c.provider,
        sender_email: c.sender_email ?? null,
        senders: c.senders,
        is_default: c.is_default,
        is_fallback: c.is_fallback,
        ...(c.host !== undefined ? { host: c.host ?? null, port: c.port ?? null } : {}),
      }));
      const lastFailure = s.last_failure ? toEmailRow(s.last_failure) : null;
      const text = [
        `FluentSMTP ${s.fluentsmtp.version ?? "(version unknown)"}, ${plural(s.connections.length, "connection")}.`,
        ...connections.map(
          (c) =>
            `- ${c.title} (${c.provider})${c.is_default ? " · default" : ""}${c.is_fallback ? " · fallback" : ""} · from ${c.senders.join(", ") || c.sender_email || "?"}${c.host ? ` · ${c.host}:${c.port ?? "?"}` : ""}`,
        ),
        `All time: ${s.totals.sent} sent, ${s.totals.failed} failed. Last 7 days: ${s.last_7_days.sent} sent, ${s.last_7_days.failed} failed${rate !== null ? ` (${rate}% failed)` : ""}.`,
        `Logging: ${s.logging.enabled ? `on, kept ${s.logging.retention_days ?? "?"} days` : "off"}.`,
        lastFailure ? `Most recent failure:\n${emailLine(lastFailure)}` : "No failures logged.",
        ...warnings.map((w) => `⚠ ${w}`),
      ].join("\n");
      return {
        text,
        structured: {
          fluentsmtp_version: s.fluentsmtp.version ?? null,
          bridge_version: s.bridge.version,
          simulate_mode: s.simulate.enabled,
          logging: {
            enabled: s.logging.enabled,
            retention_days: s.logging.retention_days ?? null,
          },
          connections,
          totals: { sent: s.totals.sent, failed: s.totals.failed },
          last_7_days: { sent: s.last_7_days.sent, failed: s.last_7_days.failed },
          failure_rate_7_days: rate,
          last_failure: lastFailure,
          warnings,
        },
      };
    },
  });
}
