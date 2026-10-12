import {
  defineTool,
  guardedWrite,
  plural,
  previewText,
  truncate,
  writeControls,
} from "@fluentsuite/core";
import * as z from "zod/v4";
import type { DeleteCriteria, SmtpApi } from "../api.js";
import { EmailRow, toEmailRow } from "../format.js";
import { ACTION_PREVIEW_URI } from "../views.js";

const Input = z
  .object({
    ids: z.array(z.number().int().positive()).min(1).max(500).optional().describe("Log ids."),
    to: z
      .email()
      .max(254)
      .optional()
      .describe("Every log addressed to this exact recipient (for privacy requests)."),
    older_than_days: z
      .number()
      .int()
      .min(1)
      .max(3650)
      .optional()
      .describe("Every log older than this many days."),
    status: z.enum(["sent", "failed"]).optional().describe("Only sent or only failed logs."),
    ...writeControls,
  })
  .refine((a) => [a.ids, a.to, a.older_than_days].filter((x) => x !== undefined).length === 1, {
    message: 'Give exactly one of ids, to or older_than_days. There is no "delete all".',
  });

const Output = z.object({
  tool: z.string(),
  status: z.enum(["preview", "applied"]),
  count: z.number(),
  sample: z.array(EmailRow),
  deleted: z.number().optional(),
  confirmation_token: z.string().optional(),
  expires_at: z.string().optional(),
});

function describe(c: DeleteCriteria): string {
  const what = c.status ? `${c.status} email logs` : "email logs";
  if (c.ids)
    return `${what} with ids ${c.ids.slice(0, 10).join(", ")}${c.ids.length > 10 ? ", …" : ""}`;
  if (c.to) return `${what} addressed to ${c.to}`;
  return `${what} older than ${c.older_than_days} days`;
}

export function deleteEmailLogsTool(api: SmtpApi) {
  return defineTool({
    name: "smtp_delete_email_logs",
    title: "Delete email logs",
    description:
      'Delete FluentSMTP email logs by ids, by exact recipient (privacy requests) or by age, optionally only sent or failed. There is no "delete all". Always previews how many would go and needs the user\'s confirmation token; the token is bound to the previewed count.',
    kind: "write",
    ui: { resourceUri: ACTION_PREVIEW_URI },
    destructive: true,
    input: Input,
    output: Output,
    handler: async (args, ctx) => {
      const criteria: DeleteCriteria = {
        ids: args.ids,
        to: args.to,
        older_than_days: args.older_than_days,
        status: args.status,
      };
      const preview = await api.previewDelete(criteria, ctx.signal);
      const sample = preview.sample.map(toEmailRow);
      const label = describe(criteria);
      if (preview.count === 0) {
        return {
          text: `No ${label}. Nothing to delete.`,
          structured: {
            tool: "smtp_delete_email_logs",
            status: "preview" as const,
            count: 0,
            sample,
          },
        };
      }
      // The token covers the count at preview time; if more logs match later, it no longer matches.
      const tokenArgs = { ...args, expected_count: preview.count };
      const outcome = await guardedWrite({
        guard: ctx.guard,
        tool: "smtp_delete_email_logs",
        args: tokenArgs,
        plan: async () => ({
          summary: [
            `Delete ${plural(preview.count, "email log")}: ${label}. This cannot be undone.`,
            ...sample.map(
              (r) =>
                `- #${r.id} ${r.created_at ?? "?"} · ${r.status} · to ${r.to.join(", ")} · "${truncate(r.subject, 60)}"`,
            ),
            preview.count > sample.length ? `- … and ${preview.count - sample.length} more` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          affected: preview.count,
          destructive: true,
        }),
        execute: async () => api.deleteLogs(criteria, preview.count, ctx.signal),
      });
      const base = { tool: "smtp_delete_email_logs", count: preview.count, sample };
      if (outcome.status === "preview") {
        return {
          text: previewText("smtp_delete_email_logs", outcome),
          structured: {
            ...base,
            status: "preview" as const,
            ...(outcome.confirmation
              ? {
                  confirmation_token: outcome.confirmation.token,
                  expires_at: outcome.confirmation.expiresAt,
                }
              : {}),
          },
        };
      }
      return {
        text: `Done. Deleted ${plural(outcome.result.deleted, "email log")} (${label}).`,
        structured: { ...base, status: "applied" as const, deleted: outcome.result.deleted },
      };
    },
  });
}
