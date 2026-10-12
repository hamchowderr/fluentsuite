import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MockWordPress, mockJson } from "@fluentsuite/core/testing";

/**
 * A Fluent Forms site for offline tests, built from scrubbed recordings of the test site (fixtures/, recorded by
 * scripts/record-forms-fixtures.mjs). The entry list is filtered like Fluent Forms' Submission::customQuery.
 *
 * Two routes exist only so tests can prove they are never used: GET submissions/{id} (on a real site it marks the
 * entry read, so the mock does too) and POST form-submit (creating an entry fires notifications and feeds).
 */

const dir = join(import.meta.dirname, "fixtures");
export function fixture<T = unknown>(name: string): { route: string; status: number; body: T } {
  return JSON.parse(readFileSync(join(dir, name), "utf8"));
}

export interface EntryRecord {
  id: number;
  form_id: string;
  serial_number: string;
  response: string;
  source_url: string | null;
  status: string;
  is_favourite: string;
  ip: string | null;
  browser: string | null;
  device: string | null;
  city: string | null;
  country: string | null;
  payment_status: string | null;
  payment_method: string | null;
  payment_type: string | null;
  currency: string | null;
  payment_total: number | string | null;
  total_paid: number | string | null;
  created_at: string;
  updated_at: string;
}

interface FormDetailFixture {
  form: { id: number; title: string; [k: string]: unknown };
  notifications: unknown[];
  integrations: { feeds: unknown[]; [k: string]: unknown };
}

export interface MockFormsSite {
  wp: MockWordPress;
  siteUrl: string;
  fetch: MockWordPress["fetch"];
  entries: EntryRecord[];
  forms: Record<string, FormDetailFixture>;
  notes: Record<string, Array<Record<string, unknown>>>;
}

function byNewest(a: EntryRecord, b: EntryRecord) {
  return a.created_at === b.created_at ? b.id - a.id : a.created_at < b.created_at ? 1 : -1;
}

export function createMockForms(options: { active?: boolean } = {}): MockFormsSite {
  const siteUrl = "https://forms.example.test";
  const wp = new MockWordPress(siteUrl);
  const entries = structuredClone(fixture<EntryRecord[]>("entries.json").body);
  const forms = structuredClone(
    fixture<Record<string, FormDetailFixture>>("forms-detail.json").body,
  );
  const notes = structuredClone(
    fixture<Record<string, Array<Record<string, unknown>>>>("notes.json").body,
  );
  const site: MockFormsSite = { wp, siteUrl, fetch: wp.fetch, entries, forms, notes };
  if (options.active === false) return site; // every fluentform/v1 route answers rest_no_route
  const ns = "fluentform/v1";

  wp.on("GET", `${ns}/forms`, ({ query }) => {
    const recorded = fixture<{ data: Array<{ id: string; title: string }> }>("forms.json").body;
    const search = (query.get("search") ?? "").toLowerCase();
    const data = recorded.data
      .filter((f) => !search || f.title.toLowerCase().includes(search))
      .map((f) => {
        const list = entries.filter((e) => e.form_id === String(f.id) && e.status !== "trashed");
        return {
          ...f,
          total_Submissions: list.length,
          unread_count: list.filter((e) => e.status === "unread").length,
        };
      });
    const perPage = Number(query.get("per_page") ?? 10);
    const page = Number(query.get("page") ?? 1);
    return mockJson({
      current_page: page,
      per_page: perPage,
      last_page: Math.max(1, Math.ceil(data.length / perPage)),
      total: data.length,
      data: data.slice((page - 1) * perPage, page * perPage),
    });
  });

  const noForm = () => mockJson({ message: "Form not found" }, 422);
  // Forms listed in the recording without recorded details (Fluent Forms' own empty demo forms) get a minimal one.
  const listed = fixture<{ data: Array<{ id: string; title: string; status: string }> }>(
    "forms.json",
  ).body.data;
  wp.on("GET", `${ns}/forms/:id`, ({ params }) => {
    const id = params.id ?? "";
    if (forms[id]) return forms[id].form;
    const f = listed.find((x) => String(x.id) === id);
    return f
      ? {
          id: Number(f.id),
          title: f.title,
          status: f.status,
          form_fields: '{"fields":[]}',
          form_meta: [],
        }
      : noForm();
  });
  wp.on("GET", `${ns}/settings/:id`, ({ params }) => forms[params.id ?? ""]?.notifications ?? []);
  wp.on(
    "GET",
    `${ns}/integrations/:id/form-integrations`,
    ({ params }) => forms[params.id ?? ""]?.integrations ?? { feeds: [] },
  );

  wp.on("GET", `${ns}/submissions`, ({ query }) => {
    const formId = query.get("form_id");
    const type = query.get("entry_type");
    const start = query.get("date_range[0]");
    const end = query.get("date_range[1]");
    const search = (query.get("search") ?? "").toLowerCase();
    const payment = query.getAll("payment_statuses[]");
    const rows = entries
      .filter((e) => !formId || e.form_id === formId)
      .filter((e) => {
        if (type === "favorites") return e.is_favourite === "1" && e.status !== "trashed";
        if (type) return e.status === type;
        return e.status !== "trashed";
      })
      .filter(
        (e) => !(start && end) || (e.created_at >= start && e.created_at <= `${end} 23:59:59`),
      )
      .filter(
        (e) =>
          !search ||
          String(e.id).includes(search) ||
          e.response.toLowerCase().includes(search) ||
          e.status.includes(search) ||
          e.created_at.includes(search),
      )
      .filter((e) => !payment.length || payment.includes(e.payment_status ?? ""))
      .sort(byNewest);
    const perPage = Number(query.get("per_page") ?? 15);
    const page = Number(query.get("page") ?? 1);
    return mockJson({
      current_page: page,
      per_page: perPage,
      from: (page - 1) * perPage + 1,
      to: Math.min(rows.length, page * perPage),
      last_page: Math.max(1, Math.ceil(rows.length / perPage)),
      total: rows.length,
      data: rows.slice((page - 1) * perPage, page * perPage),
    });
  });

  // Like the real site: opening an entry this way marks it read. Tools must never call it.
  wp.on("GET", `${ns}/submissions/:id`, ({ params }) => {
    const e = entries.find((x) => x.id === Number(params.id));
    if (!e) return mockJson({ message: "Not found" }, 404);
    if (e.status === "unread") e.status = "read";
    return mockJson({ ...e, user_inputs: JSON.parse(e.response) });
  });

  wp.on("GET", `${ns}/submissions/:id/notes`, ({ params }) => notes[params.id ?? ""] ?? []);

  for (const [route, file] of [
    ["report/overview-chart", "report-overview.json"],
    ["report/form-stats", "report-form-stats.json"],
    ["report/top-performing-forms", "report-top-forms.json"],
    ["report/revenue-chart", "report-revenue.json"],
  ] as const) {
    wp.on("GET", `${ns}/${route}`, () => fixture(file).body);
  }

  wp.on("POST", `${ns}/submissions/bulk-actions`, ({ body }) => {
    const b = body as { form_id: number; entries: number[]; action_type: string };
    if (!b.form_id || !b.entries?.length)
      return mockJson({ message: "Please select entries first" }, 422);
    // Like Fluent Forms: only entries the form owns are touched.
    const owned = entries.filter(
      (e) => e.form_id === String(b.form_id) && b.entries.includes(e.id),
    );
    if (["read", "unread", "trashed", "spam"].includes(b.action_type)) {
      for (const e of owned) e.status = b.action_type;
    } else if (b.action_type === "other.make_favorite") {
      for (const e of owned) e.is_favourite = "1";
    } else if (b.action_type === "other.unmark_favorite") {
      for (const e of owned) e.is_favourite = "0";
    } else if (b.action_type === "other.delete_permanently") {
      for (const e of owned) entries.splice(entries.indexOf(e), 1);
    } else {
      return mockJson({ message: "Unknown action" }, 422);
    }
    return { message: "ok" };
  });

  wp.on("POST", `${ns}/submissions/:id/notes`, ({ params, body }) => {
    const id = params.id ?? "";
    const content = (body as { note?: { content?: string } }).note?.content ?? "";
    const list = notes[id] ?? [];
    list.push({
      id: list.length + 100,
      value: content,
      created_by: "fluentsuite-test",
      created_at: "2026-10-12 12:00:00",
    });
    notes[id] = list;
    return { message: "Note has been successfully added" };
  });

  // Creating an entry fires notifications, feeds and webhooks. Tools must never call it.
  wp.on("POST", `${ns}/form-submit`, () => mockJson({ message: "must never be called" }, 500));

  return site;
}

/** Requests that would have side effects FluentSuite promises never to cause. */
export function forbiddenCalls(site: MockFormsSite) {
  return site.wp.requests.filter(
    (r) =>
      (r.method === "GET" && /^fluentform\/v1\/submissions\/\d+$/.test(r.route)) ||
      /^fluentform\/v1\/form-submit/.test(r.route),
  );
}
