import { defineTool, joinLimited, truncate } from "@fluentsuite/core";
import * as z from "zod/v4";
import type { SmtpApi } from "../api.js";
import { recipient } from "../format.js";
import { htmlToText, maskSecrets } from "../mask.js";

/** The most body text shown, after HTML is turned into text and secrets are masked. */
export const BODY_LIMIT = 2000;

const Input = z.object({
  id: z.number().int().positive().describe("Log id, from smtp_find_email_logs or smtp_status."),
  include_body: z
    .boolean()
    .default(false)
    .describe(
      `Also return the message as plain text (up to ${BODY_LIMIT} characters). Links and one-time codes are masked.`,
    ),
});

const Output = z.object({
  id: z.number(),
  created_at: z.string().nullable(),
  status: z.string(),
  to: z.array(z.string()),
  from: z.string().nullable(),
  subject: z.string(),
  source: z.string().nullable(),
  provider: z.string().nullable(),
  response: z.string().nullable().describe("Provider response or error, masked."),
  retries: z.number(),
  resent_count: z.number(),
  send_time_ms: z.number().nullable(),
  headers: z.array(z.object({ name: z.string(), value: z.string() })),
  attachments: z.array(z.string()).describe("File names only."),
  body: z.string().optional(),
  body_truncated: z.boolean().optional(),
  log_url: z.string(),
});

export function emailDetailTool(api: SmtpApi) {
  return defineTool({
    name: "smtp_email_detail",
    title: "Logged email detail",
    description:
      "One email from FluentSMTP's log: recipients, sender, subject, status, the provider's response or error, retries, source, headers and attachment names. With include_body, the message as plain text (capped), with password-reset, login, magic and verification links and one-time codes masked.",
    kind: "read",
    input: Input,
    output: Output,
    handler: async (args, ctx) => {
      const e = await api.log(args.id, args.include_body, ctx.signal);
      const headers = e.headers.map((h) => ({ name: h.name, value: maskSecrets(h.value) }));
      let body: string | undefined;
      let bodyTruncated: boolean | undefined;
      if (args.include_body) {
        const text = maskSecrets(htmlToText(e.body ?? ""));
        bodyTruncated = Boolean(e.body_truncated) || text.length > BODY_LIMIT;
        body = text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT)}…` : text;
      }
      const subject = maskSecrets(e.subject ?? "");
      const response = e.response ? maskSecrets(e.response) : null;
      const out = {
        id: e.id,
        created_at: e.created_at ?? null,
        status: e.status,
        to: e.to.map((r) => r.email),
        from: e.from ?? null,
        subject,
        source: e.source ?? null,
        provider: e.provider ?? null,
        response,
        retries: e.retries,
        resent_count: e.resent_count,
        send_time_ms: e.send_time_ms ?? null,
        headers,
        attachments: e.attachments,
        ...(body !== undefined ? { body, body_truncated: bodyTruncated } : {}),
        log_url: api.logsUrl(),
      };
      const text = [
        `Email #${e.id} · ${e.status} · ${e.created_at ?? "?"}`,
        `To: ${joinLimited(e.to.map(recipient), 5)}`,
        `From: ${e.from ?? "?"}`,
        `Subject: ${subject}`,
        `Source: ${e.source ?? "unknown"} · provider: ${e.provider ?? "unknown"} · retries: ${e.retries} · resent: ${e.resent_count}`,
        response
          ? `${e.status === "failed" ? "Error" : "Response"}: ${truncate(response, 300)}`
          : "",
        e.attachments.length ? `Attachments: ${joinLimited(e.attachments, 5)}` : "",
        body !== undefined ? `--- Body (plain text, secrets masked) ---\n${body || "(empty)"}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return { text, structured: out };
    },
  });
}
