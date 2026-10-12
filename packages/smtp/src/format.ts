import { joinLimited, truncate } from "@fluentsuite/core";
import * as z from "zod/v4";
import type { LogRow, Recipient } from "./api.js";
import { maskSecrets } from "./mask.js";

/** The short, masked row every SMTP tool shows for a logged email. */
export const EmailRow = z.object({
  id: z.number(),
  created_at: z.string().nullable(),
  status: z.string(),
  to: z.array(z.string()),
  subject: z.string(),
  source: z.string().nullable(),
  error: z.string().nullable(),
  retries: z.number(),
});
export type EmailRow = z.infer<typeof EmailRow>;

export function recipient(r: Recipient): string {
  return r.name ? `${r.name} <${r.email}>` : r.email;
}

/** Subjects and errors are masked: subjects can carry one-time codes, errors can echo links. */
export function toEmailRow(r: LogRow): EmailRow {
  return {
    id: r.id,
    created_at: r.created_at ?? null,
    status: r.status,
    to: r.to.map((x) => x.email),
    subject: maskSecrets(r.subject ?? ""),
    source: r.source ?? null,
    error: r.error ? maskSecrets(r.error) : null,
    retries: r.retries,
  };
}

export function emailLine(r: EmailRow): string {
  const err = r.status === "failed" && r.error ? ` · ${truncate(r.error, 90)}` : "";
  return `- #${r.id} ${r.created_at ?? "?"} · ${r.status} · to ${joinLimited(r.to, 3)} · "${truncate(r.subject, 70)}"${r.source ? ` · ${r.source}` : ""}${err}`;
}

export function failureRate(c: { sent: number; failed: number }): number | null {
  const total = c.sent + c.failed;
  return total ? Math.round((c.failed / total) * 1000) / 10 : null;
}

export const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
  .describe("A date in the site's timezone, YYYY-MM-DD.");
