import {
  defineTool,
  FluentSuiteError,
  guardedWrite,
  plural,
  previewText,
  writeControls,
} from "@fluentsuite/core";
import * as z from "zod/v4";
import type { EntryRaw, FluentFormsApi } from "../api.js";
import { DATE, EntryRow, entryLine, toEntryRow } from "../format.js";

/** The most entries one call changes. */
export const UPDATE_CAP = 500;

const ACTIONS = {
  mark_read: { label: "Mark read", bulk: "read", applies: (e: EntryRaw) => e.status === "unread" },
  mark_unread: {
    label: "Mark unread",
    bulk: "unread",
    applies: (e: EntryRaw) => e.status === "read",
  },
  favorite: {
    label: "Add to favorites",
    bulk: "other.make_favorite",
    applies: (e: EntryRaw) => e.is_favourite !== "1",
  },
  unfavorite: {
    label: "Remove from favorites",
    bulk: "other.unmark_favorite",
    applies: (e: EntryRaw) => e.is_favourite === "1",
  },
  trash: {
    label: "Move to trash",
    bulk: "trashed",
    applies: (e: EntryRaw) => e.status !== "trashed",
  },
  // Fluent Forms has no "restore": a trashed entry is restored by giving it a normal status again.
  restore: {
    label: "Restore from trash (as read)",
    bulk: "read",
    applies: (e: EntryRaw) => e.status === "trashed",
  },
} as const;
type Action = keyof typeof ACTIONS;

const Input = z
  .object({
    form_id: z
      .number()
      .int()
      .positive()
      .describe("The form the entries belong to (one form per call)."),
    action: z.enum(Object.keys(ACTIONS) as [Action, ...Action[]]),
    ids: z
      .array(z.number().int().positive())
      .min(1)
      .max(UPDATE_CAP)
      .optional()
      .describe("Entry ids."),
    status: z
      .enum(["unread", "read", "favorites", "trashed"])
      .optional()
      .describe("Or: every entry of the form with this status…"),
    after: DATE.optional().describe("…on or after this date…"),
    before: DATE.optional().describe("…and on or before this date."),
    ...writeControls,
  })
  .refine(
    (a) => (a.ids ? !a.status && !a.after && !a.before : Boolean(a.status || a.after || a.before)),
    {
      message: "Give either ids, or a filter (status and/or a date range), not both.",
    },
  );

const Output = z.object({
  tool: z.string(),
  status: z.enum(["preview", "applied"]),
  action: z.string(),
  affected: z.number(),
  skipped: z.number().describe("Selected entries already in that state."),
  entries: z.array(EntryRow),
  confirmation_token: z.string().optional(),
  expires_at: z.string().optional(),
});

export function updateEntriesTool(api: FluentFormsApi) {
  return defineTool({
    name: "forms_update_entries",
    title: "Update form entries",
    description: `Mark Fluent Forms entries read or unread, add or remove them from favorites, move them to the trash or restore them, by ids or by a filter (one form per call, up to ${UPDATE_CAP}). Always previews first; more than 10 entries needs the user's confirmation token. Trash can be undone. Never deletes, never changes entry values, never sends anything.`,
    kind: "write",
    idempotent: true,
    input: Input,
    output: Output,
    handler: async (args, ctx) => {
      const form = await api.form(args.form_id, ctx.signal);
      const action = ACTIONS[args.action];
      let selected: EntryRaw[];
      if (args.ids) {
        const all = await api.collect(
          { formId: args.form_id, includeTrashed: true },
          5000,
          ctx.signal,
        );
        const byId = new Map(all.map((e) => [e.id, e]));
        const missing = args.ids.filter((id) => !byId.has(id));
        if (missing.length) {
          throw new FluentSuiteError(
            "not_found",
            `No entry ${missing.slice(0, 10).join(", ")} on form #${args.form_id}.`,
            { hint: "Find entries with forms_find_entries; ids must belong to this form." },
          );
        }
        selected = [...new Set(args.ids)].map((id) => byId.get(id) as EntryRaw);
      } else {
        selected = await api.collect(
          { formId: args.form_id, type: args.status, after: args.after, before: args.before },
          UPDATE_CAP,
          ctx.signal,
        );
      }
      const changing = selected.filter(action.applies);
      const rows = changing.map((e) => toEntryRow(e, form));
      const ids = changing.map((e) => e.id).sort((a, b) => a - b);
      const hookLine = action.bulk.startsWith("other.")
        ? "Fires no Fluent Forms hook (favorites are not a status change). Sends nothing."
        : "Fires Fluent Forms' fluentform/after_submission_status_update hook once per entry (nothing in free Fluent Forms listens to it; Pro or other plugins could). Sends nothing.";
      const outcome = await guardedWrite({
        guard: ctx.guard,
        tool: "forms_update_entries",
        // The token covers exactly these entries: if the selection changes, it no longer matches.
        args: { ...args, selected_ids: ids },
        plan: async () => ({
          summary: [
            `${action.label}: ${plural(changing.length, "entry", "entries")} on "${form.title}"${selected.length > changing.length ? ` (${selected.length - changing.length} already in that state)` : ""}.`,
            ...rows.slice(0, 10).map(entryLine),
            rows.length > 10 ? `- … and ${rows.length - 10} more` : "",
            changing.length ? hookLine : "",
          ]
            .filter(Boolean)
            .join("\n"),
          affected: changing.length,
        }),
        execute: async () => {
          if (ids.length) await api.bulk(args.form_id, ids, action.bulk, ctx.signal);
          return ids.length;
        },
      });
      const base = {
        tool: "forms_update_entries",
        action: args.action,
        affected: changing.length,
        skipped: selected.length - changing.length,
        entries: rows,
      };
      if (outcome.status === "preview") {
        return {
          text: changing.length
            ? previewText("forms_update_entries", outcome)
            : `Nothing to change: the selected entries are already in that state.`,
          structured: {
            ...base,
            status: "preview" as const,
            ...(outcome.confirmation && changing.length
              ? {
                  confirmation_token: outcome.confirmation.token,
                  expires_at: outcome.confirmation.expiresAt,
                }
              : {}),
          },
        };
      }
      return {
        text: `Done. ${action.label}: ${plural(outcome.result, "entry", "entries")} on "${form.title}".`,
        structured: { ...base, status: "applied" as const },
      };
    },
  });
}
