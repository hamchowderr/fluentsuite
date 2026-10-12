import { defineTool, plural } from "@fluentsuite/core";
import * as z from "zod/v4";
import type { FluentCrmApi, Subscriber } from "../api.js";
import { STATUSES } from "../segment.js";
import { ContactRow, rowLine, toRow } from "./find-contacts.js";

const Input = z.object({
  days: z.number().int().min(1).max(90).default(7).describe("Look back this many days."),
  statuses: z
    .array(z.enum(STATUSES))
    .max(STATUSES.length)
    .optional()
    .describe("Omit for all statuses."),
  limit: z.number().int().min(1).max(100).default(25).describe("Most recent contacts to list."),
});

const Output = z.object({
  since: z.string(),
  total: z.number(),
  by_day: z.record(z.string(), z.number()),
  by_source: z.record(z.string(), z.number()),
  contacts: z.array(ContactRow),
  truncated: z.boolean(),
});

const MAX_SCAN = 1000;

export function recentSignupsTool(api: FluentCrmApi, now: () => Date = () => new Date()) {
  return defineTool({
    name: "crm_recent_signups",
    title: "Recent signups",
    description:
      "New FluentCRM contacts in the last N days: total, per-day counts, sources, and the most recent contacts with their tags and lists.",
    kind: "read",
    input: Input,
    output: Output,
    handler: async (args, ctx) => {
      const since = new Date(now().getTime() - args.days * 86_400_000).toISOString().slice(0, 10);
      const filter = { statuses: args.statuses?.length ? [...args.statuses] : undefined };
      const found: Subscriber[] = [];
      let truncated = false;
      // Newest first; stop at the first contact older than the window.
      for (let page = 1; ; page++) {
        const res = await api.listContacts(
          filter,
          { page, perPage: 100, sortBy: "created_at", sortType: "DESC" },
          ctx.signal,
        );
        const fresh = res.data.filter((c) => (c.created_at ?? "") >= since);
        found.push(...fresh);
        if (fresh.length < res.data.length || page >= (res.last_page ?? page)) break;
        if (found.length >= MAX_SCAN) {
          truncated = true;
          break;
        }
      }
      const byDay: Record<string, number> = {};
      const bySource: Record<string, number> = {};
      for (const c of found) {
        const day = (c.created_at ?? "").slice(0, 10);
        byDay[day] = (byDay[day] ?? 0) + 1;
        const source = c.source || "unknown";
        bySource[source] = (bySource[source] ?? 0) + 1;
      }
      const rows = found.slice(0, args.limit).map(toRow);
      const text = [
        `${plural(found.length, "new contact")} since ${since}${truncated ? ` (stopped counting at ${MAX_SCAN})` : ""}.`,
        Object.keys(byDay).length
          ? `Per day: ${Object.entries(byDay)
              .map(([d, n]) => `${d} ${n}`)
              .join(", ")}.`
          : "",
        Object.keys(bySource).length
          ? `Sources: ${Object.entries(bySource)
              .map(([s, n]) => `${s} ${n}`)
              .join(", ")}.`
          : "",
        rows.length ? `Most recent ${rows.length}:` : "",
        ...rows.map(rowLine),
      ]
        .filter(Boolean)
        .join("\n");
      return {
        text,
        structured: {
          since,
          total: found.length,
          by_day: byDay,
          by_source: bySource,
          contacts: rows,
          truncated,
        },
      };
    },
  });
}
