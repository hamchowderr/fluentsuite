import { defineTool, plural, truncate } from "@fluentsuite/core";
import * as z from "zod/v4";
import type { FluentCrmApi } from "../api.js";

const Input = z.object({
  sequence_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Show one sequence with its emails."),
  limit: z.number().int().min(1).max(50).default(20),
});

const Output = z.object({
  sequences: z.array(
    z.object({
      id: z.number(),
      title: z.string(),
      status: z.string(),
      emails: z.number(),
      subscribers: z.number(),
    }),
  ),
  total: z.number(),
  emails: z
    .array(
      z.object({
        id: z.number(),
        subject: z.string(),
        delay_days: z.number(),
        sent: z.number(),
        opens: z.number(),
        clicks: z.number(),
      }),
    )
    .nullable(),
});

const days = (seconds: number | null | undefined) =>
  Math.round(((seconds ?? 0) / 86_400) * 10) / 10;

export function sequenceOverviewTool(api: FluentCrmApi) {
  return defineTool({
    name: "crm_sequence_overview",
    title: "Sequence overview",
    description:
      "FluentCRM email sequences (drip series) with email and subscriber counts, or one sequence with each email's delay and performance. Needs FluentCRM Pro; says so clearly when Pro is missing.",
    kind: "read",
    input: Input,
    output: Output,
    handler: async (args, ctx) => {
      if (args.sequence_id !== undefined) {
        const res = await api.sequence(args.sequence_id, ctx.signal);
        const seq = res.sequence;
        const emails = res.sequence_emails.map((e) => ({
          id: e.id,
          subject: e.email_subject ?? e.title ?? "(no subject)",
          delay_days: days(e.delay),
          sent: e.stats?.sent ?? 0,
          opens: e.stats?.views ?? 0,
          clicks: e.stats?.clicks ?? 0,
        }));
        const text = [
          `Sequence #${seq.id} "${seq.title}" (${seq.status}), ${plural(emails.length, "email")}, ${plural(seq.stats?.subscribers ?? 0, "subscriber")}:`,
          ...emails.map(
            (e, i) =>
              `${i + 1}. after ${e.delay_days} day${e.delay_days === 1 ? "" : "s"}: "${truncate(e.subject, 70)}" · sent ${e.sent}, opens ${e.opens}, clicks ${e.clicks}`,
          ),
        ].join("\n");
        return {
          text,
          structured: {
            sequences: [
              {
                id: seq.id,
                title: seq.title,
                status: seq.status,
                emails: emails.length,
                subscribers: seq.stats?.subscribers ?? 0,
              },
            ],
            total: 1,
            emails,
          },
        };
      }
      const page = await api.sequences({ page: 1, perPage: args.limit }, ctx.signal);
      const rows = page.data.map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        emails: s.stats?.emails ?? 0,
        subscribers: s.stats?.subscribers ?? 0,
      }));
      const text = [
        `${plural(page.total, "sequence")}:`,
        ...(rows.length
          ? rows.map(
              (s) =>
                `- #${s.id} "${truncate(s.title, 60)}" · ${s.status} · ${plural(s.emails, "email")} · ${plural(s.subscribers, "subscriber")}`,
            )
          : ["- none"]),
        "Pass sequence_id for one sequence's emails and performance.",
      ].join("\n");
      return { text, structured: { sequences: rows, total: page.total, emails: null } };
    },
  });
}
