import { defineTool, guardedWrite, previewText, writeControls } from "@fluentsuite/core";
import * as z from "zod/v4";
import type { FluentFormsApi } from "../api.js";
import { EntryRow, entryLine, toEntryRow } from "../format.js";

const Input = z.object({
  entry_id: z.number().int().positive().describe("The entry, from forms_find_entries."),
  form_id: z.number().int().positive().optional().describe("The entry's form, if known."),
  note: z.string().trim().min(1).max(2000).describe("Plain text. HTML is removed."),
  ...writeControls,
});

const Output = z.object({
  tool: z.string(),
  status: z.enum(["preview", "applied"]),
  entry: EntryRow,
  note: z.string(),
});

/** Notes are stored as plain text: tags removed, whitespace kept tidy. */
export function plainNote(note: string): string {
  return note
    .replace(/<[^>]*>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export function addEntryNoteTool(api: FluentFormsApi) {
  return defineTool({
    name: "forms_add_entry_note",
    title: "Add entry note",
    description:
      "Add an internal note to a Fluent Forms entry (only admins see it; nothing is sent to the person). Previews first.",
    kind: "write",
    input: Input,
    output: Output,
    handler: async (args, ctx) => {
      const raw = await api.findEntry(args.entry_id, args.form_id, ctx.signal);
      const form = await api.form(raw.form_id, ctx.signal);
      const entry = toEntryRow(raw, form);
      const note = plainNote(args.note);
      const outcome = await guardedWrite({
        guard: ctx.guard,
        tool: "forms_add_entry_note",
        args,
        plan: async () => ({
          summary: [
            "Add an internal note to:",
            entryLine(entry),
            `Note: ${note}`,
            "Fires Fluent Forms' fluentform/submission_note_stored hook (nothing in free Fluent Forms listens to it). Sends nothing.",
          ].join("\n"),
          affected: 1,
        }),
        execute: async () => api.addNote(raw.id, note, ctx.signal),
      });
      const base = { tool: "forms_add_entry_note", entry, note };
      if (outcome.status === "preview") {
        return {
          text: previewText("forms_add_entry_note", outcome),
          structured: { ...base, status: "preview" as const },
        };
      }
      return {
        text: `Done. Note added to entry #${raw.id}.`,
        structured: { ...base, status: "applied" as const },
      };
    },
  });
}
