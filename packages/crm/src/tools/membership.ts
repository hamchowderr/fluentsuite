import {
  defineTool,
  FluentSuiteError,
  guardedWrite,
  plural,
  previewText,
  writeControls,
} from "@fluentsuite/core";
import * as z from "zod/v4";
import type { FluentCrmApi, ListRow, Subscriber, TagRow } from "../api.js";
import { contactName, loadTaxonomies } from "../segment.js";
import {
  exactlyOneTarget,
  matchNames,
  NO_REMARKETING,
  requireNoMissing,
  resolveTargets,
  TARGET_MESSAGE,
  targetFields,
} from "../targets.js";
import { ACTION_PREVIEW_URI } from "../views.js";

const names = z.array(z.string().trim().min(1).max(100)).max(20);

const Output = z.object({
  tool: z.string(),
  status: z.enum(["preview", "applied"]),
  affected: z.number(),
  changes: z.array(
    z.object({
      id: z.number(),
      email: z.string(),
      add: z.array(z.string()),
      remove: z.array(z.string()),
    }),
  ),
  skipped: z.array(z.object({ email: z.string(), reason: z.string() })),
  unknown_emails: z.array(z.string()),
  created: z.array(z.string()),
  confirmation_token: z.string().optional(),
  expires_at: z.string().optional(),
});

interface Config {
  kind: "tags" | "lists";
  name: string;
  title: string;
  description: string;
}

type Row = TagRow | ListRow;

function membershipTool(api: FluentCrmApi, cfg: Config) {
  const singular = cfg.kind === "tags" ? "tag" : "list";
  const Input = z
    .object({
      ...targetFields,
      add: names
        .optional()
        .describe(`${cfg.kind === "tags" ? "Tags" : "Lists"} to add (names or slugs).`),
      remove: names
        .optional()
        .describe(`${cfg.kind === "tags" ? "Tags" : "Lists"} to remove (names or slugs).`),
      create_missing: z
        .boolean()
        .default(false)
        .describe(`Create ${cfg.kind} in 'add' that do not exist yet.`),
      ...writeControls,
    })
    .refine(exactlyOneTarget, { message: TARGET_MESSAGE })
    .refine((v) => (v.add?.length ?? 0) + (v.remove?.length ?? 0) > 0, {
      message: "Provide add and/or remove.",
    });

  return defineTool({
    name: cfg.name,
    title: cfg.title,
    description: cfg.description,
    kind: "write",
    ui: { resourceUri: ACTION_PREVIEW_URI },
    idempotent: true,
    input: Input,
    output: Output,
    handler: async (args, ctx) => {
      const tax = await loadTaxonomies(api, ctx.signal);
      const rows: Row[] = cfg.kind === "tags" ? tax.tags : tax.lists;
      const add = matchNames(args.add, rows);
      const remove = matchNames(args.remove, rows);
      if (!args.create_missing) requireNoMissing(singular, add.missing, rows);
      requireNoMissing(singular, remove.missing, rows);
      const overlap = add.found.filter((r) => remove.found.includes(r));
      if (overlap.length) {
        throw new FluentSuiteError(
          "invalid_input",
          `Can't both add and remove: ${overlap.map((r) => r.title).join(", ")}.`,
        );
      }
      const { contacts, unknown } = await resolveTargets(api, args, tax, ctx.signal);

      const skipped: Array<{ email: string; reason: string }> = [];
      const changes: Array<{ contact: Subscriber; add: string[]; remove: string[] }> = [];
      for (const c of contacts) {
        const current = new Set((cfg.kind === "tags" ? c.tags : c.lists).map((r) => r.id));
        let toAdd = [
          ...add.found.filter((r) => !current.has(r.id)).map((r) => r.title),
          ...add.missing,
        ];
        if (cfg.kind === "lists" && toAdd.length && NO_REMARKETING.has(c.status)) {
          skipped.push({ email: c.email, reason: `status ${c.status}: never added to lists` });
          toAdd = [];
        }
        const toRemove = remove.found.filter((r) => current.has(r.id)).map((r) => r.title);
        if (toAdd.length || toRemove.length)
          changes.push({ contact: c, add: toAdd, remove: toRemove });
      }

      const summaryLines = [
        `${cfg.title}: ${plural(changes.length, "contact")} would change.`,
        add.found.length || add.missing.length
          ? `Add ${cfg.kind}: ${[...add.found.map((r) => r.title), ...add.missing.map((m) => `${m} (new)`)].join(", ")}.`
          : "",
        remove.found.length
          ? `Remove ${cfg.kind}: ${remove.found.map((r) => r.title).join(", ")}.`
          : "",
        ...changes
          .slice(0, 10)
          .map(
            (ch) =>
              `- ${contactName(ch.contact)} <${ch.contact.email}>${ch.add.length ? ` +${ch.add.join(", +")}` : ""}${ch.remove.length ? ` -${ch.remove.join(", -")}` : ""}`,
          ),
        changes.length > 10 ? `- … and ${changes.length - 10} more` : "",
        contacts.length - changes.length - skipped.length > 0
          ? `${contacts.length - changes.length - skipped.length} already up to date.`
          : "",
        skipped.length
          ? `Skipped ${skipped.length}: ${skipped
              .slice(0, 5)
              .map((s) => `${s.email} (${s.reason})`)
              .join("; ")}.`
          : "",
        unknown.length
          ? `No contact for: ${unknown.slice(0, 10).join(", ")}${unknown.length > 10 ? " …" : ""}.`
          : "",
      ].filter(Boolean);

      const outcome = await guardedWrite({
        guard: ctx.guard,
        tool: cfg.name,
        args,
        plan: async () => ({ summary: summaryLines.join("\n"), affected: changes.length }),
        execute: async () => {
          const created: string[] = [];
          const addRows: Row[] = [...add.found];
          for (const title of add.missing) {
            addRows.push(
              cfg.kind === "tags"
                ? await api.createTag(title, ctx.signal)
                : await api.createList(title, ctx.signal),
            );
            created.push(title);
          }
          // One call per distinct change set keeps FluentCRM's hooks firing only for real changes.
          const groups = new Map<string, { ids: number[]; attach: number[]; detach: number[] }>();
          for (const ch of changes) {
            const attach = addRows.filter((r) => ch.add.includes(r.title)).map((r) => r.id);
            const detach = remove.found.filter((r) => ch.remove.includes(r.title)).map((r) => r.id);
            const key = `${attach.join(",")}|${detach.join(",")}`;
            const g = groups.get(key) ?? { ids: [], attach, detach };
            g.ids.push(ch.contact.id);
            groups.set(key, g);
          }
          for (const g of groups.values()) {
            await api.syncSegments(
              cfg.kind,
              g.ids,
              { attach: g.attach, detach: g.detach },
              ctx.signal,
            );
          }
          return created;
        },
      });

      const base = {
        affected: changes.length,
        changes: changes.map((ch) => ({
          id: ch.contact.id,
          email: ch.contact.email,
          add: ch.add,
          remove: ch.remove,
        })),
        skipped,
        unknown_emails: unknown,
      };
      if (outcome.status === "preview") {
        return {
          text: previewText(cfg.name, outcome),
          structured: {
            tool: cfg.name,
            status: "preview" as const,
            ...base,
            created: [],
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
        text: `Done. ${plural(changes.length, "contact")} updated.${outcome.result.length ? ` Created ${cfg.kind}: ${outcome.result.join(", ")}.` : ""}`,
        structured: {
          tool: cfg.name,
          status: "applied" as const,
          ...base,
          created: outcome.result,
        },
      };
    },
  });
}

export function tagContactsTool(api: FluentCrmApi) {
  return membershipTool(api, {
    kind: "tags",
    name: "crm_tag_contacts",
    title: "Tag contacts",
    description:
      "Add and/or remove tags for contacts given by emails or by a segment. Previews first (dry_run defaults to true); changes over the bulk threshold need the user's confirmation token. Optionally creates missing tags.",
  });
}

export function listMembershipTool(api: FluentCrmApi) {
  return membershipTool(api, {
    kind: "lists",
    name: "crm_update_list_membership",
    title: "Update list membership",
    description:
      "Subscribe contacts to lists or remove them from lists, by emails or segment. Never adds contacts whose status is unsubscribed, bounced or complained. Previews first; bulk changes need the confirmation token.",
  });
}
