import {
  defineTool,
  FluentSuiteError,
  guardedWrite,
  plural,
  previewText,
  truncate,
  writeControls,
} from "@fluentsuite/core";
import * as z from "zod/v4";
import type { LogRow, SmtpApi } from "../api.js";
import { DATE, EmailRow, toEmailRow } from "../format.js";
import { ACTION_PREVIEW_URI } from "../views.js";
import { requireBridgeSending } from "./send-test-email.js";

export const RESEND_MAX = 50;

const Input = z
  .object({
    ids: z
      .array(z.number().int().positive())
      .min(1)
      .max(RESEND_MAX)
      .optional()
      .describe(`Log ids of failed emails (up to ${RESEND_MAX}).`),
    after: DATE.optional().describe("Or: failed emails on or after this date."),
    before: DATE.optional().describe("Or: failed emails on or before this date."),
    ...writeControls,
  })
  .refine((a) => (a.ids ? !a.after && !a.before : Boolean(a.after || a.before)), {
    message: "Give either ids, or a date range (after and/or before), not both.",
  });

const Output = z.object({
  tool: z.string(),
  status: z.enum(["preview", "applied"]),
  count: z.number(),
  sample: z.array(z.object({ name: z.string(), email: z.string(), subject: z.string() })),
  emails: z.array(EmailRow),
  simulate_mode: z.boolean(),
  results: z
    .array(z.object({ id: z.number(), status: z.string(), error: z.string().nullable() }))
    .optional(),
  confirmation_token: z.string().optional(),
  expires_at: z.string().optional(),
});

async function selectFailed(
  api: SmtpApi,
  args: z.infer<typeof Input>,
  signal: AbortSignal | undefined,
): Promise<LogRow[]> {
  if (args.ids) {
    const ids = [...new Set(args.ids)];
    const page = await api.logs({ ids }, { page: 1, perPage: 100 }, signal);
    const found = new Map(page.data.map((r) => [r.id, r]));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) {
      throw new FluentSuiteError("not_found", `No logged email with id ${missing.join(", ")}.`, {
        hint: "Find failed emails with smtp_find_email_logs status=failed.",
      });
    }
    const notFailed = page.data.filter((r) => r.status !== "failed");
    if (notFailed.length) {
      throw new FluentSuiteError(
        "invalid_input",
        `Only failed emails can be resent. Not failed: ${notFailed.map((r) => `#${r.id} (${r.status})`).join(", ")}.`,
      );
    }
    return ids.map((id) => found.get(id) as LogRow);
  }
  const page = await api.logs(
    { status: "failed", after: args.after, before: args.before },
    { page: 1, perPage: RESEND_MAX + 1 },
    signal,
  );
  if (page.total > RESEND_MAX) {
    throw new FluentSuiteError(
      "invalid_input",
      `${page.total} failed emails match; at most ${RESEND_MAX} can be resent at once.`,
      { hint: "Narrow the date range, or pass ids." },
    );
  }
  if (!page.total) throw new FluentSuiteError("invalid_input", "No failed emails in that range.");
  return page.data;
}

export function resendFailedEmailsTool(api: SmtpApi) {
  return defineTool({
    name: "smtp_resend_failed_emails",
    title: "Resend failed emails",
    description: `Resend failed emails from FluentSMTP's log, chosen by ids or as 'failed in this date range' (up to ${RESEND_MAX}). Each goes only to its original recipients; there is no way to send it to someone else. Always previews first (count, sample recipients and subjects, the original errors) and needs the user's confirmation token, which is bound to exactly the previewed emails.`,
    kind: "write",
    ui: { resourceUri: ACTION_PREVIEW_URI },
    sendsEmail: true,
    input: Input,
    output: Output,
    handler: async (args, ctx) => {
      const status = await api.status(ctx.signal);
      requireBridgeSending(status);
      const selected = await selectFailed(api, args, ctx.signal);
      const ids = selected.map((r) => r.id).sort((a, b) => a - b);
      const rows = selected.map(toEmailRow);
      const sample = selected.slice(0, 5).map((r) => {
        const row = toEmailRow(r);
        const to = r.to[0];
        return {
          name: to?.name ?? to?.email ?? "?",
          email: to?.email ?? "?",
          subject: truncate(row.subject, 60),
        };
      });
      const errors = new Map<string, number>();
      for (const r of rows)
        errors.set(r.error ?? "(no error)", (errors.get(r.error ?? "(no error)") ?? 0) + 1);
      const simulate = status.simulate.enabled;
      // The token covers the exact emails previewed: if the selection changes, it no longer matches.
      const tokenArgs = { ...args, selected_ids: ids };
      const outcome = await guardedWrite({
        guard: ctx.guard,
        tool: "smtp_resend_failed_emails",
        args: tokenArgs,
        plan: async () => ({
          summary: [
            `Resend ${plural(ids.length, "failed email")} to their original recipients.`,
            ...rows
              .slice(0, 10)
              .map((r) => `- #${r.id} to ${r.to.join(", ")}: "${truncate(r.subject, 60)}"`),
            rows.length > 10 ? `- … and ${rows.length - 10} more` : "",
            `Original errors: ${[...errors].map(([e, n]) => `${n}× ${truncate(e, 80)}`).join("; ")}`,
            simulate
              ? "Simulate mode is ON: FluentSMTP will only log them; nothing actually leaves the site."
              : "Simulate mode is off: these are real emails.",
          ]
            .filter(Boolean)
            .join("\n"),
          affected: ids.length,
          sendsEmail: true,
        }),
        execute: async () => api.resend(ids, ctx.signal),
      });
      const base = {
        tool: "smtp_resend_failed_emails",
        count: ids.length,
        sample,
        emails: rows,
        simulate_mode: simulate,
      };
      if (outcome.status === "preview") {
        return {
          text: previewText("smtp_resend_failed_emails", outcome),
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
      const results = outcome.result.results.map((r) => ({
        id: r.id,
        status: r.status,
        error: r.error ? (r.error.length > 200 ? `${r.error.slice(0, 200)}…` : r.error) : null,
      }));
      const tally = (s: string) => results.filter((r) => r.status === s).length;
      return {
        text: [
          `Resent ${plural(ids.length, "email")}${outcome.result.simulated ? " (simulated: logged, not sent)" : ""}: ${tally("sent")} sent, ${tally("failed")} failed, ${tally("skipped")} skipped.`,
          ...results
            .filter((r) => r.status !== "sent")
            .map((r) => `- #${r.id} ${r.status}: ${r.error ?? ""}`),
        ].join("\n"),
        structured: { ...base, status: "applied" as const, results },
      };
    },
  });
}
