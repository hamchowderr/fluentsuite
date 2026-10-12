import { FluentSuiteError } from "@fluentsuite/core";
import * as z from "zod/v4";
import type { FluentCrmApi, Subscriber } from "./api.js";
import {
  collectSegment,
  resolveSegment,
  type Segment,
  SegmentSchema,
  type Taxonomies,
} from "./segment.js";

/** Who a bulk write applies to: an explicit list of emails, or a segment. Exactly one. */
export const targetFields = {
  emails: z
    .array(z.email().max(254))
    .min(1)
    .max(500)
    .optional()
    .describe("Contacts by exact email (up to 500). Use this or segment."),
  segment: SegmentSchema.optional().describe("Contacts matching a segment. Use this or emails."),
};

export function exactlyOneTarget(v: {
  emails?: string[] | undefined;
  segment?: Segment | undefined;
}): boolean {
  return (v.emails !== undefined) !== (v.segment !== undefined);
}
export const TARGET_MESSAGE = "Provide either emails or segment, not both.";

export interface Targets {
  contacts: Subscriber[];
  /** Emails with no matching contact. */
  unknown: string[];
}

/** Look up the target contacts. Emails are looked up exactly; unknown ones are reported, not created. */
export async function resolveTargets(
  api: FluentCrmApi,
  args: { emails?: string[] | undefined; segment?: Segment | undefined },
  tax: Taxonomies,
  signal?: AbortSignal,
): Promise<Targets> {
  if (args.segment) {
    const { contacts } = await collectSegment(api, resolveSegment(args.segment, tax), signal);
    return { contacts, unknown: [] };
  }
  const emails = [...new Set((args.emails ?? []).map((e) => e.toLowerCase()))];
  const contacts: Subscriber[] = [];
  const unknown: string[] = [];
  // Five lookups at a time keeps the site responsive.
  for (let i = 0; i < emails.length; i += 5) {
    const batch = emails.slice(i, i + 5);
    const found = await Promise.all(batch.map((e) => api.findByEmail(e, signal)));
    found.forEach((c, j) => {
      if (c) contacts.push(c);
      else unknown.push(batch[j] ?? "");
    });
  }
  return { contacts, unknown };
}

/** Find taxonomy rows by name/slug, splitting into found and missing (for create_missing). */
export function matchNames<T extends { id: number; title: string; slug: string }>(
  names: string[] | undefined,
  rows: T[],
): { found: T[]; missing: string[] } {
  const found: T[] = [];
  const missing: string[] = [];
  for (const name of names ?? []) {
    const key = name.trim().toLowerCase();
    const row = rows.find((r) => r.title.toLowerCase() === key || r.slug.toLowerCase() === key);
    if (row) {
      if (!found.includes(row)) found.push(row);
    } else if (!missing.some((m) => m.toLowerCase() === key)) {
      missing.push(name.trim());
    }
  }
  return { found, missing };
}

export function requireNoMissing(
  kind: "tag" | "list",
  missing: string[],
  rows: Array<{ title: string }>,
): void {
  if (!missing.length) return;
  throw new FluentSuiteError(
    "invalid_input",
    `Unknown ${kind}${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`,
    {
      hint: `Existing ${kind}s: ${
        rows
          .map((r) => r.title)
          .slice(0, 30)
          .join(", ") || "none"
      }. Pass create_missing=true to create new ones.`,
    },
  );
}

/** Statuses that must never be put back on marketing lists or re-subscribed by a tool. */
export const NO_REMARKETING = new Set(["unsubscribed", "bounced", "complained", "spammed"]);
