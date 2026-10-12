import { defineTool, plural } from "@fluentsuite/core";
import * as z from "zod/v4";
import type { FluentCrmApi } from "../api.js";
import {
  collectSegment,
  describeSegment,
  loadTaxonomies,
  resolveSegment,
  SEGMENT_CAP,
  SegmentSchema,
} from "../segment.js";
import { ACTION_PREVIEW_URI } from "../views.js";
import { ContactRow, rowLine, toRow } from "./find-contacts.js";

const Input = SegmentSchema.extend({
  statuses: SegmentSchema.shape.statuses.default(["subscribed"]),
  sample_size: z.number().int().min(0).max(25).default(5),
});

export const SegmentPreview = z.object({
  segment: z.string(),
  count: z.number(),
  excluded: z.number(),
  by_status: z.record(z.string(), z.number()),
  by_type: z.record(z.string(), z.number()),
  sample: z.array(ContactRow),
});
export type SegmentPreview = z.infer<typeof SegmentPreview>;

function tally(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

export function segmentPreviewTool(api: FluentCrmApi) {
  return defineTool({
    name: "crm_segment_preview",
    title: "Segment preview",
    description: `Size and sample of an audience (tags, lists, statuses, exclusions) before a bulk change or a campaign. Statuses default to subscribed. Segments up to ${SEGMENT_CAP} contacts.`,
    kind: "read",
    ui: { resourceUri: ACTION_PREVIEW_URI },
    input: Input,
    output: SegmentPreview,
    handler: async (args, ctx) => {
      const { sample_size, ...segment } = args;
      const resolved = resolveSegment(segment, await loadTaxonomies(api, ctx.signal));
      const { contacts, matchedBeforeExclusions } = await collectSegment(api, resolved, ctx.signal);
      const preview: SegmentPreview = {
        segment: describeSegment(segment),
        count: contacts.length,
        excluded: matchedBeforeExclusions - contacts.length,
        by_status: tally(contacts.map((c) => c.status)),
        by_type: tally(contacts.map((c) => c.contact_type || "unknown")),
        sample: contacts.slice(0, sample_size).map(toRow),
      };
      const text = [
        `${preview.segment}: ${plural(preview.count, "contact")}.`,
        preview.excluded ? `${preview.excluded} more matched but were excluded.` : "",
        `By status: ${
          Object.entries(preview.by_status)
            .map(([k, v]) => `${k} ${v}`)
            .join(", ") || "none"
        }.`,
        `By type: ${
          Object.entries(preview.by_type)
            .map(([k, v]) => `${k} ${v}`)
            .join(", ") || "none"
        }.`,
        preview.sample.length ? "Sample:" : "",
        ...preview.sample.map(rowLine),
      ]
        .filter(Boolean)
        .join("\n");
      return { text, structured: preview };
    },
  });
}
