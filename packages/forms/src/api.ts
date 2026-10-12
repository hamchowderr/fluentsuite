import {
  FluentSuiteError,
  isMissingRoute,
  LaravelPage,
  type NamespacedClient,
  type WordPressClient,
} from "@fluentsuite/core";
import * as z from "zod/v4";
import { type FieldDef, parseFields } from "./fields.js";

/**
 * Typed access to the Fluent Forms REST API (namespace `fluentform/v1`).
 *
 * Never calls GET submissions/{id}: Fluent Forms marks an unread entry as read when it is opened that way
 * (SubmissionService::find, filter fluentform/auto_read_submission), so a read tool would quietly write. One entry
 * is found through the list route instead, which has no side effects. Never calls the form-submit route.
 */

const str = z.coerce.string();
const nullableString = z.string().nullish();
const num = z.coerce.number();

const FormRow = z.looseObject({
  id: num,
  title: z.string(),
  status: z.string(),
  type: nullableString,
  has_payment: z.coerce.string().nullish(),
  created_at: nullableString,
  total_Submissions: num.nullish(),
  unread_count: num.nullish(),
});
export type FormRow = z.infer<typeof FormRow>;

const FormMeta = z.looseObject({ meta_key: z.string(), value: z.unknown() });
const FormShow = z.looseObject({
  id: num,
  title: z.string(),
  status: z.string(),
  type: nullableString,
  has_payment: z.coerce.string().nullish(),
  created_at: nullableString,
  form_fields: nullableString,
  form_meta: z.array(FormMeta).default([]),
});

export const EntryRaw = z.looseObject({
  id: num,
  form_id: num,
  serial_number: z.coerce.number().nullish(),
  response: nullableString,
  source_url: nullableString,
  status: z.string(),
  is_favourite: z.coerce.string().nullish(),
  city: nullableString,
  country: nullableString,
  payment_status: nullableString,
  payment_method: nullableString,
  payment_type: nullableString,
  currency: nullableString,
  payment_total: z.coerce.number().nullish(),
  total_paid: z.coerce.number().nullish(),
  created_at: nullableString,
  // ip, browser and device come back too; they are never read.
});
export type EntryRaw = z.infer<typeof EntryRaw>;

const Notification = z.looseObject({
  id: num,
  value: z.looseObject({
    name: nullableString,
    enabled: z.unknown(),
    sendTo: z
      .looseObject({ type: nullableString, email: nullableString, field: nullableString })
      .nullish(),
  }),
});
export type Notification = z.infer<typeof Notification>;

const Feed = z.looseObject({
  id: num,
  name: nullableString,
  enabled: z.unknown(),
  provider: nullableString,
});
const Integrations = z.looseObject({ feeds: z.array(Feed).default([]) });

const Note = z.looseObject({
  id: num,
  value: nullableString,
  created_by: nullableString,
  name: nullableString,
  created_at: nullableString,
});
export type Note = z.infer<typeof Note>;

const Series = z.looseObject({
  dates: z.array(str).default([]),
  values: z.record(z.string(), z.array(z.coerce.number())).default({}),
});
const Overview = z.looseObject({ overview_chart: Series });
const Revenue = z.looseObject({ revenue_chart: Series });
const Stat = z.looseObject({ value: z.unknown(), change: z.unknown().optional() });
const FormStats = z.looseObject({ form_stats: z.record(z.string(), z.unknown()) });
const TopForms = z.looseObject({
  top_performing_forms: z
    .array(z.looseObject({ id: num, title: z.string(), value: num }))
    .default([]),
});
export type StatValue = z.infer<typeof Stat>;

export type EntryType = "unread" | "read" | "favorites" | "trashed";

export interface EntryFilter {
  formId?: number | undefined;
  type?: EntryType | undefined;
  after?: string | undefined;
  before?: string | undefined;
  search?: string | undefined;
  paymentStatuses?: string[] | undefined;
}

export interface FormDetail {
  id: number;
  title: string;
  status: string;
  type: string | null;
  hasPayment: boolean;
  createdAt: string | null;
  fields: FieldDef[];
  settings: Record<string, unknown>;
}

/** The most entries looked through to find one entry by id. */
export const FIND_SCAN_LIMIT = 500;

export class FluentFormsApi {
  private readonly ff: NamespacedClient;
  private readonly forms = new Map<number, Promise<FormDetail>>();

  constructor(readonly wp: WordPressClient) {
    this.ff = wp.namespace("fluentform/v1");
  }

  entryUrl(formId: number, entryId: number): string {
    return `${this.wp.siteUrl.replace(/\/+$/, "")}/wp-admin/admin.php?page=fluent_forms&route=entries&form_id=${formId}#/entries/${entryId}`;
  }

  listForms(
    query: { search?: string | undefined; page: number; perPage: number },
    signal?: AbortSignal,
  ) {
    return this.call(() =>
      this.ff.get("forms", {
        query: { search: query.search, page: query.page, per_page: query.perPage },
        schema: LaravelPage(FormRow),
        signal,
      }),
    );
  }

  /** A form with its parsed fields and settings. Cached for the life of this API object (one tool call). */
  form(id: number, signal?: AbortSignal): Promise<FormDetail> {
    let pending = this.forms.get(id);
    if (!pending) {
      pending = this.call(async () => {
        try {
          const f = await this.ff.get(`forms/${id}`, { schema: FormShow, signal });
          const settingsMeta = f.form_meta.find((m) => m.meta_key === "formSettings")?.value;
          const settings =
            typeof settingsMeta === "string" ? safeJson(settingsMeta) : (settingsMeta as object);
          return {
            id: f.id,
            title: f.title,
            status: f.status,
            type: f.type ?? null,
            hasPayment: f.has_payment === "1",
            createdAt: f.created_at ?? null,
            fields: parseFields(f.form_fields),
            settings: (settings ?? {}) as Record<string, unknown>,
          };
        } catch (error) {
          if (
            error instanceof FluentSuiteError &&
            !isMissingRoute(error) &&
            [400, 404, 422].includes(error.status ?? 0)
          ) {
            throw new FluentSuiteError("not_found", `No form with id ${id}.`, {
              status: error.status,
              hint: "List forms with forms_list.",
            });
          }
          throw error;
        }
      });
      this.forms.set(id, pending);
      pending.catch(() => this.forms.delete(id));
    }
    return pending;
  }

  notifications(formId: number, signal?: AbortSignal) {
    return this.call(() =>
      this.ff.get(`settings/${formId}`, {
        query: { meta_key: "notifications" },
        schema: z.array(Notification),
        signal,
      }),
    );
  }

  /** Feed id, name, provider and on/off only. The feed settings themselves are never read. */
  async feeds(formId: number, signal?: AbortSignal) {
    const res = await this.call(() =>
      this.ff.get(`integrations/${formId}/form-integrations`, { schema: Integrations, signal }),
    );
    return res.feeds.map((f) => ({
      id: f.id,
      name: f.name ?? "(unnamed)",
      provider: f.provider ?? "unknown",
      enabled: f.enabled === true || f.enabled === "true" || f.enabled === 1 || f.enabled === "1",
    }));
  }

  entries(filter: EntryFilter, page: { page: number; perPage: number }, signal?: AbortSignal) {
    const query: Record<string, string | number | string[] | undefined> = {
      form_id: filter.formId,
      entry_type: filter.type,
      search: filter.search,
      page: page.page,
      per_page: page.perPage,
      sort_by: "DESC",
    };
    if (filter.after || filter.before) {
      query["date_range[0]"] = filter.after ?? "1970-01-01";
      query["date_range[1]"] = filter.before ?? "2999-12-31";
    }
    if (filter.paymentStatuses?.length) query.payment_statuses = filter.paymentStatuses;
    return this.call(() =>
      this.ff.get("submissions", { query, schema: LaravelPage(EntryRaw), signal }),
    );
  }

  /**
   * One entry by id, without Fluent Forms' auto-read side effect: searches the list route for the id (it matches
   * ids by LIKE), keeps the exact match, and looks in the trash too.
   */
  async findEntry(id: number, formId: number | undefined, signal?: AbortSignal): Promise<EntryRaw> {
    for (const type of [undefined, "trashed"] as const) {
      let scanned = 0;
      for (let page = 1; scanned < FIND_SCAN_LIMIT; page++) {
        const res = await this.entries(
          { formId, type, search: String(id) },
          { page, perPage: 100 },
          signal,
        );
        const hit = res.data.find((e) => e.id === id);
        if (hit) return hit;
        scanned += res.data.length;
        if (page >= (res.last_page ?? 1) || !res.data.length) break;
      }
    }
    throw new FluentSuiteError(
      "not_found",
      `No entry with id ${id}${formId ? ` on form ${formId}` : ""}.`,
      {
        hint: "Find entries with forms_find_entries; passing form_id narrows the search.",
      },
    );
  }

  notes(entryId: number, signal?: AbortSignal) {
    return this.call(() =>
      this.ff.get(`submissions/${entryId}/notes`, { schema: z.array(Note), signal }),
    );
  }

  overview(range: Range, signal?: AbortSignal) {
    return this.call(() =>
      this.ff.get("report/overview-chart", { query: rangeQuery(range), schema: Overview, signal }),
    );
  }

  revenue(range: Range, signal?: AbortSignal) {
    return this.call(() =>
      this.ff.get("report/revenue-chart", { query: rangeQuery(range), schema: Revenue, signal }),
    );
  }

  formStats(range: Range, signal?: AbortSignal) {
    return this.call(() =>
      this.ff.get("report/form-stats", { query: rangeQuery(range), schema: FormStats, signal }),
    );
  }

  topForms(range: Range, signal?: AbortSignal) {
    return this.call(() =>
      this.ff.get("report/top-performing-forms", {
        query: { ...rangeQuery(range), metric: "entries" },
        schema: TopForms,
        signal,
      }),
    );
  }

  // ---- Writes. Only ever called from guardedWrite's execute step. Never form-submit. -------------------

  /**
   * Fluent Forms' bulk route, one form at a time. `action` is a status (read, unread, trashed) or
   * other.make_favorite / other.unmark_favorite / other.delete_permanently.
   */
  bulk(formId: number, entryIds: number[], action: string, signal?: AbortSignal) {
    return this.call(() =>
      this.ff.post("submissions/bulk-actions", {
        body: { form_id: formId, entries: entryIds, action_type: action },
        signal,
      }),
    );
  }

  addNote(entryId: number, content: string, signal?: AbortSignal) {
    return this.call(() =>
      this.ff.post(`submissions/${entryId}/notes`, {
        body: { note: { content, status: "info" } },
        signal,
      }),
    );
  }

  /**
   * Every entry of one form matching a filter (open and trashed), up to `cap`. Throws if more match, so a write
   * never acts on a silently truncated set.
   */
  async collect(
    filter: EntryFilter & { formId: number; includeTrashed?: boolean },
    cap: number,
    signal?: AbortSignal,
  ): Promise<EntryRaw[]> {
    const types: Array<EntryType | undefined> = filter.type
      ? [filter.type]
      : filter.includeTrashed
        ? [undefined, "trashed"]
        : [undefined];
    const out: EntryRaw[] = [];
    for (const type of types) {
      for (let page = 1; ; page++) {
        const res = await this.entries({ ...filter, type }, { page, perPage: 100 }, signal);
        out.push(...res.data);
        if (out.length > cap) {
          throw new FluentSuiteError(
            "invalid_input",
            `More than ${cap} entries match; narrow the selection.`,
            {
              hint: "Use a date range, a status or fewer ids.",
            },
          );
        }
        if (page >= (res.last_page ?? 1) || !res.data.length) break;
      }
    }
    return out;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (isMissingRoute(error)) {
        throw new FluentSuiteError("not_found", "Fluent Forms is not active on this site.", {
          status: 404,
          hint: "Activate Fluent Forms in wp-admin → Plugins.",
        });
      }
      if (error instanceof FluentSuiteError && error.code === "forbidden") {
        throw new FluentSuiteError(error.code, error.message, {
          status: error.status,
          hint: "The WordPress user needs Fluent Forms' entry permissions for this form.",
        });
      }
      throw error;
    }
  }
}

export interface Range {
  after: string;
  before: string;
  formId?: number | undefined;
}

function rangeQuery(r: Range) {
  return { start_date: r.after, end_date: r.before, form_id: r.formId };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
