import { defineTool, guardedWrite, previewText, truncate, writeControls } from "@fluentsuite/core";
import * as z from "zod/v4";
import type { FluentCrmApi } from "../api.js";
import { contactName } from "../segment.js";

const NOTE_TYPES = ["note", "call", "email", "meeting", "quote_sent", "activity"] as const;

const Input = z
  .object({
    email: z.email().max(254).optional().describe("Contact's exact email."),
    id: z.number().int().positive().optional().describe("Contact id, if known."),
    title: z
      .string()
      .trim()
      .min(1)
      .max(190)
      .describe("Short summary, e.g. 'Call: asked about annual pricing'."),
    description: z.string().trim().max(10_000).default("").describe("Details. Plain text."),
    type: z.enum(NOTE_TYPES).default("note"),
    ...writeControls,
  })
  .refine((v) => v.email !== undefined || v.id !== undefined, { message: "Provide email or id." });

const Output = z.object({
  status: z.enum(["preview", "applied"]),
  contact: z.object({ id: z.number(), email: z.string() }),
  note_id: z.number().nullable(),
});

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function addContactNoteTool(api: FluentCrmApi) {
  return defineTool({
    name: "crm_add_contact_note",
    title: "Add contact note",
    description:
      "Log a note, call, email, meeting or quote on a contact's FluentCRM timeline. Previews first (dry_run defaults to true).",
    kind: "write",
    input: Input,
    output: Output,
    handler: async (args, ctx) => {
      const c = await api.getContact(
        args.id !== undefined ? { id: args.id } : { email: args.email ?? "" },
        ctx.signal,
      );
      const outcome = await guardedWrite({
        guard: ctx.guard,
        tool: "crm_add_contact_note",
        args,
        plan: async () => ({
          summary: `Add a ${args.type} to ${contactName(c)} <${c.email}>: "${truncate(args.title, 80)}"${args.description ? `\n${truncate(args.description, 300)}` : ""}`,
          affected: 1,
        }),
        execute: async () =>
          api.addNote(
            c.id,
            {
              title: args.title,
              type: args.type,
              description: args.description
                ? args.description
                    .split(/\n{2,}/)
                    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
                    .join("")
                : "",
            },
            ctx.signal,
          ),
      });
      const contact = { id: c.id, email: c.email };
      if (outcome.status === "preview") {
        return {
          text: previewText("crm_add_contact_note", outcome),
          structured: { status: "preview" as const, contact, note_id: null },
        };
      }
      return {
        text: `Done. ${args.type} logged on ${contactName(c)} (note #${outcome.result}).`,
        structured: { status: "applied" as const, contact, note_id: outcome.result },
      };
    },
  });
}
