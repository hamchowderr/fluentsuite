import { createHash } from "node:crypto";
import * as z from "zod/v4";
import { FluentSuiteError } from "./errors.js";

/**
 * Opaque, stateless pagination cursors.
 *
 * A cursor encodes the next page number plus a fingerprint of the query it belongs to, so a
 * cursor from one search cannot silently be replayed against a different one. Nothing is stored
 * server side, which keeps the server stateless (MCP 2026-07-28).
 */

const CursorPayload = z.object({
  v: z.literal(1),
  /** Tool the cursor belongs to. */
  t: z.string(),
  /** Next page (1-based). */
  p: z.number().int().min(1),
  /** Page size. */
  s: z.number().int().min(1).max(100),
  /** Query fingerprint. */
  f: z.string(),
});

export interface PageRequest {
  page: number;
  perPage: number;
}

export function fingerprint(query: unknown): string {
  return createHash("sha256").update(stableStringify(query)).digest("base64url").slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function encodeCursor(tool: string, query: unknown, next: PageRequest): string {
  const payload = { v: 1, t: tool, p: next.page, s: next.perPage, f: fingerprint(query) };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/**
 * Resolve the page to fetch. With no cursor, page 1 at `defaultPerPage`. With a cursor, it must
 * belong to the same tool and the same query, otherwise the model gets a clear error.
 */
export function decodeCursor(
  tool: string,
  query: unknown,
  cursor: string | undefined,
  defaultPerPage: number,
): PageRequest {
  if (!cursor) return { page: 1, perPage: defaultPerPage };
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new FluentSuiteError("invalid_input", "The cursor is not valid.", {
      hint: "Use the cursor exactly as returned by the previous call, or omit it to start over.",
    });
  }
  const parsed = CursorPayload.safeParse(raw);
  if (!parsed.success || parsed.data.t !== tool) {
    throw new FluentSuiteError("invalid_input", "The cursor is not valid for this tool.", {
      hint: "Omit the cursor to start from the first page.",
    });
  }
  if (parsed.data.f !== fingerprint(query)) {
    throw new FluentSuiteError("invalid_input", "The cursor belongs to a different search.", {
      hint: "Repeat the same filters as the call that returned the cursor, or omit it to start over.",
    });
  }
  return { page: parsed.data.p, perPage: parsed.data.s };
}

/** The Laravel-style paginator FluentCRM and other WPManageNinja plugins return. */
export const LaravelPage = <T extends z.ZodType>(item: T) =>
  z.looseObject({
    total: z.coerce.number(),
    per_page: z.coerce.number(),
    current_page: z.coerce.number(),
    last_page: z.coerce.number().optional(),
    data: z.array(item),
  });

export interface PageInfo {
  total: number;
  page: number;
  perPage: number;
  /** Cursor for the next page, absent on the last page. */
  nextCursor?: string;
}

export function pageInfo(
  tool: string,
  query: unknown,
  page: { total: number; current_page: number; per_page: number; last_page?: number | undefined },
): PageInfo {
  const lastPage =
    page.last_page ?? Math.max(1, Math.ceil(page.total / Math.max(1, page.per_page)));
  const info: PageInfo = { total: page.total, page: page.current_page, perPage: page.per_page };
  if (page.current_page < lastPage) {
    info.nextCursor = encodeCursor(tool, query, {
      page: page.current_page + 1,
      perPage: page.per_page,
    });
  }
  return info;
}
