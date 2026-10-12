import { defineTool } from "@fluentsuite/core";
import * as z from "zod/v4";
import type { FluentCrmApi } from "../api.js";

const Output = z.object({
  tags: z.array(z.object({ name: z.string(), slug: z.string(), subscribed: z.number() })),
  lists: z.array(
    z.object({ name: z.string(), slug: z.string(), subscribed: z.number(), total: z.number() }),
  ),
});

export function tagsAndListsTool(api: FluentCrmApi) {
  return defineTool({
    name: "crm_tags_and_lists",
    title: "Tags and lists",
    description:
      "All FluentCRM tags and lists with contact counts. Call this before tagging or segmenting so you use names that exist.",
    kind: "read",
    input: z.object({}),
    output: Output,
    handler: async (_args, ctx) => {
      const [tags, lists] = await Promise.all([api.tags(ctx.signal), api.lists(ctx.signal)]);
      const out = {
        tags: tags.map((t) => ({
          name: t.title,
          slug: t.slug,
          subscribed: t.subscribersCount ?? 0,
        })),
        lists: lists.map((l) => ({
          name: l.title,
          slug: l.slug,
          subscribed: l.subscribersCount ?? 0,
          total: l.totalCount ?? l.subscribersCount ?? 0,
        })),
      };
      const text = [
        `Tags (${out.tags.length}), subscribed contacts in brackets:`,
        out.tags.length
          ? out.tags.map((t) => `- ${t.name} (${t.subscribed})`).join("\n")
          : "- none",
        `Lists (${out.lists.length}), subscribed / all contacts:`,
        out.lists.length
          ? out.lists.map((l) => `- ${l.name} (${l.subscribed} / ${l.total})`).join("\n")
          : "- none",
      ].join("\n");
      return { text, structured: out };
    },
  });
}
