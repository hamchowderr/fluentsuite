import { defineTool, plural, shortDate, truncate } from "@fluentsuite/core";
import * as z from "zod/v4";
import type { Campaign, FluentCrmApi } from "../api.js";

const CAMPAIGN_STATUSES = [
  "draft",
  "pending-scheduled",
  "scheduled",
  "processing",
  "working",
  "paused",
  "archived",
] as const;

const Input = z.object({
  campaign_id: z.number().int().positive().optional().describe("Show one campaign in detail."),
  statuses: z
    .array(z.enum(CAMPAIGN_STATUSES))
    .max(7)
    .optional()
    .describe("Filter the list by status. 'archived' means sent."),
  search: z.string().trim().max(200).optional().describe("Filter the list by title."),
  limit: z.number().int().min(1).max(50).default(10),
});

const Rates = z.object({
  sent: z.number(),
  opens: z.number(),
  clicks: z.number(),
  unsubscribes: z.number(),
  open_rate: z.number().nullable(),
  click_rate: z.number().nullable(),
});

const Summary = z.object({
  id: z.number(),
  title: z.string(),
  status: z.string(),
  subject: z.string().nullable(),
  recipients: z.number(),
  scheduled_at: z.string().nullable(),
  stats: Rates,
});

const Output = z.object({
  campaigns: z.array(Summary),
  total: z.number(),
  detail: z
    .object({
      campaign: Summary,
      top_links: z.array(z.object({ url: z.string(), clicks: z.number() })),
      revenue: z.string().nullable(),
      url: z.string(),
    })
    .nullable(),
});

const pct = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;

function rates(
  sent: number,
  opens: number,
  clicks: number,
  unsubscribes: number,
): z.infer<typeof Rates> {
  return {
    sent,
    opens,
    clicks,
    unsubscribes,
    open_rate: pct(opens, sent),
    click_rate: pct(clicks, sent),
  };
}

function summary(c: Campaign): z.infer<typeof Summary> {
  const s = c.stats;
  return {
    id: c.id,
    title: c.title,
    status: c.status,
    subject: c.email_subject ?? null,
    recipients: c.recipients_count ?? s?.total ?? 0,
    scheduled_at: c.scheduled_at ?? null,
    stats: rates(s?.sent ?? 0, s?.views ?? 0, s?.clicks ?? 0, s?.unsubscribers ?? 0),
  };
}

function line(s: z.infer<typeof Summary>): string {
  const r = s.stats;
  const perf = r.sent
    ? `sent ${r.sent}, opens ${r.opens} (${r.open_rate ?? 0}%), clicks ${r.clicks} (${r.click_rate ?? 0}%), unsubscribes ${r.unsubscribes}`
    : "not sent";
  return `- #${s.id} "${truncate(s.title, 60)}" · ${s.status}${s.scheduled_at ? ` · ${shortDate(s.scheduled_at)}` : ""} · ${perf}`;
}

function analyticsTotal(analytics: unknown, key: string): number | undefined {
  if (!analytics || Array.isArray(analytics) || typeof analytics !== "object") return undefined;
  const entry = (analytics as Record<string, { total?: unknown }>)[key];
  if (!entry) return undefined;
  const n = Number(String(entry.total).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

export function campaignOverviewTool(api: FluentCrmApi) {
  return defineTool({
    name: "crm_campaign_overview",
    title: "Campaign overview",
    description:
      "Recent FluentCRM email campaigns with status and performance (sent, opens, clicks, unsubscribes, rates), or one campaign in detail with its top links. Read-only: never changes a campaign's state.",
    kind: "read",
    input: Input,
    output: Output,
    handler: async (args, ctx) => {
      if (args.campaign_id !== undefined) {
        const [campaign, overview, links] = await Promise.all([
          api.campaign(args.campaign_id, ctx.signal),
          api.campaignOverview(args.campaign_id, ctx.signal),
          api.campaignLinks(args.campaign_id, ctx.signal),
        ]);
        const base = summary(campaign);
        const sent = overview.sent_count || base.stats.sent;
        const s = rates(
          sent,
          analyticsTotal(overview.analytics, "open") ?? base.stats.opens,
          analyticsTotal(overview.analytics, "click") ?? base.stats.clicks,
          analyticsTotal(overview.analytics, "unsubscribe") ?? base.stats.unsubscribes,
        );
        const revenue = Array.isArray(overview.analytics)
          ? null
          : String(
              (overview.analytics as Record<string, { total?: unknown }>).revenue?.total ?? "",
            ) || null;
        const detail = {
          campaign: { ...base, stats: s },
          top_links: links
            .sort((a, b) => b.total - a.total)
            .slice(0, 5)
            .map((l) => ({ url: l.url, clicks: l.total })),
          revenue,
          url: `${api.wp.siteUrl.replace(/\/+$/, "")}/wp-admin/admin.php?page=fluentcrm-admin#/email/campaigns/${campaign.id}/view`,
        };
        const text = [
          `Campaign #${campaign.id} "${campaign.title}" (${campaign.status})`,
          `Subject: ${campaign.email_subject ?? "(none)"}`,
          s.sent
            ? `Sent ${s.sent}. Opens ${s.opens} (${s.open_rate}%), clicks ${s.clicks} (${s.click_rate}%), unsubscribes ${s.unsubscribes}.`
            : `Not sent yet${base.recipients ? ` (${base.recipients} recipients selected)` : ""}.`,
          revenue ? `Revenue: ${revenue}` : "",
          detail.top_links.length ? "Top links:" : "",
          ...detail.top_links.map((l) => `- ${l.url} (${l.clicks} clicks)`),
          `Open in FluentCRM: ${detail.url}`,
        ]
          .filter(Boolean)
          .join("\n");
        return { text, structured: { campaigns: [detail.campaign], total: 1, detail } };
      }

      const page = await api.campaigns(
        { page: 1, perPage: args.limit, statuses: args.statuses, search: args.search },
        ctx.signal,
      );
      const rows = page.data.map(summary);
      const text = [
        `${plural(page.total, "campaign")}${page.total > rows.length ? `, newest ${rows.length} shown` : ""}:`,
        ...(rows.length ? rows.map(line) : ["- none"]),
        "Pass campaign_id for one campaign's detail and top links.",
      ].join("\n");
      return { text, structured: { campaigns: rows, total: page.total, detail: null } };
    },
  });
}
