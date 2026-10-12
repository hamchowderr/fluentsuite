import { defineTool, plural } from "@fluentsuite/core";
import * as z from "zod/v4";
import type { FluentCrmApi } from "../api.js";
import { STATUSES } from "../segment.js";

const Input = z.object({
  days: z.number().int().min(7).max(365).default(30).describe("Growth and email activity window."),
});

const Output = z.object({
  window: z.object({ from: z.string(), to: z.string() }),
  by_status: z.record(z.string(), z.number()),
  total_contacts: z.number(),
  new_subscribed: z.number(),
  growth: z.record(z.string(), z.number()),
  emails: z.object({ sent: z.number(), opens: z.number(), clicks: z.number() }),
  top_tags: z.array(z.object({ name: z.string(), subscribed: z.number() })),
  top_lists: z.array(z.object({ name: z.string(), subscribed: z.number() })),
  dashboard: z.record(z.string(), z.number()),
});

const sum = (series: Record<string, number>) => Object.values(series).reduce((a, b) => a + b, 0);

export function audienceSummaryTool(api: FluentCrmApi, now: () => Date = () => new Date()) {
  return defineTool({
    name: "crm_audience_summary",
    title: "Audience summary",
    description:
      "The big picture of the FluentCRM audience: contacts by status, new subscribers and email activity over a window, top tags and lists, and dashboard totals.",
    kind: "read",
    input: Input,
    output: Output,
    handler: async (args, ctx) => {
      const to = now().toISOString().slice(0, 10);
      const from = new Date(now().getTime() - args.days * 86_400_000).toISOString().slice(0, 10);
      const [counts, growth, sent, opens, clicks, tags, lists, dashboard] = await Promise.all([
        Promise.all(STATUSES.map((s) => api.countContacts({ statuses: [s] }, ctx.signal))),
        api.series("subscribers", from, to, ctx.signal),
        api.series("email-sents", from, to, ctx.signal),
        api.series("email-opens", from, to, ctx.signal),
        api.series("email-clicks", from, to, ctx.signal),
        api.tags(ctx.signal),
        api.lists(ctx.signal),
        api.dashboardStats(ctx.signal),
      ]);
      const byStatus: Record<string, number> = {};
      STATUSES.forEach((status, i) => {
        const n = counts[i] ?? 0;
        if (n) byStatus[status] = n;
      });
      const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
      const topTags = [...tags]
        .sort((a, b) => (b.subscribersCount ?? 0) - (a.subscribersCount ?? 0))
        .slice(0, 5)
        .map((t) => ({ name: t.title, subscribed: t.subscribersCount ?? 0 }));
      const topLists = [...lists]
        .sort((a, b) => (b.subscribersCount ?? 0) - (a.subscribersCount ?? 0))
        .slice(0, 5)
        .map((l) => ({ name: l.title, subscribed: l.subscribersCount ?? 0 }));
      const dash = Object.fromEntries(Object.entries(dashboard).map(([k, v]) => [k, v.count]));
      const out = {
        window: { from, to },
        by_status: byStatus,
        total_contacts: total,
        new_subscribed: sum(growth),
        growth,
        emails: { sent: sum(sent), opens: sum(opens), clicks: sum(clicks) },
        top_tags: topTags,
        top_lists: topLists,
        dashboard: dash,
      };
      const text = [
        `Audience: ${plural(total, "contact")} (${Object.entries(byStatus)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ")}).`,
        `Last ${args.days} days (${from} to ${to}): ${plural(out.new_subscribed, "new subscribed contact")}; emails sent ${out.emails.sent}, opens ${out.emails.opens}, clicks ${out.emails.clicks}.`,
        `Top tags: ${topTags.map((t) => `${t.name} (${t.subscribed})`).join(", ") || "none"}.`,
        `Top lists: ${topLists.map((l) => `${l.name} (${l.subscribed})`).join(", ") || "none"}.`,
        dash.total_campaigns !== undefined
          ? `Campaigns: ${dash.total_campaigns}. Active automations: ${dash.total_automations ?? 0}.`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      return { text, structured: out };
    },
  });
}
