import { createServerFactory, parseConfig } from "@fluentsuite/core";
import { connectInProcess, textOf } from "@fluentsuite/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crmProduct } from "../src/index.js";
import { createRecordedSite, recordedContacts } from "./mock-recorded-site.js";

/**
 * The read tools against the recorded test-site dataset (FluentCRM 3.2.5 + Pro, 50 fictional contacts).
 * Expected numbers are computed from the same dataset, so these tests stay true when it is re-recorded.
 */

const contacts = recordedContacts();
const hasTag = (c: (typeof contacts)[number], title: string) =>
  c.tags.some((t) => (t as { title?: string }).title === title);
const onList = (c: (typeof contacts)[number], title: string) =>
  c.lists.some((l) => (l as { title?: string }).title === title);

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  vi.useRealTimers();
});
beforeEach(() => {
  // The dataset was recorded on 2026-10-12; date-window tools read "now".
  vi.useFakeTimers({ now: new Date("2026-10-12T02:30:00Z"), toFake: ["Date"] });
});

async function connect(options: { pro?: boolean } = {}) {
  const site = createRecordedSite(options);
  const config = parseConfig({
    site: {
      url: site.siteUrl,
      username: "fluentsuite-test",
      applicationPassword: "test pass word abcd efgh ijkl",
    },
    request: { retries: 0 },
    logLevel: "silent",
  });
  const conn = await connectInProcess(
    createServerFactory({ config, products: [crmProduct], fetch: site.fetch }),
  );
  close = conn.close;
  return { client: conn.client, site };
}

const call = async (
  client: Awaited<ReturnType<typeof connect>>["client"],
  name: string,
  args: Record<string, unknown> = {},
) => client.callTool({ name, arguments: args });

describe("read tools are listed read-only", () => {
  it("lists 8 read tools and no write tools while read-only", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "crm_audience_summary",
      "crm_campaign_overview",
      "crm_contact_profile",
      "crm_find_contacts",
      "crm_recent_signups",
      "crm_segment_preview",
      "crm_sequence_overview",
      "crm_tags_and_lists",
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
  });
});

describe("crm_find_contacts", () => {
  it("filters by tag name and status, with a total and a working cursor", async () => {
    const { client, site } = await connect();
    const expected = contacts.filter((c) => hasTag(c, "int:pricing") && c.status === "subscribed");
    const first = await call(client, "crm_find_contacts", {
      tags_any: ["int:pricing"],
      statuses: ["subscribed"],
      per_page: 5,
    });
    const page1 = first.structuredContent as {
      total: number;
      contacts: Array<{ id: number }>;
      next_cursor?: string;
    };
    expect(page1.total).toBe(expected.length);
    expect(page1.contacts).toHaveLength(5);
    // Names were resolved to ids: FluentCRM got tags[]=<id>, never the name.
    const req = site.calls("GET", "fluent-crm/v2/subscribers").at(-1);
    expect(req?.query.getAll("tags[]")).toHaveLength(1);
    expect(req?.query.get("sort_by")).toBe("created_at");

    const second = await call(client, "crm_find_contacts", {
      tags_any: ["int:pricing"],
      statuses: ["subscribed"],
      per_page: 5,
      cursor: page1.next_cursor,
    });
    const page2 = second.structuredContent as { page: number; contacts: Array<{ id: number }> };
    expect(page2.page).toBe(2);
    expect(page2.contacts.map((c) => c.id)).not.toEqual(page1.contacts.map((c) => c.id));
  });

  it("applies exclusions and counts after excluding", async () => {
    const { client } = await connect();
    const expected = contacts.filter((c) => onList(c, "Newsletter") && !hasTag(c, "VIP"));
    const result = await call(client, "crm_find_contacts", {
      lists_any: ["Newsletter"],
      exclude_tags: ["VIP"],
      per_page: 100,
    });
    const out = result.structuredContent as { total: number; contacts: Array<{ tags: string[] }> };
    expect(out.total).toBe(expected.length);
    expect(out.contacts.every((c) => !c.tags.includes("VIP"))).toBe(true);
  });

  it("rejects a cursor from a different search and unknown tag names", async () => {
    const { client } = await connect();
    const first = await call(client, "crm_find_contacts", { per_page: 2 });
    const cursor = (first.structuredContent as { next_cursor: string }).next_cursor;
    const wrong = await call(client, "crm_find_contacts", { per_page: 2, search: "ava", cursor });
    expect(textOf(wrong)).toContain("belongs to a different search");
    const unknown = await call(client, "crm_find_contacts", { tags_any: ["nope"] });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain("Unknown tag: nope");
    expect(textOf(unknown)).toContain("int:pricing");
  });
});

describe("crm_tags_and_lists", () => {
  it("returns every tag and list with counts", async () => {
    const { client } = await connect();
    const out = (await call(client, "crm_tags_and_lists")).structuredContent as {
      tags: Array<{ name: string; subscribed: number }>;
      lists: Array<{ name: string; subscribed: number; total: number }>;
    };
    expect(out.tags.map((t) => t.name)).toContain("stage:customer");
    expect(out.lists.find((l) => l.name === "Newsletter")?.total).toBe(
      contacts.filter((c) => onList(c, "Newsletter")).length,
    );
  });
});

describe("crm_segment_preview", () => {
  it("defaults to subscribed contacts and reports exclusions, breakdown and a sample", async () => {
    const { client } = await connect();
    const base = contacts.filter((c) => onList(c, "Newsletter") && c.status === "subscribed");
    const kept = base.filter((c) => !hasTag(c, "stage:customer"));
    const out = (
      await call(client, "crm_segment_preview", {
        lists_any: ["Newsletter"],
        exclude_tags: ["stage:customer"],
        sample_size: 3,
      })
    ).structuredContent as {
      count: number;
      excluded: number;
      by_status: Record<string, number>;
      sample: unknown[];
    };
    expect(out.count).toBe(kept.length);
    expect(out.excluded).toBe(base.length - kept.length);
    expect(out.by_status).toEqual({ subscribed: kept.length });
    expect(out.sample).toHaveLength(3);
  });
});

describe("crm_campaign_overview", () => {
  it("lists campaigns and shows one in detail without touching its state", async () => {
    const { client, site } = await connect();
    const list = await call(client, "crm_campaign_overview");
    expect(textOf(list)).toContain("October product update (test)");
    const detail = await call(client, "crm_campaign_overview", { campaign_id: 1 });
    expect(textOf(detail)).toContain("Not sent yet");
    // Never the state-changing status endpoint.
    expect(site.requests.some((r) => /campaigns\/\d+\/status/.test(r.route))).toBe(false);
    const missing = await call(client, "crm_campaign_overview", { campaign_id: 999 });
    expect(textOf(missing)).toContain("Error (not_found)");
  });
});

describe("crm_sequence_overview", () => {
  it("lists sequences and shows each email's delay in days", async () => {
    const { client } = await connect();
    expect(textOf(await call(client, "crm_sequence_overview"))).toContain(
      "New lead nurture (test)",
    );
    const detail = await call(client, "crm_sequence_overview", { sequence_id: 2 });
    expect(textOf(detail)).toContain('1. after 2 days: "Welcome step 1"');
    expect(textOf(detail)).toContain('2. after 4 days: "Welcome step 2"');
  });

  it("explains that Pro is needed when the routes are missing", async () => {
    const { client } = await connect({ pro: false });
    const result = await call(client, "crm_sequence_overview");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("need FluentCRM Pro");
  });
});

describe("crm_recent_signups", () => {
  it("counts signups in the window, newest first, grouped by day and source", async () => {
    const { client } = await connect();
    const since = "2026-09-28";
    const expected = contacts.filter((c) => (c.created_at ?? "") >= since);
    const out = (await call(client, "crm_recent_signups", { days: 14, limit: 3 }))
      .structuredContent as {
      since: string;
      total: number;
      contacts: Array<{ created_at: string }>;
      by_day: Record<string, number>;
    };
    expect(out.since).toBe(since);
    expect(out.total).toBe(expected.length);
    expect(out.contacts).toHaveLength(Math.min(3, expected.length));
    const dates = out.contacts.map((c) => c.created_at);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(Object.values(out.by_day).reduce((a, b) => a + b, 0)).toBe(expected.length);
  });
});

describe("crm_audience_summary", () => {
  it("summarises status counts, growth, email activity and top tags", async () => {
    const { client } = await connect();
    const out = (await call(client, "crm_audience_summary", { days: 30 })).structuredContent as {
      by_status: Record<string, number>;
      total_contacts: number;
      new_subscribed: number;
      top_tags: Array<{ name: string }>;
    };
    const byStatus: Record<string, number> = {};
    for (const c of contacts) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
    expect(out.by_status).toEqual(byStatus);
    expect(out.total_contacts).toBe(contacts.length);
    expect(out.new_subscribed).toBeGreaterThan(0);
    expect(out.top_tags[0]?.name).toBe("stage:lead");
  });
});
