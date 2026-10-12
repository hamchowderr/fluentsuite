import { FluentSuiteError } from "@fluentsuite/core";
import * as z from "zod/v4";
import type { ContactFilter, FluentCrmApi, ListRow, Subscriber, TagRow } from "./api.js";

/** Contact statuses FluentCRM knows. */
export const STATUSES = [
  "subscribed",
  "pending",
  "unsubscribed",
  "transactional",
  "bounced",
  "complained",
  "spammed",
] as const;

const names = z.array(z.string().trim().min(1).max(100)).max(50);

/**
 * A segment: who matches. Tags and lists are given by name or slug (the model never needs ids).
 * Within tags_any (or lists_any) a contact needs ANY of them; tags_any and lists_any combine with AND.
 * Exclusions remove contacts having ANY excluded tag or list.
 */
export const SegmentSchema = z.object({
  tags_any: names.optional().describe("Contacts with ANY of these tags (names or slugs)."),
  lists_any: names.optional().describe("Contacts on ANY of these lists (names or slugs)."),
  statuses: z
    .array(z.enum(STATUSES))
    .max(STATUSES.length)
    .optional()
    .describe("Contact statuses to include. Omit for all statuses."),
  exclude_tags: names.optional().describe("Drop contacts with ANY of these tags."),
  exclude_lists: names.optional().describe("Drop contacts on ANY of these lists."),
  search: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe("Free text: name, email, city, country, phone."),
});
export type Segment = z.infer<typeof SegmentSchema>;

export interface Taxonomies {
  tags: TagRow[];
  lists: ListRow[];
}

export async function loadTaxonomies(api: FluentCrmApi, signal?: AbortSignal): Promise<Taxonomies> {
  const [tags, lists] = await Promise.all([api.tags(signal), api.lists(signal)]);
  return { tags, lists };
}

function resolve(
  kind: "tag" | "list",
  wanted: string[] | undefined,
  rows: Array<TagRow | ListRow>,
): number[] {
  if (!wanted?.length) return [];
  const ids: number[] = [];
  const unknown: string[] = [];
  for (const name of wanted) {
    const key = name.toLowerCase();
    const row = rows.find((r) => r.title.toLowerCase() === key || r.slug.toLowerCase() === key);
    if (row) ids.push(row.id);
    else unknown.push(name);
  }
  if (unknown.length) {
    const available =
      rows
        .map((r) => r.title)
        .slice(0, 30)
        .join(", ") || "none";
    throw new FluentSuiteError(
      "invalid_input",
      `Unknown ${kind}${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.`,
      {
        hint: `Existing ${kind}s: ${available}. Use crm_tags_and_lists for the full list.`,
      },
    );
  }
  return [...new Set(ids)];
}

export interface ResolvedSegment {
  filter: ContactFilter;
  excludeTagIds: Set<number>;
  excludeListIds: Set<number>;
}

export function resolveSegment(segment: Segment, tax: Taxonomies): ResolvedSegment {
  return {
    filter: {
      search: segment.search || undefined,
      tagIds: resolve("tag", segment.tags_any, tax.tags),
      listIds: resolve("list", segment.lists_any, tax.lists),
      statuses: segment.statuses?.length ? [...segment.statuses] : undefined,
    },
    excludeTagIds: new Set(resolve("tag", segment.exclude_tags, tax.tags)),
    excludeListIds: new Set(resolve("list", segment.exclude_lists, tax.lists)),
  };
}

export function hasExclusions(r: ResolvedSegment): boolean {
  return r.excludeTagIds.size > 0 || r.excludeListIds.size > 0;
}

export function isExcluded(contact: Subscriber, r: ResolvedSegment): boolean {
  return (
    contact.tags.some((t) => r.excludeTagIds.has(t.id)) ||
    contact.lists.some((l) => r.excludeListIds.has(l.id))
  );
}

/** Largest segment the server will walk in one call (counts, previews and bulk changes). */
export const SEGMENT_CAP = 5000;

/**
 * Every contact in a segment. FluentCRM filters the includes natively; exclusions are applied here,
 * so the walk is capped to keep calls bounded. Over the cap, the caller gets a clear error.
 */
export async function collectSegment(
  api: FluentCrmApi,
  resolved: ResolvedSegment,
  signal?: AbortSignal,
  cap = SEGMENT_CAP,
): Promise<{ contacts: Subscriber[]; matchedBeforeExclusions: number }> {
  const perPage = 100;
  const first = await api.listContacts(resolved.filter, { page: 1, perPage }, signal);
  if (first.total > cap) {
    throw new FluentSuiteError(
      "invalid_input",
      `That segment matches ${first.total} contacts, over the ${cap} limit.`,
      {
        hint: "Narrow it with statuses, more specific tags or lists, or search.",
      },
    );
  }
  const all = [...first.data];
  const pages = Math.ceil(first.total / perPage);
  for (let page = 2; page <= pages; page++) {
    all.push(...(await api.listContacts(resolved.filter, { page, perPage }, signal)).data);
  }
  return {
    contacts: all.filter((c) => !isExcluded(c, resolved)),
    matchedBeforeExclusions: first.total,
  };
}

/** Plain-language description of a segment, for previews. */
export function describeSegment(segment: Segment): string {
  const parts: string[] = [];
  if (segment.tags_any?.length) parts.push(`tagged ${segment.tags_any.join(" or ")}`);
  if (segment.lists_any?.length) parts.push(`on ${segment.lists_any.join(" or ")}`);
  if (segment.statuses?.length) parts.push(`status ${segment.statuses.join("/")}`);
  if (segment.search) parts.push(`matching "${segment.search}"`);
  if (segment.exclude_tags?.length) parts.push(`not tagged ${segment.exclude_tags.join(" or ")}`);
  if (segment.exclude_lists?.length) parts.push(`not on ${segment.exclude_lists.join(" or ")}`);
  return parts.length ? `Contacts ${parts.join(", ")}` : "All contacts";
}

export function contactName(c: Subscriber): string {
  const name = c.full_name?.trim() || [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
  return name || c.email;
}
