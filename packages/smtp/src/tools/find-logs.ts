import {
  decodeCursor,
  defineTool,
  FluentSuiteError,
  pageInfo,
  pagingLine,
} from "@fluentsuite/core";
import * as z from "zod/v4";
import type { SmtpApi } from "../api.js";
import { DATE, EmailRow, emailLine, toEmailRow } from "../format.js";

const text = (what: string) => z.string().trim().min(1).max(200).optional().describe(what);

const Input = z.object({
  status: z.enum(["sent", "failed"]).optional().describe("Only sent or only failed emails."),
  after: DATE.optional().describe("On or after this date (site timezone, YYYY-MM-DD)."),
  before: DATE.optional().describe("On or before this date (site timezone, YYYY-MM-DD)."),
  to: text("Recipient email, or part of it."),
  subject: text("Part of the subject."),
  source: text("Exact sending source as logged, e.g. 'FluentCRM' or 'WordPress'."),
  search: text("Text matched against recipient, sender and subject."),
  per_page: z.number().int().min(1).max(100).default(20),
  cursor: z.string().max(500).optional().describe("From a previous call, to get the next page."),
});

const Output = z.object({
  total: z.number(),
  page: z.number(),
  per_page: z.number(),
  next_cursor: z.string().optional(),
  emails: z.array(EmailRow),
});

export function findEmailLogsTool(api: SmtpApi) {
  return defineTool({
    name: "smtp_find_email_logs",
    title: "Find logged emails",
    description:
      "Search FluentSMTP's email log by status (sent/failed), date range, recipient, subject, source or free text. Newest first, short rows with the error for failed emails; no message bodies (use smtp_email_detail for one email). Links and one-time codes in subjects and errors are masked.",
    kind: "read",
    input: Input,
    output: Output,
    handler: async (args, ctx) => {
      const { cursor, per_page, ...filter } = args;
      if (filter.after && filter.before && filter.after > filter.before) {
        throw new FluentSuiteError("invalid_input", "`after` is later than `before`.");
      }
      const page = decodeCursor("smtp_find_email_logs", filter, cursor, per_page);
      const res = await api.logs(filter, page, ctx.signal);
      const info = pageInfo("smtp_find_email_logs", filter, res);
      const rows = res.data.map(toEmailRow);
      const what = describe(filter);
      return {
        text: [
          `${what}: ${info.total} found.`,
          ...rows.map(emailLine),
          pagingLine(info, "emails"),
        ].join("\n"),
        structured: {
          total: info.total,
          page: info.page,
          per_page: info.perPage,
          ...(info.nextCursor ? { next_cursor: info.nextCursor } : {}),
          emails: rows,
        },
      };
    },
  });
}

function describe(f: Omit<z.infer<typeof Input>, "cursor" | "per_page">): string {
  const parts = [
    f.status ? `${f.status} emails` : "Logged emails",
    f.after || f.before ? `from ${f.after ?? "the start"} to ${f.before ?? "today"}` : "",
    f.to ? `to "${f.to}"` : "",
    f.subject ? `subject containing "${f.subject}"` : "",
    f.source ? `from source ${f.source}` : "",
    f.search ? `matching "${f.search}"` : "",
  ];
  return parts.filter(Boolean).join(" ");
}
