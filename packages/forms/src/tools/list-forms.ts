import { decodeCursor, defineTool, pageInfo, pagingLine } from "@fluentsuite/core";
import * as z from "zod/v4";
import type { FluentFormsApi } from "../api.js";

const Input = z.object({
  search: z.string().trim().min(1).max(100).optional().describe("Part of the form title."),
  per_page: z.number().int().min(1).max(25).default(20),
  cursor: z.string().max(500).optional().describe("From a previous call, to get the next page."),
});

const Output = z.object({
  total: z.number(),
  page: z.number(),
  per_page: z.number(),
  next_cursor: z.string().optional(),
  forms: z.array(
    z.object({
      id: z.number(),
      title: z.string(),
      status: z.string(),
      takes_payments: z.boolean(),
      entries: z.number().describe("Entries, not counting trashed ones."),
      unread: z.number(),
      last_entry_at: z.string().nullable(),
      created_at: z.string().nullable(),
    }),
  ),
});

export function listFormsTool(api: FluentFormsApi) {
  return defineTool({
    name: "forms_list",
    title: "List forms",
    description:
      "Fluent Forms forms with their status, entry counts (total and unread), last entry date and whether they take payments. Search by title. Start here to find a form's id.",
    kind: "read",
    input: Input,
    output: Output,
    handler: async (args, ctx) => {
      const query = { search: args.search };
      const page = decodeCursor("forms_list", query, args.cursor, args.per_page);
      const res = await api.listForms({ ...query, ...page }, ctx.signal);
      const info = pageInfo("forms_list", query, res);
      // Latest entry per form: one small request each, for the forms on this page only.
      const latest = await Promise.all(
        res.data.map((f) =>
          api
            .entries({ formId: f.id }, { page: 1, perPage: 1 }, ctx.signal)
            .then((p) => p.data[0]?.created_at ?? null),
        ),
      );
      const forms = res.data.map((f, i) => ({
        id: f.id,
        title: f.title,
        status: f.status,
        takes_payments: f.has_payment === "1",
        entries: f.total_Submissions ?? 0,
        unread: f.unread_count ?? 0,
        last_entry_at: latest[i] ?? null,
        created_at: f.created_at ?? null,
      }));
      const text = [
        `${info.total} forms${args.search ? ` matching "${args.search}"` : ""}.`,
        ...forms.map(
          (f) =>
            `- #${f.id} ${f.title} · ${f.status} · ${f.entries} entries (${f.unread} unread)${f.last_entry_at ? ` · last ${f.last_entry_at}` : ""}${f.takes_payments ? " · payments" : ""}`,
        ),
        pagingLine(info, "forms"),
      ].join("\n");
      return {
        text,
        structured: {
          total: info.total,
          page: info.page,
          per_page: info.perPage,
          ...(info.nextCursor ? { next_cursor: info.nextCursor } : {}),
          forms,
        },
      };
    },
  });
}
