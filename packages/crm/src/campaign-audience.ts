import { FluentSuiteError } from "@fluentsuite/core";
import * as z from "zod/v4";
import type { RecipientSelection } from "./api.js";
import type { Taxonomies } from "./segment.js";
import { matchNames, requireNoMissing } from "./targets.js";

const names = z.array(z.string().trim().min(1).max(100)).max(20);

/**
 * A campaign audience. FluentCRM campaigns always go to SUBSCRIBED contacts only.
 * lists_any and tags_any combine with AND (contacts on one of the lists AND with one of the tags).
 */
export const AudienceSchema = z
  .object({
    lists_any: names.optional().describe("Send to contacts on ANY of these lists."),
    tags_any: names
      .optional()
      .describe("…who also have ANY of these tags (or alone: anyone with these tags)."),
    exclude_lists: names.optional(),
    exclude_tags: names.optional(),
  })
  .refine((a) => (a.lists_any?.length ?? 0) + (a.tags_any?.length ?? 0) > 0, {
    message: "The audience needs lists_any and/or tags_any.",
  });
export type Audience = z.infer<typeof AudienceSchema>;

export function toSelection(audience: Audience, tax: Taxonomies): RecipientSelection {
  const lists = matchNames(audience.lists_any, tax.lists);
  const tags = matchNames(audience.tags_any, tax.tags);
  const exLists = matchNames(audience.exclude_lists, tax.lists);
  const exTags = matchNames(audience.exclude_tags, tax.tags);
  requireNoMissing("list", [...lists.missing, ...exLists.missing], tax.lists);
  requireNoMissing("tag", [...tags.missing, ...exTags.missing], tax.tags);
  const listIds = lists.found.length ? lists.found.map((l) => String(l.id)) : ["all"];
  const tagIds = tags.found.length ? tags.found.map((t) => String(t.id)) : ["all"];
  const subscribers = listIds.flatMap((list) => tagIds.map((tag) => ({ list, tag })));
  if (subscribers.length > 100) {
    throw new FluentSuiteError(
      "invalid_input",
      "Too many list × tag combinations; use fewer lists or tags.",
    );
  }
  const excludedSubscribers = [
    ...exLists.found.map((l) => ({ list: String(l.id), tag: null })),
    ...exTags.found.map((t) => ({ list: null, tag: String(t.id) })),
  ];
  return {
    sending_filter: "list_tag",
    subscribers,
    excludedSubscribers: excludedSubscribers.length
      ? excludedSubscribers
      : [{ list: null, tag: null }],
  };
}

export function describeAudience(a: Audience): string {
  const parts = [
    a.lists_any?.length ? `on ${a.lists_any.join(" or ")}` : "",
    a.tags_any?.length ? `tagged ${a.tags_any.join(" or ")}` : "",
    a.exclude_lists?.length ? `not on ${a.exclude_lists.join(" or ")}` : "",
    a.exclude_tags?.length ? `not tagged ${a.exclude_tags.join(" or ")}` : "",
  ].filter(Boolean);
  return `Subscribed contacts ${parts.join(", ")}`;
}
