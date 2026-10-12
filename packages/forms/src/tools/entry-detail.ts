import { defineTool, maskSecrets, truncate } from "@fluentsuite/core";
import * as z from "zod/v4";
import type { FluentFormsApi } from "../api.js";
import { money, parseResponse } from "../format.js";
import { showField } from "../pii.js";

const Input = z.object({
  id: z.number().int().positive().describe("Entry id, from forms_find_entries."),
  form_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("The entry's form, if known (from forms_find_entries). Makes the lookup faster."),
  fields: z
    .array(z.string().trim().min(1).max(100))
    .max(50)
    .optional()
    .describe("Only these fields, by name or label. Default: all."),
  include_notes: z.boolean().default(false).describe("Also return the entry's internal notes."),
});

const Output = z.object({
  id: z.number(),
  form_id: z.number(),
  form: z.string(),
  created_at: z.string().nullable(),
  status: z.string(),
  favorite: z.boolean(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  source_url: z.string().nullable(),
  fields: z.array(
    z.object({
      name: z.string(),
      label: z.string(),
      type: z.string(),
      value: z.string(),
      files: z.array(z.string()).optional().describe("Uploaded file names only."),
      redacted: z.boolean().optional(),
    }),
  ),
  hidden_fields: z.array(z.string()).describe("Fields never shown (password fields)."),
  payment: z
    .object({
      status: z.string().nullable(),
      method: z.string().nullable(),
      type: z.string().nullable(),
      total: z.string().nullable(),
      paid: z.string().nullable(),
    })
    .nullable(),
  notes: z
    .array(z.object({ by: z.string().nullable(), at: z.string().nullable(), text: z.string() }))
    .optional(),
  entry_url: z.string(),
});

export function entryDetailTool(api: FluentFormsApi, redactPatterns: readonly string[]) {
  return defineTool({
    name: "forms_entry_detail",
    title: "Form entry detail",
    description:
      "One Fluent Forms entry, every field by its label. Uploads show file names only; password fields are never shown; sensitive-looking fields (tax id, card, passport, …) show [redacted]; links and one-time codes are masked; IP address, browser and device are left out. Payment amounts and status are included. Optionally its internal notes. Reading an entry here does not mark it as read.",
    kind: "read",
    input: Input,
    output: Output,
    handler: async (args, ctx) => {
      const raw = await api.findEntry(args.id, args.form_id, ctx.signal);
      const form = await api.form(raw.form_id, ctx.signal);
      const response = parseResponse(raw);
      const wanted = args.fields?.map((f) => f.toLowerCase());
      const fields: z.infer<typeof Output>["fields"] = [];
      const hidden: string[] = [];
      for (const def of form.fields) {
        if (
          wanted &&
          !wanted.includes(def.name.toLowerCase()) &&
          !wanted.includes(def.label.toLowerCase())
        ) {
          continue;
        }
        const shown = showField(def, response[def.name], redactPatterns);
        if (shown.kind === "omitted") {
          hidden.push(def.label);
          continue;
        }
        fields.push({
          name: def.name,
          label: def.label,
          type: def.element,
          value: shown.value,
          ...(shown.kind === "files" ? { files: shown.files } : {}),
          ...(shown.kind === "redacted" ? { redacted: true } : {}),
        });
      }
      const payment =
        raw.payment_status || raw.payment_total
          ? {
              status: raw.payment_status ?? null,
              method: raw.payment_method ?? null,
              type: raw.payment_type ?? null,
              total: money(raw.payment_total, raw.currency),
              paid: money(raw.total_paid, raw.currency),
            }
          : null;
      const notes = args.include_notes
        ? (await api.notes(raw.id, ctx.signal)).map((n) => ({
            by: n.created_by ?? n.name ?? null,
            at: n.created_at ?? null,
            text: truncate(maskSecrets((n.value ?? "").replace(/<[^>]+>/g, " ")), 500),
          }))
        : undefined;
      const sourceUrl = raw.source_url ? maskSecrets(raw.source_url) : null;
      const out = {
        id: raw.id,
        form_id: raw.form_id,
        form: form.title,
        created_at: raw.created_at ?? null,
        status: raw.status,
        favorite: raw.is_favourite === "1",
        city: raw.city ?? null,
        country: raw.country ?? null,
        source_url: sourceUrl,
        fields,
        hidden_fields: hidden,
        payment,
        ...(notes ? { notes } : {}),
        entry_url: api.entryUrl(raw.form_id, raw.id),
      };
      const text = [
        `Entry #${raw.id} on "${form.title}" · ${raw.status}${out.favorite ? " ★" : ""} · ${raw.created_at ?? "?"}${raw.city || raw.country ? ` · ${[raw.city, raw.country].filter(Boolean).join(", ")}` : ""}`,
        ...fields.map((f) => `- ${f.label}: ${f.value || "(empty)"}`),
        hidden.length ? `Not shown: ${hidden.join(", ")} (password fields).` : "",
        payment
          ? `Payment: ${payment.status ?? "?"} · ${payment.method ?? "?"} · total ${payment.total ?? "?"} · paid ${payment.paid ?? "?"}`
          : "",
        notes
          ? notes.length
            ? `Notes:\n${notes.map((n) => `- ${n.at ?? "?"} ${n.by ?? ""}: ${n.text}`).join("\n")}`
            : "Notes: none"
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      return { text, structured: out };
    },
  });
}
