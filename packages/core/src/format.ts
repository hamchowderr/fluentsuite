import type { PageInfo } from "./paging.js";

/** Small helpers that keep tool output short and readable for both people and models. */

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

export function truncate(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/** `Tags: a, b, c (+4 more)` */
export function joinLimited(items: readonly string[], max = 8): string {
  if (items.length === 0) return "none";
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown} (+${items.length - max} more)` : shown;
}

/** A date as YYYY-MM-DD, or "never". Accepts WordPress `Y-m-d H:i:s` strings. */
export function shortDate(value: string | null | undefined): string {
  if (!value) return "never";
  return value.slice(0, 10);
}

export function pagingLine(info: PageInfo, noun: string): string {
  const start = (info.page - 1) * info.perPage + 1;
  const end = Math.min(info.total, info.page * info.perPage);
  const range =
    info.total === 0
      ? `0 ${noun}`
      : `${start}–${end} of ${plural(info.total, noun.replace(/s$/, ""), noun)}`;
  return info.nextCursor
    ? `${range}. More available: pass cursor="${info.nextCursor}".`
    : `${range}.`;
}

/** Render `label: value` lines, skipping empty values. */
export function fields(
  entries: ReadonlyArray<readonly [string, string | number | null | undefined]>,
): string {
  return entries
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}
