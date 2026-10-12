import {
  decodeCursor,
  defineTool,
  joinLimited,
  type PageInfo,
  pageInfo,
  pagingLine,
  shortDate,
} from "@fluentsuite/core";
import * as z from "zod/v4";
import type { CONTACT_SORTS, FluentCrmApi, Subscriber } from "../api.js";
import {
  collectSegment,
  contactName,
  describeSegment,
  hasExclusions,
  loadTaxonomies,
  resolveSegment,
  SegmentSchema,
} from "../segment.js";

export const ContactRow = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string(),
  status: z.string(),
  type: z.string().nullable(),
  tags: z.array(z.string()),
  lists: z.array(z.string()),
  created_at: z.string().nullable(),
  last_activity: z.string().nullable(),
});
export type ContactRow = z.infer<typeof ContactRow>;

export function toRow(c: Subscriber): ContactRow {
  return {
    id: c.id,
    name: contactName(c),
    email: c.email,
    status: c.status,
    type: c.contact_type ?? null,
    tags: c.tags.map((t) => t.title),
    lists: c.lists.map((l) => l.title),
    created_at: c.created_at ?? null,
    last_activity: c.last_activity ?? null,
  };
}

export function rowLine(r: ContactRow): string {
  return `- #${r.id} ${r.name} <${r.email}> · ${r.status}${r.type ? ` · ${r.type}` : ""} · tags: ${joinLimited(r.tags, 4)} · joined ${shortDate(r.created_at)}`;
}

const Input = SegmentSchema.extend({
  sort: z
    .enum(["newest", "oldest", "recently_active", "email"])
    .default("newest")
    .describe("Order of results."),
  per_page: z.number().int().min(1).max(100).default(20),
  cursor: z.string().max(500).optional().describe("From a previous call, to get the next page."),
});

const Output = z.object({
  segment: z.string(),
  total: z.number(),
  page: z.number(),
  per_page: z.number(),
  next_cursor: z.string().optional(),
  contacts: z.array(ContactRow),
});

const SORT_MAP = {
  newest: { sortBy: "created_at", sortType: "DESC" },
  oldest: { sortBy: "created_at", sortType: "ASC" },
  recently_active: { sortBy: "last_activity", sortType: "DESC" },
  email: { sortBy: "email", sortType: "ASC" },
} as const satisfies Record<
  string,
  { sortBy: (typeof CONTACT_SORTS)[number]; sortType: "ASC" | "DESC" }
>;

export function findContactsTool(api: FluentCrmApi) {
  return defineTool({
    name: "crm_find_contacts",
    title: "Find contacts",
    description:
      "Find or segment FluentCRM contacts by text, tags, lists and status, with exclusions. Returns the total count plus a page of short rows; use it for 'how many…' questions too. Tags and lists are given by name.",
    kind: "read",
    input: Input,
    output: Output,
    handler: async (args, ctx) => {
      const { cursor, per_page, sort, ...segment } = args;
      const query = { ...segment, sort };
      const page = decodeCursor("crm_find_contacts", query, cursor, per_page);
      const resolved = resolveSegment(segment, await loadTaxonomies(api, ctx.signal));

      let contacts: Subscriber[];
      let info: PageInfo;
      if (hasExclusions(resolved)) {
        // Exclusions are applied here, so walk the segment and page locally.
        const all = (await collectSegment(api, resolved, ctx.signal)).contacts;
        const { sortBy, sortType } = SORT_MAP[sort];
        all.sort((a, b) => {
          const av = String(a[sortBy] ?? "");
          const bv = String(b[sortBy] ?? "");
          return sortType === "ASC" ? av.localeCompare(bv) : bv.localeCompare(av);
        });
        contacts = all.slice((page.page - 1) * page.perPage, page.page * page.perPage);
        info = pageInfo("crm_find_contacts", query, {
          total: all.length,
          current_page: page.page,
          per_page: page.perPage,
        });
      } else {
        const res = await api.listContacts(
          resolved.filter,
          { ...page, ...SORT_MAP[sort] },
          ctx.signal,
        );
        contacts = res.data;
        info = pageInfo("crm_find_contacts", query, res);
      }

      const rows = contacts.map(toRow);
      const label = describeSegment(segment);
      const text = [
        `${label}: ${info.total} found.`,
        ...rows.map(rowLine),
        pagingLine(info, "contacts"),
      ].join("\n");
      return {
        text,
        structured: {
          segment: label,
          total: info.total,
          page: info.page,
          per_page: info.perPage,
          ...(info.nextCursor ? { next_cursor: info.nextCursor } : {}),
          contacts: rows,
        },
      };
    },
  });
}
