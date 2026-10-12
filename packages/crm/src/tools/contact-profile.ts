import { defineTool, fields, joinLimited, shortDate, truncate } from "@fluentsuite/core";
import * as z from "zod/v4";
import type { FluentCrmApi, Subscriber } from "../api.js";
import { CONTACT_CARD_URI } from "../views.js";

const Input = z
  .object({
    email: z.email().max(254).optional().describe("Exact email address of the contact."),
    id: z.number().int().positive().optional().describe("FluentCRM contact id, if known."),
    recent_emails: z
      .number()
      .int()
      .min(0)
      .max(20)
      .default(5)
      .describe("How many recent emails to include."),
    recent_notes: z
      .number()
      .int()
      .min(0)
      .max(20)
      .default(3)
      .describe("How many recent notes to include."),
  })
  .refine((v) => v.email !== undefined || v.id !== undefined, {
    message: "Provide email or id.",
  });

export const ContactProfile = z.object({
  contact: z.object({
    id: z.number(),
    name: z.string(),
    email: z.string(),
    status: z.string(),
    type: z.string().nullable(),
    source: z.string().nullable(),
    phone: z.string().nullable(),
    location: z.string().nullable(),
    lifetime_value: z.number().nullable(),
    created_at: z.string().nullable(),
    last_activity: z.string().nullable(),
    unsubscribe_reason: z.string().nullable(),
    tags: z.array(z.string()),
    lists: z.array(z.string()),
    custom_fields: z.record(z.string(), z.unknown()),
    url: z.string(),
  }),
  stats: z.object({ emails: z.number(), opens: z.number(), clicks: z.number() }).nullable(),
  recent_emails: z.array(
    z.object({
      subject: z.string(),
      status: z.string().nullable(),
      date: z.string().nullable(),
      opened: z.boolean(),
      clicks: z.number(),
    }),
  ),
  notes: z.array(
    z.object({ title: z.string(), type: z.string().nullable(), date: z.string().nullable() }),
  ),
});
export type ContactProfile = z.infer<typeof ContactProfile>;

function displayName(c: Subscriber): string {
  const name = c.full_name?.trim() || [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
  return name || c.email;
}

function customFields(c: Subscriber): Record<string, unknown> {
  return c.custom_values && !Array.isArray(c.custom_values) ? c.custom_values : {};
}

function render(p: ContactProfile): string {
  const c = p.contact;
  const lines = [
    `${c.name} <${c.email}> (contact #${c.id})`,
    fields([
      [
        "Status",
        c.status + (c.unsubscribe_reason ? ` (reason: ${truncate(c.unsubscribe_reason, 80)})` : ""),
      ],
      ["Type", c.type],
      ["Source", c.source],
      ["Location", c.location],
      ["Lifetime value", c.lifetime_value ? c.lifetime_value : null],
      ["Created", shortDate(c.created_at)],
      ["Last activity", shortDate(c.last_activity)],
      ["Tags", joinLimited(c.tags)],
      ["Lists", joinLimited(c.lists)],
    ]),
  ];
  const custom = Object.entries(c.custom_fields).filter(
    ([, v]) => v !== "" && v !== null && v !== undefined,
  );
  if (custom.length) {
    lines.push(
      `Custom fields: ${custom.map(([k, v]) => `${k}=${truncate(String(v), 40)}`).join(", ")}`,
    );
  }
  if (p.stats) {
    lines.push(
      `Email stats: ${p.stats.emails} sent, ${p.stats.opens} opened, ${p.stats.clicks} clicked`,
    );
  }
  if (p.recent_emails.length) {
    lines.push("Recent emails:");
    for (const e of p.recent_emails) {
      lines.push(
        `- ${shortDate(e.date)} "${truncate(e.subject, 70)}" ${e.opened ? "opened" : "not opened"}${e.clicks ? `, ${e.clicks} clicks` : ""}`,
      );
    }
  }
  if (p.notes.length) {
    lines.push("Recent notes:");
    for (const n of p.notes)
      lines.push(`- ${shortDate(n.date)} [${n.type ?? "note"}] ${truncate(n.title, 80)}`);
  }
  lines.push(`Open in FluentCRM: ${c.url}`);
  return lines.join("\n");
}

export function contactProfileTool(api: FluentCrmApi) {
  return defineTool({
    name: "crm_contact_profile",
    title: "Contact profile",
    description:
      "Everything about one FluentCRM contact in a single answer: status, tags, lists, custom fields, email engagement, recent emails and notes. Look up by exact email (preferred) or contact id.",
    kind: "read",
    input: Input,
    output: ContactProfile,
    ui: { resourceUri: CONTACT_CARD_URI },
    handler: async (args, ctx) => {
      const c = await api.getContact(
        args.id !== undefined ? { id: args.id } : { email: args.email ?? "" },
        ctx.signal,
      );
      const [emails, notes] = await Promise.all([
        args.recent_emails ? api.recentEmails(c.id, args.recent_emails, ctx.signal) : [],
        args.recent_notes ? api.recentNotes(c.id, args.recent_notes, ctx.signal) : [],
      ]);
      const profile: ContactProfile = {
        contact: {
          id: c.id,
          name: displayName(c),
          email: c.email,
          status: c.status,
          type: c.contact_type ?? null,
          source: c.source ?? null,
          phone: c.phone ?? null,
          location: [c.city, c.country].filter(Boolean).join(", ") || null,
          lifetime_value: c.life_time_value ?? null,
          created_at: c.created_at ?? null,
          last_activity: c.last_activity ?? null,
          unsubscribe_reason: c.unsubscribe_reason ?? null,
          tags: c.tags.map((t) => t.title),
          lists: c.lists.map((l) => l.title),
          custom_fields: customFields(c),
          url: api.contactUrl(c.id),
        },
        stats: c.stats
          ? { emails: c.stats.emails, opens: c.stats.opens, clicks: c.stats.clicks }
          : null,
        recent_emails: emails.map((e) => ({
          subject: e.email_subject ?? "(no subject)",
          status: e.status ?? null,
          date: e.scheduled_at ?? e.created_at ?? null,
          opened: Boolean(e.is_open),
          clicks: e.click_counter ?? 0,
        })),
        notes: notes.map((n) => ({
          title: n.title ?? "(untitled)",
          type: n.type ?? null,
          date: n.created_at ?? null,
        })),
      };
      return { text: render(profile), structured: profile };
    },
  });
}
