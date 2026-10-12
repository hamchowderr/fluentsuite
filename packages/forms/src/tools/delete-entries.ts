import {
  defineTool,
  FluentSuiteError,
  guardedWrite,
  plural,
  previewText,
  writeControls,
} from "@fluentsuite/core";
import * as z from "zod/v4";
import type { EntryRaw, FluentFormsApi, FormDetail } from "../api.js";
import { EntryRow, entryLine, parseResponse, toEntryRow } from "../format.js";

/** The most entries one call deletes. */
export const DELETE_CAP = 200;

const Input = z
  .object({
    form_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Required with ids. With trashed_older_than_days or email, limits it to one form."),
    ids: z
      .array(z.number().int().positive())
      .min(1)
      .max(DELETE_CAP)
      .optional()
      .describe("Entry ids."),
    trashed_older_than_days: z
      .number()
      .int()
      .min(1)
      .max(3650)
      .optional()
      .describe("Every TRASHED entry older than this many days."),
    email: z
      .email()
      .max(254)
      .optional()
      .describe("Every entry whose email field is exactly this address (privacy requests)."),
    ...writeControls,
  })
  .refine(
    (a) => [a.ids, a.trashed_older_than_days, a.email].filter((x) => x !== undefined).length === 1,
    {
      message:
        'Give exactly one of ids, trashed_older_than_days or email. There is no "delete all".',
    },
  )
  .refine((a) => !a.ids || a.form_id !== undefined, { message: "form_id is required with ids." });

const Output = z.object({
  tool: z.string(),
  status: z.enum(["preview", "applied"]),
  count: z.number(),
  with_uploads: z.number().describe("Entries whose uploaded files Fluent Forms deletes too."),
  entries: z.array(EntryRow),
  deleted: z.number().optional(),
  confirmation_token: z.string().optional(),
  expires_at: z.string().optional(),
});

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

function hasUploads(e: EntryRaw, form: FormDetail): boolean {
  const response = parseResponse(e);
  return form.fields.some(
    (f) =>
      (f.element === "input_file" || f.element === "input_image") &&
      [response[f.name]].flat().some((v) => typeof v === "string" && v !== ""),
  );
}

function emailMatches(e: EntryRaw, form: FormDetail, email: string): boolean {
  const response = parseResponse(e);
  const target = email.toLowerCase();
  const names = form.fields.filter((f) => f.element === "input_email").map((f) => f.name);
  return (names.length ? names : ["email"]).some(
    (n) => typeof response[n] === "string" && (response[n] as string).toLowerCase() === target,
  );
}

export function deleteEntriesTool(api: FluentFormsApi) {
  return defineTool({
    name: "forms_delete_entries",
    title: "Delete form entries",
    description: `Permanently delete Fluent Forms entries by ids, as "trashed and older than N days", or by an exact email address (privacy requests). Up to ${DELETE_CAP} per call; there is no "delete all". Fluent Forms also deletes the entries' uploaded files. Always previews and needs the user's confirmation token, bound to the previewed count. Cannot be undone.`,
    kind: "write",
    destructive: true,
    input: Input,
    output: Output,
    handler: async (args, ctx) => {
      // Which forms to look in.
      const formIds = args.form_id
        ? [args.form_id]
        : (await api.listForms({ page: 1, perPage: 100 }, ctx.signal)).data.map((f) => f.id);
      const forms = new Map<number, FormDetail>();
      await Promise.all(formIds.map(async (id) => forms.set(id, await api.form(id, ctx.signal))));

      const selected: EntryRaw[] = [];
      const add = (list: EntryRaw[]) => {
        selected.push(...list);
        if (selected.length > DELETE_CAP) {
          throw new FluentSuiteError(
            "invalid_input",
            `More than ${DELETE_CAP} entries match; at most ${DELETE_CAP} can be deleted per call.`,
            { hint: "Narrow it to one form, or delete in batches by ids." },
          );
        }
      };
      for (const formId of formIds) {
        const form = forms.get(formId) as FormDetail;
        if (args.ids) {
          const all = await api.collect({ formId, includeTrashed: true }, 5000, ctx.signal);
          const byId = new Map(all.map((e) => [e.id, e]));
          const missing = args.ids.filter((id) => !byId.has(id));
          if (missing.length) {
            throw new FluentSuiteError(
              "not_found",
              `No entry ${missing.slice(0, 10).join(", ")} on form #${formId}.`,
            );
          }
          add([...new Set(args.ids)].map((id) => byId.get(id) as EntryRaw));
        } else if (args.trashed_older_than_days) {
          const cutoff = daysAgo(args.trashed_older_than_days);
          const trashed = await api.collect({ formId, type: "trashed" }, 5000, ctx.signal);
          add(trashed.filter((e) => (e.created_at ?? "") < cutoff));
        } else if (args.email) {
          const hits = await api.collect(
            { formId, search: args.email, includeTrashed: true },
            5000,
            ctx.signal,
          );
          add(hits.filter((e) => emailMatches(e, form, args.email as string)));
        }
      }

      const rows = selected.map((e) => toEntryRow(e, forms.get(e.form_id)));
      const withUploads = selected.filter((e) =>
        hasUploads(e, forms.get(e.form_id) as FormDetail),
      ).length;
      const ids = selected.map((e) => e.id).sort((a, b) => a - b);
      const what = args.ids
        ? `entries ${ids.slice(0, 10).join(", ")}${ids.length > 10 ? ", …" : ""}`
        : args.email
          ? `entries from ${args.email}`
          : `trashed entries older than ${args.trashed_older_than_days} days`;
      if (!selected.length) {
        return {
          text: `No ${what}. Nothing to delete.`,
          structured: {
            tool: "forms_delete_entries",
            status: "preview" as const,
            count: 0,
            with_uploads: 0,
            entries: [],
          },
        };
      }
      const outcome = await guardedWrite({
        guard: ctx.guard,
        tool: "forms_delete_entries",
        // Bound to the previewed count and the exact entries: if either changes, the token no longer matches.
        args: { ...args, expected_count: selected.length, selected_ids: ids },
        plan: async () => ({
          summary: [
            `Permanently delete ${plural(selected.length, "entry", "entries")} (${what}). This cannot be undone.`,
            ...rows.slice(0, 10).map(entryLine),
            rows.length > 10 ? `- … and ${rows.length - 10} more` : "",
            withUploads
              ? `${plural(withUploads, "entry has", "entries have")} uploaded files; Fluent Forms deletes those files too.`
              : "",
            "Fires Fluent Forms' fluentform/before_deleting_entries and fluentform/after_deleting_submissions hooks (nothing in free Fluent Forms listens to them). Sends nothing.",
          ]
            .filter(Boolean)
            .join("\n"),
          affected: selected.length,
          destructive: true,
        }),
        execute: async () => {
          const byForm = new Map<number, number[]>();
          for (const e of selected) byForm.set(e.form_id, [...(byForm.get(e.form_id) ?? []), e.id]);
          for (const [formId, list] of byForm) {
            await api.bulk(formId, list, "other.delete_permanently", ctx.signal);
          }
          return selected.length;
        },
      });
      const base = {
        tool: "forms_delete_entries",
        count: selected.length,
        with_uploads: withUploads,
        entries: rows,
      };
      if (outcome.status === "preview") {
        return {
          text: previewText("forms_delete_entries", outcome),
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
        text: `Done. Deleted ${plural(outcome.result, "entry", "entries")} (${what}).`,
        structured: { ...base, status: "applied" as const, deleted: outcome.result },
      };
    },
  });
}
