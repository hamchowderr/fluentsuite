import { readFileSync } from "node:fs";
import { MockWordPress, mockJson } from "@fluentsuite/core/testing";

/**
 * A mock FluentCRM REST API (namespace fluent-crm/v2) backed by JSON fixtures.
 *
 * Fixture shapes follow docs/reference/fluentcrm-rest-api.md, which was written from the
 * FluentCRM 2.9.84 source: Laravel paginators, `__bench`, `with[]` expansions, and FluentCRM's
 * quirky errors (an unknown contact is HTTP 422 `{"message":"Subscriber not found"}`).
 * Data is fictional and uses the reserved example.test domain.
 */

const load = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;

type Row = Record<string, unknown> & { id: number };

interface SubscriberFixtures {
  subscribers: Array<Row & { email: string }>;
  stats: Record<string, unknown>;
  custom_values: Record<string, Record<string, unknown>>;
}

function paginate<T>(rows: T[], query: URLSearchParams, route: string) {
  const perPage = Number(query.get("per_page") ?? 15);
  const page = Number(query.get("page") ?? 1);
  const total = rows.length;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const data = rows.slice((page - 1) * perPage, page * perPage);
  const url = (p: number) => `https://crm.example.test/wp-json/${route}?page=${p}`;
  return {
    total,
    per_page: perPage,
    current_page: page,
    last_page: lastPage,
    next_page_url: page < lastPage ? url(page + 1) : null,
    prev_page_url: page > 1 ? url(page - 1) : null,
    from: data.length ? (page - 1) * perPage + 1 : null,
    to: data.length ? (page - 1) * perPage + data.length : null,
    data,
  };
}

export function createMockFluentCrm() {
  const fx = load<SubscriberFixtures>("subscribers.json");
  const emails = load<Record<string, Row[]>>("emails.json");
  const notes = load<Record<string, Row[]>>("notes.json");
  const wp = new MockWordPress();
  const ns = "fluent-crm/v2";
  const notFound = () => mockJson({ message: "Subscriber not found" }, 422);
  const bench = { __bench: 0.012 };

  wp.on("GET", `${ns}/subscribers/:id`, ({ params, query }) => {
    const id = Number(params.id);
    const byEmail = query.get("get_by_email");
    const sub = id
      ? fx.subscribers.find((s) => s.id === id)
      : byEmail
        ? fx.subscribers.find((s) => s.email.toLowerCase() === byEmail.toLowerCase())
        : undefined;
    if (!sub) return notFound();
    const withs = query.getAll("with[]");
    const subscriber: Record<string, unknown> = { ...sub };
    if (withs.includes("stats")) subscriber.stats = fx.stats[String(sub.id)];
    if (withs.includes("subscriber.custom_values"))
      subscriber.custom_values = fx.custom_values[String(sub.id)] ?? [];
    return { subscriber, ...bench };
  });

  wp.on("GET", `${ns}/subscribers/:id/emails`, ({ params, query }) => {
    if (!fx.subscribers.some((s) => s.id === Number(params.id))) return notFound();
    return {
      emails: paginate(
        emails[params.id ?? ""] ?? [],
        query,
        `${ns}/subscribers/${params.id}/emails`,
      ),
      ...bench,
    };
  });

  wp.on("GET", `${ns}/subscribers/:id/notes`, ({ params, query }) => {
    if (!fx.subscribers.some((s) => s.id === Number(params.id))) return notFound();
    return {
      notes: paginate(notes[params.id ?? ""] ?? [], query, `${ns}/subscribers/${params.id}/notes`),
      fields: { fields: [] },
      ...bench,
    };
  });

  return wp;
}
