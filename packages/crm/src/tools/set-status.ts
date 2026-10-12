import { defineTool, guardedWrite, plural, previewText, writeControls } from "@fluentsuite/core";
import * as z from "zod/v4";
import type { FluentCrmApi } from "../api.js";
import { contactName, loadTaxonomies } from "../segment.js";
import {
  exactlyOneTarget,
  NO_REMARKETING,
  resolveTargets,
  TARGET_MESSAGE,
  targetFields,
} from "../targets.js";
import { ACTION_PREVIEW_URI } from "../views.js";

const Input = z
  .object({
    ...targetFields,
    status: z.enum(["subscribed", "unsubscribed", "pending"]).describe("New global status."),
    ...writeControls,
  })
  .refine(exactlyOneTarget, { message: TARGET_MESSAGE });

const Output = z.object({
  tool: z.string(),
  status: z.enum(["preview", "applied"]),
  new_status: z.string(),
  affected: z.number(),
  contacts: z.array(z.object({ id: z.number(), email: z.string(), from: z.string() })),
  skipped: z.array(z.object({ email: z.string(), reason: z.string() })),
  unknown_emails: z.array(z.string()),
  confirmation_token: z.string().optional(),
  expires_at: z.string().optional(),
});

export function setContactStatusTool(api: FluentCrmApi) {
  return defineTool({
    name: "crm_set_contact_status",
    title: "Set contact status",
    description:
      "Change the global status (subscribed, unsubscribed, pending) of contacts by emails or segment. Never re-subscribes contacts who unsubscribed, bounced or complained. Unsubscribes always need the user's confirmation token, as do bulk changes.",
    kind: "write",
    ui: { resourceUri: ACTION_PREVIEW_URI },
    idempotent: true,
    input: Input,
    output: Output,
    handler: async (args, ctx) => {
      const tax = await loadTaxonomies(api, ctx.signal);
      const { contacts, unknown } = await resolveTargets(api, args, tax, ctx.signal);
      const skipped: Array<{ email: string; reason: string }> = [];
      const changing = contacts.filter((c) => {
        if (c.status === args.status) return false;
        if (args.status !== "unsubscribed" && NO_REMARKETING.has(c.status)) {
          skipped.push({
            email: c.email,
            reason: `status ${c.status}: never re-subscribed by a tool`,
          });
          return false;
        }
        return true;
      });
      const summary = [
        `Set status to ${args.status}: ${plural(changing.length, "contact")} would change.`,
        ...changing
          .slice(0, 10)
          .map((c) => `- ${contactName(c)} <${c.email}>: ${c.status} → ${args.status}`),
        changing.length > 10 ? `- … and ${changing.length - 10} more` : "",
        skipped.length
          ? `Skipped ${skipped.length}: ${skipped
              .slice(0, 5)
              .map((s) => `${s.email} (${s.reason})`)
              .join("; ")}.`
          : "",
        unknown.length ? `No contact for: ${unknown.slice(0, 10).join(", ")}.` : "",
      ]
        .filter(Boolean)
        .join("\n");

      const outcome = await guardedWrite({
        guard: ctx.guard,
        tool: "crm_set_contact_status",
        args,
        // Unsubscribing changes what a contact receives everywhere: always confirm.
        plan: async () => ({
          summary,
          affected: changing.length,
          destructive: args.status === "unsubscribed",
        }),
        execute: async () =>
          api.setStatus(
            changing.map((c) => c.id),
            args.status,
            ctx.signal,
          ),
      });
      const base = {
        new_status: args.status,
        affected: changing.length,
        contacts: changing.map((c) => ({ id: c.id, email: c.email, from: c.status })),
        skipped,
        unknown_emails: unknown,
      };
      if (outcome.status === "preview") {
        return {
          text: previewText("crm_set_contact_status", outcome),
          structured: {
            tool: "crm_set_contact_status",
            status: "preview" as const,
            ...base,
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
        text: `Done. ${plural(changing.length, "contact")} set to ${args.status}.`,
        structured: { tool: "crm_set_contact_status", status: "applied" as const, ...base },
      };
    },
  });
}
