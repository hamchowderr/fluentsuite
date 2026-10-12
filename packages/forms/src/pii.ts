import { maskSecrets, truncate } from "@fluentsuite/core";
import { type FieldDef, isPaymentElement } from "./fields.js";

/**
 * The owner-approved PII rules for showing Fluent Forms entries:
 *
 * - upload fields show file names only, never their (publicly fetchable) URLs;
 * - password fields are never shown; signatures show as "signed";
 * - fields whose name or label looks sensitive show [redacted] (built-in list plus forms.redactFields);
 * - every other value goes through the shared secret masking and is capped;
 * - IP address, browser and device are never shown (callers simply don't read them).
 */

export const REDACTED = "[redacted]";
export const VALUE_LIMIT = 500;

/** Built-in sensitive name/label patterns, matched case-insensitively against the field name and label. */
export const DEFAULT_REDACT_PATTERNS = [
  "password",
  "passwd",
  "ssn",
  "social security",
  "social_security",
  "card number",
  "card_number",
  "cardnumber",
  "credit card",
  "cvv",
  "cvc",
  "iban",
  "routing",
  "account number",
  "account_number",
  "tax id",
  "tax_id",
  "taxid",
  "passport",
  "licence number",
  "license number",
  "license_number",
  "secret",
  "token",
];

const FILE_ELEMENTS = new Set(["input_file", "input_image", "featured_image"]);

export type Shown =
  | { kind: "value"; value: string }
  | { kind: "files"; value: string; files: string[] }
  | { kind: "redacted"; value: string }
  | { kind: "omitted" };

/** Lower-case words: camelCase split, anything not a letter or digit becomes a space. */
function words(s: string): string {
  return ` ${s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
}

/**
 * A pattern matches as whole words in the field name or label ("tax id" matches "Tax ID" and "tax_id", but
 * "ssn" does not match "businessName").
 */
export function isSensitive(
  field: Pick<FieldDef, "name" | "label">,
  extra: readonly string[],
): boolean {
  const hay = `${words(field.name)}|${words(field.label)}`;
  return [...DEFAULT_REDACT_PATTERNS, ...extra].some((p) => hay.includes(words(p)));
}

/** File name from an upload URL: the last path segment, decoded. Never the URL itself. */
export function fileName(url: string): string {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.split("/").filter(Boolean).pop() ?? "file");
  } catch {
    return url.split(/[\\/]/).filter(Boolean).pop()?.split("?")[0] ?? "file";
  }
}

function flatten(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(flatten).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    // Name fields: first, middle, last in order.
    if ("first_name" in o || "last_name" in o) {
      return [o.first_name, o.middle_name, o.last_name].map(flatten).filter(Boolean).join(" ");
    }
    return Object.values(o).map(flatten).filter(Boolean).join(", ");
  }
  return String(value);
}

/** How one field's value is shown. */
export function showField(field: FieldDef, raw: unknown, extraPatterns: readonly string[]): Shown {
  if (field.element === "input_password") return { kind: "omitted" };
  if (FILE_ELEMENTS.has(field.element)) {
    const urls = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String).filter(Boolean);
    const files = urls.map(fileName);
    return { kind: "files", value: files.length ? files.join(", ") : "", files };
  }
  if (field.element === "input_signature" || field.element === "signature") {
    return { kind: "value", value: raw ? "signed" : "" };
  }
  if (isSensitive(field, extraPatterns)) {
    return { kind: "redacted", value: flatten(raw) ? REDACTED : "" };
  }
  if (isPaymentElement(field.element)) {
    return { kind: "value", value: flatten(raw) };
  }
  return { kind: "value", value: truncate(maskSecrets(flatten(raw)), VALUE_LIMIT) };
}
