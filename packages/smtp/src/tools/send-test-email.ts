import {
  defineTool,
  FluentSuiteError,
  guardedWrite,
  previewText,
  writeControls,
} from "@fluentsuite/core";
import * as z from "zod/v4";
import type { SmtpApi, Status } from "../api.js";
import { ACTION_PREVIEW_URI } from "../views.js";

const Input = z.object({
  to: z.email().max(254).describe("The one address that gets FluentSMTP's test email."),
  from: z
    .email()
    .max(254)
    .optional()
    .describe(
      "Sender address to test (one of FluentSMTP's sender addresses, see smtp_status). Default: the default connection.",
    ),
  ...writeControls,
});

const Output = z.object({
  tool: z.string(),
  status: z.enum(["preview", "applied"]),
  to: z.string(),
  from: z.string().nullable(),
  connection: z.string().nullable(),
  simulate_mode: z.boolean(),
  sent: z.boolean().optional(),
  error: z.string().nullable().optional(),
  confirmation_token: z.string().optional(),
  expires_at: z.string().optional(),
});

/** Refuses early, with the fix, when the site's bridge has sending turned off. */
export function requireBridgeSending(status: Status): void {
  if (!status.bridge.sending_allowed) {
    throw new FluentSuiteError(
      "forbidden",
      "Sending is turned off in the FluentSuite Bridge on this site, so nothing can be sent from here.",
      {
        hint: "The site owner can allow it with define('FLUENTSUITE_BRIDGE_ALLOW_SENDING', true); in wp-config.php.",
      },
    );
  }
}

export function sendTestEmailTool(api: SmtpApi) {
  return defineTool({
    name: "smtp_send_test_email",
    title: "Send test email",
    description:
      "Send FluentSMTP's standard test email to one address, through the default connection or a chosen sender address, to check that the site can send. Always previews first (from, connection, to, simulate mode) and needs the user's confirmation token.",
    kind: "write",
    ui: { resourceUri: ACTION_PREVIEW_URI },
    sendsEmail: true,
    input: Input,
    output: Output,
    handler: async (args, ctx) => {
      const status = await api.status(ctx.signal);
      requireBridgeSending(status);
      const from = args.from?.toLowerCase();
      const connection = from
        ? status.connections.find((c) => c.senders.some((s) => s.toLowerCase() === from))
        : (status.connections.find((c) => c.is_default) ?? status.connections[0]);
      if (from && !connection) {
        throw new FluentSuiteError(
          "invalid_input",
          `${args.from} is not one of FluentSMTP's sender addresses.`,
          {
            hint: `Use one of: ${status.connections.flatMap((c) => c.senders).join(", ") || "(none set up)"}.`,
          },
        );
      }
      if (!connection) {
        throw new FluentSuiteError("invalid_input", "FluentSMTP has no connection set up.", {
          hint: "Set up a connection in FluentSMTP first.",
        });
      }
      const simulate = status.simulate.enabled;
      const outcome = await guardedWrite({
        guard: ctx.guard,
        tool: "smtp_send_test_email",
        args,
        plan: async () => ({
          summary: [
            `Send FluentSMTP's test email to ${args.to}.`,
            `- From: ${args.from ?? connection.sender_email ?? "the default sender"}`,
            `- Connection: ${connection.title} (${connection.provider})`,
            simulate
              ? "- Simulate mode is ON: FluentSMTP will only log it; nothing actually leaves the site."
              : "- Simulate mode is off: this sends a real email.",
          ].join("\n"),
          affected: 1,
          sendsEmail: true,
        }),
        execute: async () => api.testEmail(args.to, from, ctx.signal),
      });
      const base = {
        tool: "smtp_send_test_email",
        to: args.to,
        from: args.from ?? connection.sender_email ?? null,
        connection: connection.title,
        simulate_mode: simulate,
      };
      if (outcome.status === "preview") {
        return {
          text: previewText("smtp_send_test_email", outcome),
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
      const r = outcome.result;
      return {
        text: r.sent
          ? `Test email ${r.simulated ? "simulated (logged, not sent: simulate mode is on)" : "sent"} to ${args.to}.`
          : `The test email to ${args.to} failed: ${r.error ?? "unknown error"}`,
        structured: { ...base, status: "applied" as const, sent: r.sent, error: r.error ?? null },
      };
    },
  });
}
