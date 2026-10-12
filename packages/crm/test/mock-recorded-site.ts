import { readFileSync } from "node:fs";
import { MockWordPress, mockJson } from "@fluentsuite/core/testing";

/**
 * A mock FluentCRM site built from responses RECORDED on the FluentSuite test site (FluentCRM 3.2.5 with
 * Pro, 50 fictional @example.com contacts; see docs/test-site.md and scripts/record-fixtures.mjs).
 *
 * Static endpoints replay their recordings. GET subscribers filters the recorded contacts the way
 * FluentCRM's simple filter does: search (LIKE on name/email/location/phone/status), tags[] and
 * lists[] (ANY within, AND across), statuses[], sort_by/sort_type, and Laravel paging.
 */

interface Recording {
  status: number;
  body: Record<string, unknown>;
}
const recorded = (name: string): Recording =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/recorded/${name}`, import.meta.url), "utf8"),
  ) as Recording;
const replay = (name: string) => {
  const r = recorded(name);
  return mockJson(r.body, r.status);
};

interface Contact {
  id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  status: string;
  created_at: string | null;
  tags: Array<{ id: number | string; title?: string; slug?: string }>;
  lists: Array<{ id: number | string; title?: string; slug?: string }>;
  [key: string]: unknown;
}

const SEARCH_FIELDS = [
  "email",
  "first_name",
  "last_name",
  "city",
  "state",
  "country",
  "phone",
  "status",
];

export const recordedContacts = (): Contact[] =>
  (recorded("dataset-subscribers.json").body.subscribers as { data: Contact[] }).data;

function paginate<T>(rows: T[], query: URLSearchParams) {
  const perPage = Number(query.get("per_page") ?? 15);
  const page = Number(query.get("page") ?? 1);
  const lastPage = Math.max(1, Math.ceil(rows.length / perPage));
  const data = rows.slice((page - 1) * perPage, page * perPage);
  return {
    current_page: page,
    data,
    from: data.length ? (page - 1) * perPage + 1 : null,
    last_page: lastPage,
    per_page: perPage,
    to: data.length ? (page - 1) * perPage + data.length : null,
    total: rows.length,
  };
}

type Taxon = { id: number; title: string; slug: string };

export interface RecordedSite extends MockWordPress {
  state: {
    contacts: Contact[];
    tags: Taxon[];
    lists: Taxon[];
    campaigns: Map<number, Record<string, unknown>>;
    notes: Array<{ subscriber_id: number; title: string; type: string; description: string }>;
    sent: Array<{ campaign_id: number; scheduled_at: string; recipients: number }>;
  };
}

const ids = (values: unknown): number[] => (Array.isArray(values) ? values.map(Number) : []);

export function createRecordedSite(options: { pro?: boolean } = {}): RecordedSite {
  const wp = new MockWordPress() as RecordedSite;
  const ns = "fluent-crm/v2";
  const contacts = recordedContacts();
  const tags = (recorded("dataset-tags.json").body.tags as { data: Taxon[] }).data.map((t) => ({
    id: Number(t.id),
    title: t.title,
    slug: t.slug,
  }));
  const lists = (recorded("lists.json").body.lists as Taxon[]).map((l) => ({
    id: Number(l.id),
    title: l.title,
    slug: l.slug,
  }));
  const campaigns = new Map<number, Record<string, unknown>>();
  const first = recorded("campaign-show.json").body.campaign as Record<string, unknown>;
  campaigns.set(Number(first.id), first);
  const state: RecordedSite["state"] = { contacts, tags, lists, campaigns, notes: [], sent: [] };
  wp.state = state;
  let nextId = 1000;
  const now = () => "2026-10-12 02:30:00";
  const slugify = (t: string) =>
    t
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  const has = (c: Contact, kind: "tags" | "lists", id: number) =>
    c[kind].some((x) => Number(x.id) === id);
  const notFound = () => mockJson({ message: "Subscriber not found" }, 422);

  /** Subscribed contacts reached by a FluentCRM list/tag recipient selection. */
  const recipients = (sel: Record<string, unknown>): Contact[] => {
    const rows = (sel.subscribers ?? []) as Array<{ list: string; tag: string }>;
    const ex = (sel.excludedSubscribers ?? []) as Array<{
      list: string | null;
      tag: string | null;
    }>;
    return contacts.filter(
      (c) =>
        c.status === "subscribed" &&
        rows.some(
          (r) =>
            (r.list === "all" || has(c, "lists", Number(r.list))) &&
            (r.tag === "all" || has(c, "tags", Number(r.tag))),
        ) &&
        !ex.some(
          (e) =>
            (e.list !== null && has(c, "lists", Number(e.list))) ||
            (e.tag !== null && has(c, "tags", Number(e.tag))),
        ),
    );
  };

  wp.on("GET", `${ns}/subscribers`, ({ query }) => {
    const search = query.get("search")?.toLowerCase();
    const tagIds = query.getAll("tags[]").map(Number);
    const listIds = query.getAll("lists[]").map(Number);
    const statuses = query.getAll("statuses[]");
    const sortBy = query.get("sort_by") ?? "id";
    const asc = (query.get("sort_type") ?? "DESC").toUpperCase() === "ASC";
    const rows = contacts
      .filter(
        (c) =>
          !search ||
          SEARCH_FIELDS.some((f) =>
            String(c[f] ?? "")
              .toLowerCase()
              .includes(search),
          ),
      )
      .filter((c) => !tagIds.length || tagIds.some((id) => has(c, "tags", id)))
      .filter((c) => !listIds.length || listIds.some((id) => has(c, "lists", id)))
      .filter((c) => !statuses.length || statuses.includes(c.status))
      .sort((a, b) => {
        const av = a[sortBy] ?? "";
        const bv = b[sortBy] ?? "";
        const cmp =
          typeof av === "number" && typeof bv === "number"
            ? av - bv
            : String(av).localeCompare(String(bv));
        return asc ? cmp : -cmp;
      });
    return { subscribers: paginate(rows, query), custom: null };
  });
  wp.on("GET", `${ns}/subscribers/:id`, ({ params, query }) => {
    const id = Number(params.id);
    const email = query.get("get_by_email")?.toLowerCase();
    const c = id
      ? contacts.find((x) => x.id === id)
      : contacts.find((x) => x.email.toLowerCase() === email);
    if (!c) return notFound();
    return {
      subscriber: {
        ...c,
        stats: { emails: 0, opens: 0, clicks: 0 },
        custom_values: c.custom_values ?? [],
      },
    };
  });
  wp.on("GET", `${ns}/subscribers/:id/emails`, ({ query }) => ({ emails: paginate([], query) }));
  wp.on("GET", `${ns}/subscribers/:id/notes`, ({ params, query }) => ({
    notes: paginate(
      state.notes.filter((n) => n.subscriber_id === Number(params.id)),
      query,
    ),
  }));
  wp.on("POST", `${ns}/subscribers`, ({ body }) => {
    const b = body as Record<string, unknown>;
    if (contacts.some((c) => c.email === b.email)) {
      return mockJson(
        { email: { unique: "Provided email already assigned to another subscriber." } },
        422,
      );
    }
    const contact: Contact = {
      id: ++nextId,
      email: String(b.email),
      first_name: (b.first_name as string) ?? null,
      last_name: (b.last_name as string) ?? null,
      status: String(b.status),
      created_at: now(),
      contact_type: (b.contact_type as string) ?? "lead",
      source: (b.source as string) ?? null,
      tags: tags.filter((t) => ids(b.tags).includes(t.id)),
      lists: lists.filter((l) => ids(b.lists).includes(l.id)),
      custom_values: b.custom_values ?? {},
      double_optin_sent: Boolean(b.double_optin),
    };
    contacts.push(contact);
    return { message: "Successfully added the subscriber.", contact, action_type: "created" };
  });
  wp.on("PUT", `${ns}/subscribers/subscribers-property`, ({ body }) => {
    const b = body as { property: string; value: string; subscribers: number[] };
    for (const c of contacts) if (b.subscribers.includes(c.id)) c.status = b.value;
    return { message: "Subscribers successfully updated" };
  });
  wp.on("PUT", `${ns}/subscribers/:id`, ({ params, body }) => {
    const c = contacts.find((x) => x.id === Number(params.id));
    if (!c) return notFound();
    const { attach_tags, attach_lists, custom_values, ...fields } = body as Record<string, unknown>;
    Object.assign(c, fields);
    if (custom_values) c.custom_values = custom_values;
    for (const id of ids(attach_tags))
      if (!has(c, "tags", id)) c.tags.push(tags.find((t) => t.id === id) as Taxon);
    for (const id of ids(attach_lists))
      if (!has(c, "lists", id)) c.lists.push(lists.find((l) => l.id === id) as Taxon);
    return { message: "Subscriber successfully updated", contact: c };
  });
  wp.on("POST", `${ns}/subscribers/sync-segments`, ({ body }) => {
    const b = body as {
      type: string;
      subscribers: number[];
      attach: number[];
      detach: number[];
      find_by: string;
    };
    const kind = b.type === "tags" ? "tags" : "lists";
    const pool = kind === "tags" ? tags : lists;
    for (const c of contacts.filter((x) => b.subscribers.includes(x.id))) {
      c[kind] = c[kind].filter((x) => !b.detach.includes(Number(x.id)));
      for (const id of b.attach)
        if (!has(c, kind, id)) c[kind].push(pool.find((x) => x.id === id) as Taxon);
    }
    return { message: "Successfully updated the subscribers.", subscribers: [] };
  });
  wp.on("POST", `${ns}/subscribers/:id/notes`, ({ params, body }) => {
    const note = (body as { note: { title: string; type: string; description: string } }).note;
    state.notes.push({ subscriber_id: Number(params.id), ...note });
    return { note: { id: state.notes.length, ...note }, message: "Note successfully added" };
  });

  const taxonomyRoutes = (kind: "tags" | "lists", pool: Taxon[]) => {
    wp.on("POST", `${ns}/${kind}`, ({ body }) => {
      const title = String((body as { title: string }).title);
      const item = { id: ++nextId, title, slug: slugify(title) };
      pool.push(item);
      return { item, message: "Successfully saved." };
    });
  };
  taxonomyRoutes("tags", tags);
  taxonomyRoutes("lists", lists);
  const subscribedWith = (kind: "tags" | "lists", id: number) =>
    contacts.filter((c) => c.status === "subscribed" && has(c, kind, id)).length;
  wp.on("GET", `${ns}/tags`, ({ query }) => ({
    tags: paginate(
      tags.map((t) => ({ ...t, subscribersCount: subscribedWith("tags", t.id) })),
      query,
    ),
  }));
  wp.on("GET", `${ns}/lists`, () => ({
    lists: lists.map((l) => ({
      ...l,
      subscribersCount: subscribedWith("lists", l.id),
      totalCount: contacts.filter((c) => has(c, "lists", l.id)).length,
    })),
    pagination: { total: lists.length },
  }));

  wp.on("GET", `${ns}/campaigns`, ({ query }) => ({
    campaigns: paginate(
      [...campaigns.values()]
        .sort((a, b) => Number(b.id) - Number(a.id))
        .map((c) => ({
          ...c,
          stats: { total: 0, sent: 0, views: 0, clicks: 0, unsubscribers: 0 },
        })),
      query,
    ),
  }));
  wp.on("GET", `${ns}/campaigns/:id`, ({ params }) => {
    const c = campaigns.get(Number(params.id));
    return c ? { campaign: c } : mockJson({ message: "Campaign not found" }, 422);
  });
  wp.on("POST", `${ns}/campaigns`, ({ body }) => {
    const title = String((body as { title: string }).title);
    if ([...campaigns.values()].some((c) => c.title === title)) {
      return mockJson(
        { title: { unique: "The title attribute is already taken and must be unique." } },
        422,
      );
    }
    const c: Record<string, unknown> = {
      id: ++nextId,
      title,
      type: "campaign",
      status: "draft",
      recipients_count: 0,
      settings: {
        mailer_settings: { is_custom: "no" },
        template_config: {},
        sending_type: "instant",
      },
    };
    campaigns.set(Number(c.id), c);
    return c;
  });
  wp.on("PUT", `${ns}/campaigns/:id`, ({ params, body }) => {
    const c = campaigns.get(Number(params.id));
    if (!c) return mockJson({ message: "Campaign not found" }, 422);
    Object.assign(c, body);
    return { campaign: c };
  });
  wp.on("POST", `${ns}/campaigns/estimated-contacts`, ({ body }) => ({
    count: recipients(body as Record<string, unknown>).length,
    execution_time: 0.01,
  }));
  wp.on("POST", `${ns}/campaigns/:id/draft-recipients`, ({ params, body }) => {
    const c = campaigns.get(Number(params.id));
    if (!c) return mockJson({ message: "Campaign not found" }, 422);
    const count = recipients(body as Record<string, unknown>).length;
    if (!count)
      return mockJson({ message: "Sorry no subscribers found based on your selection" }, 422);
    c.settings = { ...(c.settings as object), ...(body as object) };
    c.recipients_count = count;
    return { message: "Recipient settings has been updated", count };
  });
  wp.on("GET", `${ns}/campaigns/:id/estimated-recipients-count`, ({ params }) => ({
    estimated_count: recipients(
      (campaigns.get(Number(params.id))?.settings ?? {}) as Record<string, unknown>,
    ).length,
  }));
  wp.on("GET", `${ns}/campaigns/:id/contacts-by-segment`, ({ params, query }) => ({
    subscribers: paginate(
      recipients((campaigns.get(Number(params.id))?.settings ?? {}) as Record<string, unknown>),
      query,
    ),
  }));
  wp.on("POST", `${ns}/campaigns/:id/subscribe`, ({ params, body }) => {
    const c = campaigns.get(Number(params.id));
    if (!c) return mockJson({ message: "Campaign not found" }, 422);
    const total = recipients(body as Record<string, unknown>).length;
    c.queued = total;
    return { has_more: false, count: total, total_items: total, page_total: 1, next_page: 2 };
  });
  wp.on("POST", `${ns}/campaigns/:id/schedule`, ({ params, body }) => {
    const c = campaigns.get(Number(params.id));
    if (c?.status !== "draft")
      return mockJson({ message: "Campaign status is not in draft status." }, 422);
    const at = String((body as { scheduled_at?: string }).scheduled_at ?? "");
    c.status = at ? "pending-scheduled" : "processing";
    state.sent.push({
      campaign_id: Number(c.id),
      scheduled_at: at,
      recipients: Number(c.queued ?? 0),
    });
    return { campaign: c, message: "Campaign has been scheduled", current_timestamp: now() };
  });
  wp.on("GET", `${ns}/campaigns/:id/overview_stats`, () => replay("campaign-overview-stats.json"));
  wp.on("GET", `${ns}/campaigns/:id/link-report`, () => replay("campaign-link-report.json"));
  wp.on("GET", `${ns}/reports/dashboard-stats`, () => replay("dashboard-stats.json"));
  for (const kind of ["subscribers", "email-sents", "email-opens", "email-clicks"]) {
    wp.on("GET", `${ns}/reports/${kind}`, () => replay(`report-${kind}.json`));
  }
  if (options.pro !== false) {
    wp.on("GET", `${ns}/sequences`, () => replay("sequences.json"));
    wp.on("GET", `${ns}/sequences/:id`, ({ params }) =>
      params.id === "2"
        ? replay("sequence-show.json")
        : mockJson({ message: "Sequence not found" }, 422),
    );
  }
  return wp;
}
