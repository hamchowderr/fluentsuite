import {
  decodeCursor,
  defineTool,
  FluentSuiteError,
  pageInfo,
  pagingLine,
} from "@fluentsuite/core";
import * as z from "zod/v4";
import type { FluentFormsApi, FormDetail } from "../api.js";
import { DATE, EntryRow, entryLine, toEntryRow } from "../format.js";

const Input = z.object({
  form_id: z.number().int().positive().optional().describe("Only this form. Omit for all forms."),
  status: z
    .enum(["unread", "read", "favorites", "trashed"])
    .optional()
    .describe("Default: every entry except trashed ones."),
  after: DATE.optional().describe("On or after this date."),
  before: DATE.optional().describe("On or before this date."),
  search: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Text matched by Fluent Forms against every stored value of an entry, including fields shown as [redacted] elsewhere.",
    ),
  per_page: z.number().int().min(1).max(100).default(20),
  cursor: z.string().max(500).optional().describe("From a previous call, to get the next page."),
});

const Output = z.object({
  total: z.number(),
  page: z.number(),
  per_page: z.number(),
  next_cursor: z.string().optional(),
  entries: z.array(EntryRow),
});

export function findEntriesTool(api: FluentFormsApi) {
  return defineTool({
    name: "forms_find_entries",
    title: "Find form entries",
    description:
      "Find Fluent Forms entries for one form or all forms, by status (unread, read, favorites, trashed), date range or search. Newest first. Short rows only: a name, an email, the date and payment status; no other field values, files or IP addresses (use forms_entry_detail for one entry). Note: search runs on Fluent Forms' side over every stored value, including fields shown as [redacted], so searching for a known value (say a tax id) reveals which entry holds it.",
    kind: "read",
    input: Input,
    output: Output,
    handler: async (args, ctx) => {
      const { cursor, per_page, ...filter } = args;
      if (filter.after && filter.before && filter.after > filter.before) {
        throw new FluentSuiteError("invalid_input", "`after` is later than `before`.");
      }
      const page = decodeCursor("forms_find_entries", filter, cursor, per_page);
      const res = await api.entries(
        {
          formId: filter.form_id,
          type: filter.status,
          after: filter.after,
          before: filter.before,
          search: filter.search,
        },
        page,
        ctx.signal,
      );
      const info = pageInfo("forms_find_entries", filter, res);
      const forms = new Map<number, FormDetail>();
      await Promise.all(
        [...new Set(res.data.map((e) => e.form_id))].map(async (id) =>
          forms.set(id, await api.form(id, ctx.signal)),
        ),
      );
      const rows = res.data.map((e) => toEntryRow(e, forms.get(e.form_id)));
      const label = [
        filter.status ? `${filter.status} entries` : "Entries",
        filter.form_id
          ? `on form ${forms.get(filter.form_id)?.title ?? `#${filter.form_id}`}`
          : "on all forms",
        filter.after || filter.before
          ? `from ${filter.after ?? "the start"} to ${filter.before ?? "today"}`
          : "",
        filter.search ? `matching "${filter.search}"` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return {
        text: [
          `${label}: ${info.total} found.`,
          ...rows.map(entryLine),
          pagingLine(info, "entries"),
        ].join("\n"),
        structured: {
          total: info.total,
          page: info.page,
          per_page: info.perPage,
          ...(info.nextCursor ? { next_cursor: info.nextCursor } : {}),
          entries: rows,
        },
      };
    },
  });
}
