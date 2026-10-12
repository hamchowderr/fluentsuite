import { defineTool, FluentSuiteError } from "@fluentsuite/core";
import * as z from "zod/v4";
import type { FluentFormsApi } from "../api.js";
import { DATE } from "../format.js";

const Input = z.object({
  after: DATE.optional().describe("Start date. Default: 29 days before `before`."),
  before: DATE.optional().describe("End date. Default: today (site time)."),
  form_id: z.number().int().positive().optional().describe("Only this form. Omit for all forms."),
});

const Bucket = z.object({
  label: z.string(),
  submissions: z.number(),
  read: z.number(),
  unread: z.number(),
  trashed: z.number(),
});

const Output = z.object({
  after: z.string(),
  before: z.string(),
  buckets: z
    .array(Bucket)
    .describe("Fluent Forms groups by day, week or month depending on the range."),
  total: z.number(),
  read_rate: z.number().nullable().describe("Percent of entries in the range that were read."),
  top_forms: z.array(z.object({ id: z.number(), title: z.string(), entries: z.number() })),
  revenue: z
    .object({
      currency: z.string().nullable(),
      buckets: z.array(z.object({ label: z.string(), paid: z.number(), refunded: z.number() })),
      paid_total: z.number(),
    })
    .nullable()
    .describe("Only when a form in scope takes payments. Amounts in the currency's units."),
});

const today = () => new Date().toISOString().slice(0, 10);
const minus = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

export function reportTool(api: FluentFormsApi) {
  return defineTool({
    name: "forms_report",
    title: "Form entries report",
    description:
      "Entries over time for all forms or one form, how many were read, the top forms by entries, and revenue when forms take payments. Default range: the last 30 days.",
    kind: "read",
    input: Input,
    output: Output,
    handler: async (args, ctx) => {
      const before = args.before ?? today();
      const after = args.after ?? minus(before, 29);
      if (after > before)
        throw new FluentSuiteError("invalid_input", "`after` is later than `before`.");
      if (Date.parse(before) - Date.parse(after) > 366 * 86_400_000) {
        throw new FluentSuiteError("invalid_input", "The range can be at most 366 days.");
      }
      const range = { after, before, formId: args.form_id };
      const [overview, top, forms] = await Promise.all([
        api.overview(range, ctx.signal),
        api.topForms(range, ctx.signal),
        api.listForms({ page: 1, perPage: 100 }, ctx.signal),
      ]);
      const v = overview.overview_chart.values;
      const at = (k: string, i: number) => v[k]?.[i] ?? 0;
      const buckets = overview.overview_chart.dates.map((label, i) => ({
        label,
        submissions: at("submissions", i),
        read: at("read", i),
        unread: at("unread", i),
        trashed: at("trashed", i),
      }));
      const total = buckets.reduce((n, b) => n + b.submissions, 0);
      const read = buckets.reduce((n, b) => n + b.read, 0);
      const readRate = total ? Math.round((read / total) * 1000) / 10 : null;
      const payments = forms.data.some(
        (f) => f.has_payment === "1" && (!args.form_id || f.id === args.form_id),
      );
      let revenue: z.infer<typeof Output>["revenue"] = null;
      if (payments) {
        const r = await api.revenue(range, ctx.signal);
        const rv = r.revenue_chart.values;
        const rb = r.revenue_chart.dates.map((label, i) => ({
          label,
          paid: rv.paid?.[i] ?? 0,
          refunded: rv.refunded?.[i] ?? 0,
        }));
        revenue = {
          currency: (r.revenue_chart as { currency?: string }).currency ?? null,
          buckets: rb,
          paid_total: Math.round(rb.reduce((n, b) => n + b.paid, 0) * 100) / 100,
        };
      }
      const topForms = top.top_performing_forms.map((f) => ({
        id: f.id,
        title: f.title,
        entries: f.value,
      }));
      const text = [
        `${after} to ${before}${args.form_id ? ` (form #${args.form_id})` : ""}: ${total} entries${readRate !== null ? `, ${readRate}% read` : ""}.`,
        buckets.length
          ? `By ${buckets.length > 40 ? "period" : "bucket"}: ${buckets.map((b) => `${b.label} ${b.submissions}`).join(", ")}`
          : "",
        topForms.length
          ? `Top forms: ${topForms
              .slice(0, 5)
              .map((f) => `${f.title} (${f.entries})`)
              .join(", ")}`
          : "",
        revenue
          ? `Revenue: ${revenue.paid_total}${revenue.currency ? ` ${revenue.currency}` : ""} paid in the range.`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      return {
        text,
        structured: {
          after,
          before,
          buckets,
          total,
          read_rate: readRate,
          top_forms: topForms,
          revenue,
        },
      };
    },
  });
}
