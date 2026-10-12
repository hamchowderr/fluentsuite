import { defineTool, FluentSuiteError, truncate } from "@fluentsuite/core";
import * as z from "zod/v4";
import type { SmtpApi } from "../api.js";
import { DATE, failureRate } from "../format.js";
import { maskSecrets } from "../mask.js";

const Input = z.object({
  after: DATE.optional().describe("Start date (site timezone). Default: 29 days before `before`."),
  before: DATE.optional().describe("End date (site timezone). Default: today."),
});

const Counts = z.object({ sent: z.number(), failed: z.number() });

const Output = z.object({
  after: z.string(),
  before: z.string(),
  totals: Counts,
  failure_rate: z.number().nullable().describe("Percent of emails in the range that failed."),
  days: z.array(z.object({ date: z.string(), sent: z.number(), failed: z.number() })),
  sources: z.array(z.object({ source: z.string(), sent: z.number(), failed: z.number() })),
  failure_reasons: z.array(
    z.object({ error: z.string(), count: z.number(), latest_id: z.number() }),
  ),
});

export function deliveryReportTool(api: SmtpApi) {
  return defineTool({
    name: "smtp_delivery_report",
    title: "Email delivery report",
    description:
      "Sent and failed emails per day for a date range (default: the last 30 days, at most 366), the failure reasons grouped by error, and the top sending sources. Use it to answer 'why are emails failing?' and 'which plugin sends the most?'.",
    kind: "read",
    input: Input,
    output: Output,
    handler: async (args, ctx) => {
      if (args.after && args.before && args.after > args.before) {
        throw new FluentSuiteError("invalid_input", "`after` is later than `before`.");
      }
      const r = await api.report(args, ctx.signal);
      const rate = failureRate(r.totals);
      const reasons = r.failure_reasons.map((x) => ({
        error: maskSecrets(x.error),
        count: x.count,
        latest_id: x.latest_id,
      }));
      const days = r.days.map((d) => ({ date: d.date, sent: d.sent, failed: d.failed }));
      const sources = r.sources.map((s) => ({ source: s.source, sent: s.sent, failed: s.failed }));
      const worst = [...days].sort((a, b) => b.failed - a.failed)[0];
      const text = [
        `${r.after} to ${r.before}: ${r.totals.sent} sent, ${r.totals.failed} failed${rate !== null ? ` (${rate}% failed)` : ""}.`,
        reasons.length ? "Failure reasons:" : "No failures in this range.",
        ...reasons
          .slice(0, 8)
          .map((x) => `- ${x.count}× ${truncate(x.error, 120)} (latest #${x.latest_id})`),
        sources.length ? "Sources:" : "",
        ...sources.slice(0, 8).map((s) => `- ${s.source}: ${s.sent} sent, ${s.failed} failed`),
        worst && worst.failed > 0 ? `Most failures on ${worst.date} (${worst.failed}).` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return {
        text,
        structured: {
          after: r.after,
          before: r.before,
          totals: { sent: r.totals.sent, failed: r.totals.failed },
          failure_rate: rate,
          days,
          sources,
          failure_reasons: reasons,
        },
      };
    },
  });
}
