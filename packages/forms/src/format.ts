import { maskSecrets } from "@fluentsuite/core";
import * as z from "zod/v4";
import type { EntryRaw, FormDetail } from "./api.js";
import type { FieldDef } from "./fields.js";

export const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
  .describe("A date in the site's timezone, YYYY-MM-DD.");

/** The short row lists show: a name, an email and the date. Never other field values, files or IPs. */
export const EntryRow = z.object({
  id: z.number(),
  form_id: z.number(),
  form: z.string(),
  created_at: z.string().nullable(),
  status: z.string(),
  favorite: z.boolean(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  payment_status: z.string().nullable(),
});
export type EntryRow = z.infer<typeof EntryRow>;

export function parseResponse(raw: EntryRaw): Record<string, unknown> {
  if (!raw.response) return {};
  try {
    const parsed = JSON.parse(raw.response);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function pick(
  fields: FieldDef[],
  response: Record<string, unknown>,
  element: string,
  fallback: string,
) {
  const name = fields.find((f) => f.element === element)?.name ?? fallback;
  return response[name];
}

export function displayName(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const s = [o.first_name, o.middle_name, o.last_name]
      .filter((x) => typeof x === "string" && x)
      .join(" ");
    return s || null;
  }
  return null;
}

export function toEntryRow(raw: EntryRaw, form: FormDetail | undefined): EntryRow {
  const response = parseResponse(raw);
  const fields = form?.fields ?? [];
  const email = pick(fields, response, "input_email", "email");
  const name = displayName(pick(fields, response, "input_name", "names"));
  return {
    id: raw.id,
    form_id: raw.form_id,
    form: form?.title ?? `Form #${raw.form_id}`,
    created_at: raw.created_at ?? null,
    status: raw.status,
    favorite: raw.is_favourite === "1",
    name: name ? maskSecrets(name) : null,
    email: typeof email === "string" && email ? email : null,
    payment_status: raw.payment_status ?? null,
  };
}

export function entryLine(r: EntryRow): string {
  return `- #${r.id} ${r.created_at ?? "?"} · ${r.form} · ${r.status}${r.favorite ? " ★" : ""} · ${r.name ?? "(no name)"}${r.email ? ` <${r.email}>` : ""}${r.payment_status ? ` · payment ${r.payment_status}` : ""}`;
}

/** Fluent Forms stores payment amounts in cents. */
export function money(
  cents: number | null | undefined,
  currency: string | null | undefined,
): string | null {
  if (cents === null || cents === undefined) return null;
  return `${(cents / 100).toFixed(2)}${currency ? ` ${currency}` : ""}`;
}
