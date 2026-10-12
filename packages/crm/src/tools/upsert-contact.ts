import {
  defineTool,
  FluentSuiteError,
  guardedWrite,
  previewText,
  writeControls,
} from "@fluentsuite/core";
import * as z from "zod/v4";
import type { FluentCrmApi, Subscriber } from "../api.js";
import { loadTaxonomies } from "../segment.js";
import { matchNames, NO_REMARKETING, requireNoMissing } from "../targets.js";

const text = (max: number) => z.string().trim().max(max);

const Input = z.object({
  email: z
    .email()
    .max(254)
    .describe("Contact's email. Finds an existing contact or creates a new one."),
  first_name: text(100).optional(),
  last_name: text(100).optional(),
  phone: text(50).optional(),
  city: text(100).optional(),
  country: text(100).optional().describe("Country code or name, as used on the site."),
  contact_type: z.enum(["lead", "customer"]).optional(),
  source: text(100).optional(),
  custom_fields: z
    .record(z.string().max(100), z.union([z.string().max(1000), z.number(), z.boolean()]))
    .optional()
    .describe("Custom field values by slug. Other existing custom values are kept."),
  tags: z
    .array(text(100).min(1))
    .max(20)
    .optional()
    .describe("Tags to add (existing names or slugs)."),
  lists: z
    .array(text(100).min(1))
    .max(20)
    .optional()
    .describe("Lists to add (existing names or slugs)."),
  status: z
    .enum(["subscribed", "pending", "transactional"])
    .optional()
    .describe(
      "Only for NEW contacts (default subscribed). Existing contacts keep their status; use crm_set_contact_status.",
    ),
  ...writeControls,
});

const Output = z.object({
  status: z.enum(["preview", "applied"]),
  action: z.enum(["create", "update", "none"]),
  contact_id: z.number().nullable(),
  changes: z.array(z.object({ field: z.string(), from: z.string().nullable(), to: z.string() })),
});

const FIELDS = [
  "first_name",
  "last_name",
  "phone",
  "city",
  "country",
  "contact_type",
  "source",
] as const;

function currentCustom(c: Subscriber | undefined): Record<string, unknown> {
  return c?.custom_values && !Array.isArray(c.custom_values) ? c.custom_values : {};
}

export function upsertContactTool(api: FluentCrmApi) {
  return defineTool({
    name: "crm_upsert_contact",
    title: "Create or update contact",
    description:
      "Create a FluentCRM contact, or update the one with this email: name, phone, location, type, source, custom fields, and add tags/lists. Shows a field-by-field preview first. Never sends a double opt-in email; never changes an existing contact's status.",
    kind: "write",
    idempotent: true,
    input: Input,
    output: Output,
    handler: async (args, ctx) => {
      const [existing, tax] = await Promise.all([
        api.findByEmail(args.email, ctx.signal),
        loadTaxonomies(api, ctx.signal),
      ]);
      const tags = matchNames(args.tags, tax.tags);
      const lists = matchNames(args.lists, tax.lists);
      requireNoMissing("tag", tags.missing, tax.tags);
      requireNoMissing("list", lists.missing, tax.lists);
      if (existing && args.status) {
        throw new FluentSuiteError("invalid_input", "status only applies to new contacts.", {
          hint: "Use crm_set_contact_status to change an existing contact's status.",
        });
      }
      if (existing && lists.found.length && NO_REMARKETING.has(existing.status)) {
        throw new FluentSuiteError(
          "invalid_input",
          `This contact is ${existing.status}; it can't be added to lists.`,
        );
      }

      const changes: Array<{ field: string; from: string | null; to: string }> = [];
      const fields: Record<string, unknown> = {};
      for (const f of FIELDS) {
        const next = args[f];
        if (next === undefined) continue;
        const prev = existing ? ((existing[f] as string | null | undefined) ?? null) : null;
        if (prev !== next) {
          changes.push({ field: f, from: prev, to: next });
          fields[f] = next;
        }
      }
      const custom = currentCustom(existing);
      const customChanges: Record<string, unknown> = {};
      for (const [slug, value] of Object.entries(args.custom_fields ?? {})) {
        if (String(custom[slug] ?? "") !== String(value)) {
          changes.push({
            field: `custom:${slug}`,
            from: custom[slug] === undefined ? null : String(custom[slug]),
            to: String(value),
          });
          customChanges[slug] = value;
        }
      }
      const newTags = tags.found.filter((t) => !existing?.tags.some((x) => x.id === t.id));
      const newLists = lists.found.filter((l) => !existing?.lists.some((x) => x.id === l.id));
      if (newTags.length)
        changes.push({
          field: "tags",
          from: null,
          to: `+${newTags.map((t) => t.title).join(", +")}`,
        });
      if (newLists.length)
        changes.push({
          field: "lists",
          from: null,
          to: `+${newLists.map((l) => l.title).join(", +")}`,
        });
      if (!existing)
        changes.unshift({ field: "status", from: null, to: args.status ?? "subscribed" });

      const action: "create" | "update" | "none" = existing
        ? changes.length
          ? "update"
          : "none"
        : "create";
      const summary =
        action === "none"
          ? `${args.email} already matches; nothing to change.`
          : [
              `${action === "create" ? "Create" : "Update"} contact ${args.email}${existing ? ` (#${existing.id})` : ""}:`,
              ...changes.map((c) => `- ${c.field}: ${c.from ?? "(empty)"} → ${c.to}`),
            ].join("\n");

      const outcome = await guardedWrite({
        guard: ctx.guard,
        tool: "crm_upsert_contact",
        args,
        plan: async () => ({ summary, affected: action === "none" ? 0 : 1 }),
        execute: async () => {
          if (action === "none") return existing?.id ?? null;
          if (!existing) {
            const created = await api.createContact(
              {
                email: args.email,
                status: args.status ?? "subscribed",
                ...fields,
                ...(Object.keys(customChanges).length ? { custom_values: customChanges } : {}),
                tags: newTags.map((t) => t.id),
                lists: newLists.map((l) => l.id),
              },
              ctx.signal,
            );
            return created.id;
          }
          await api.updateContact(
            existing.id,
            {
              ...fields,
              // FluentCRM replaces custom values wholesale, so send the merged set.
              ...(Object.keys(customChanges).length
                ? { custom_values: { ...custom, ...customChanges } }
                : {}),
              ...(newTags.length ? { attach_tags: newTags.map((t) => t.id) } : {}),
              ...(newLists.length ? { attach_lists: newLists.map((l) => l.id) } : {}),
            },
            ctx.signal,
          );
          return existing.id;
        },
      });
      if (outcome.status === "preview") {
        return {
          text: action === "none" ? summary : previewText("crm_upsert_contact", outcome),
          structured: {
            status: "preview" as const,
            action,
            contact_id: existing?.id ?? null,
            changes,
          },
        };
      }
      return {
        text:
          action === "none"
            ? summary
            : `Done. Contact ${args.email} ${action === "create" ? "created" : "updated"} (#${outcome.result}).`,
        structured: { status: "applied" as const, action, contact_id: outcome.result, changes },
      };
    },
  });
}
