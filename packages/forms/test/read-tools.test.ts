import { textOf } from "@fluentsuite/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { connectForms } from "./helpers.js";
import { type EntryRecord, fixture, forbiddenCalls } from "./mock-forms.js";

/**
 * The Fluent Forms read tools against the recorded test site (Fluent Forms 6.2.15, four test forms, 62 fictional
 * entries). Expected numbers come from the same recording.
 */

const entries = fixture<EntryRecord[]>("entries.json").body;
const forms =
  fixture<Record<string, { form: { id: number; title: string } }>>("forms-detail.json").body;
const formId = (title: string) =>
  Number(Object.values(forms).find((f) => f.form.title === title)?.form.id);
const CONTACT = formId("Contact (test)");
const DONATION = formId("Donation (test)");
const contact = entries.filter((e) => e.form_id === String(CONTACT));
const withFile = contact.find((e) => JSON.parse(e.response).attachment);
const withCode = contact.find((e) => e.response.includes("482913"));
const withReset = contact.find((e) => e.response.includes("FAKEkey"));

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});
async function connect(options: Parameters<typeof connectForms>[0] = {}) {
  const c = await connectForms(options);
  close = c.close;
  return c;
}
type S<T> = { structuredContent?: T; isError?: boolean; content?: unknown };

describe("Fluent Forms read tools", () => {
  it("lists exactly the 5 read tools, all read-only", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "forms_entry_detail",
      "forms_find_entries",
      "forms_form_summary",
      "forms_list",
      "forms_report",
    ]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it("forms_list: counts exclude trashed entries, with the last entry date", async () => {
    const { call } = await connect();
    const res = (await call("forms_list", { search: "(test)" })) as S<{
      total: number;
      forms: Array<{ id: number; entries: number; unread: number; last_entry_at: string | null }>;
    }>;
    expect(res.structuredContent?.total).toBe(4);
    const c = res.structuredContent?.forms.find((f) => f.id === CONTACT);
    expect(c?.entries).toBe(contact.filter((e) => e.status !== "trashed").length);
    expect(c?.unread).toBe(contact.filter((e) => e.status === "unread").length);
    expect(c?.last_entry_at).toBeTruthy();
  });

  it("forms_form_summary: fields, notifications with masked recipients, feed names only", async () => {
    const { call } = await connect();
    const res = (await call("forms_form_summary", { form_id: CONTACT })) as S<{
      fields: Array<{ name: string; type: string }>;
      notifications: Array<{ name: string; enabled: boolean; send_to: string }>;
      integrations: unknown[];
      takes_payments: boolean;
    }>;
    const s = res.structuredContent;
    expect(s?.fields.map((f) => f.name)).toEqual([
      "names",
      "email",
      "subject",
      "message",
      "attachment",
      "tax_id",
    ]);
    expect(s?.notifications[0]).toMatchObject({ name: "Admin Notification Email", enabled: false });
    expect(s?.takes_payments).toBe(false);
    const donation = (await call("forms_form_summary", { form_id: DONATION })) as S<{
      takes_payments: boolean;
    }>;
    expect(donation.structuredContent?.takes_payments).toBe(true);
  });

  it("forms_form_summary: never returns a feed's settings", async () => {
    const { call, site } = await connect();
    const target = site.forms[String(CONTACT)];
    if (!target) throw new Error("no contact form");
    target.integrations.feeds = [
      {
        id: 99,
        name: "Send to webhook",
        enabled: "true",
        provider: "webhook",
        feed: {
          request_url: "https://hooks.example.com/secret-path?token=abc123",
          api_key: "sk_live_fake",
        },
      },
    ];
    const res = await call("forms_form_summary", { form_id: CONTACT });
    expect(JSON.stringify(res)).not.toMatch(/hooks\.example\.com|sk_live_fake|abc123/);
    expect((res.structuredContent as { integrations: unknown[] }).integrations).toEqual([
      { name: "Send to webhook", provider: "webhook", enabled: true },
    ]);
  });

  it("forms_find_entries: short rows only, no other field values, files or IPs", async () => {
    const { call } = await connect();
    const res = (await call("forms_find_entries", { form_id: CONTACT, per_page: 100 })) as S<{
      total: number;
      entries: Array<Record<string, unknown>>;
    }>;
    expect(res.structuredContent?.total).toBe(contact.filter((e) => e.status !== "trashed").length);
    const row = res.structuredContent?.entries[0] ?? {};
    expect(Object.keys(row).sort()).toEqual(
      [
        "created_at",
        "email",
        "favorite",
        "form",
        "form_id",
        "id",
        "name",
        "payment_status",
        "status",
      ].sort(),
    );
    const raw = JSON.stringify(res);
    expect(raw).not.toMatch(/192\.0\.2\.|FAKE-TAX|uploads|Chrome|Firefox|Safari|482913|FAKEkey/);
    for (const e of res.structuredContent?.entries ?? []) {
      expect(String(e.email)).toMatch(/@example\.com$/);
    }
  });

  it("forms_find_entries says that search also covers redacted values", async () => {
    const { client } = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === "forms_find_entries");
    expect(tool?.description).toMatch(/including fields shown as \[redacted\]/);
  });

  it("forms_find_entries: status, favorites, trash, dates and paging", async () => {
    const { call } = await connect();
    const unread = (await call("forms_find_entries", { form_id: CONTACT, status: "unread" })) as S<{
      total: number;
    }>;
    expect(unread.structuredContent?.total).toBe(
      contact.filter((e) => e.status === "unread").length,
    );
    const trashed = (await call("forms_find_entries", { status: "trashed" })) as S<{
      total: number;
    }>;
    expect(trashed.structuredContent?.total).toBe(
      entries.filter((e) => e.status === "trashed").length,
    );
    const fav = (await call("forms_find_entries", { status: "favorites" })) as S<{ total: number }>;
    expect(fav.structuredContent?.total).toBe(
      entries.filter((e) => e.is_favourite === "1" && e.status !== "trashed").length,
    );
    const first = (await call("forms_find_entries", { per_page: 10 })) as S<{
      next_cursor?: string;
      entries: Array<{ id: number }>;
    }>;
    const second = (await call("forms_find_entries", {
      per_page: 10,
      cursor: first.structuredContent?.next_cursor,
    })) as S<{ entries: Array<{ id: number }> }>;
    const ids = new Set(first.structuredContent?.entries.map((e) => e.id));
    expect(second.structuredContent?.entries.some((e) => ids.has(e.id))).toBe(false);
    const bad = await call("forms_find_entries", { after: "2026-10-10", before: "2026-10-01" });
    expect(bad.isError).toBe(true);
  });

  it("forms_entry_detail: file names only, Tax ID redacted, no IP or browser", async () => {
    const { call } = await connect();
    const res = (await call("forms_entry_detail", { id: withFile?.id })) as S<{
      fields: Array<{ name: string; value: string; files?: string[]; redacted?: boolean }>;
    }>;
    const byName = Object.fromEntries(
      (res.structuredContent?.fields ?? []).map((f) => [f.name, f]),
    );
    expect(byName.attachment?.files?.[0]).toMatch(/^fake-\d+-quote-request\.pdf$/);
    expect(byName.tax_id).toMatchObject({ value: "[redacted]", redacted: true });
    const raw = JSON.stringify(res);
    expect(raw).not.toMatch(/wp-content\/uploads|https?:\/\/[^"]*\.pdf/);
    expect(raw).not.toMatch(/FAKE-TAX/);
    expect(raw).not.toMatch(/192\.0\.2\.|"ip"|browser|device|Chrome|Firefox|Safari/);
  });

  it("forms_entry_detail: masks a one-time code and a reset link in values", async () => {
    const { call } = await connect();
    const code = await call("forms_entry_detail", { id: withCode?.id, form_id: CONTACT });
    expect(JSON.stringify(code)).not.toContain("482913");
    expect(textOf(code)).toContain("[masked code]");
    const reset = await call("forms_entry_detail", { id: withReset?.id });
    expect(JSON.stringify(reset)).not.toContain("FAKEkey");
    expect(textOf(reset)).toContain("wp-login.php?[masked]");
  });

  it("forms_entry_detail: the fields filter and the owner's extra redaction patterns", async () => {
    const { call } = await connect({ redactFields: ["subject"] });
    const res = (await call("forms_entry_detail", {
      id: withFile?.id,
      fields: ["Email", "subject"],
    })) as S<{ fields: Array<{ name: string; value: string }> }>;
    expect(res.structuredContent?.fields.map((f) => f.name)).toEqual(["email", "subject"]);
    expect(res.structuredContent?.fields[1]?.value).toBe("[redacted]");
  });

  it("forms_entry_detail: payment amounts and status only", async () => {
    const { call } = await connect();
    const paid = entries.find((e) => e.form_id === String(DONATION) && e.payment_status === "paid");
    const res = (await call("forms_entry_detail", { id: paid?.id })) as S<{
      payment: { status: string; method: string; total: string; paid: string };
    }>;
    expect(res.structuredContent?.payment).toMatchObject({ status: "paid", method: "stripe" });
    expect(res.structuredContent?.payment.total).toMatch(/^\d+\.\d{2} USD$/);
  });

  it("forms_entry_detail: finds trashed entries too, with notes", async () => {
    const { call } = await connect();
    const trashed = entries.find((e) => e.status === "trashed");
    const t = (await call("forms_entry_detail", { id: trashed?.id })) as S<{ status: string }>;
    expect(t.structuredContent?.status).toBe("trashed");
    const noted = Object.keys(fixture<Record<string, unknown[]>>("notes.json").body)[0];
    const n = (await call("forms_entry_detail", { id: Number(noted), include_notes: true })) as S<{
      notes: Array<{ text: string }>;
    }>;
    expect(n.structuredContent?.notes[0]?.text).toMatch(/fictional note/);
    const missing = await call("forms_entry_detail", { id: 999999 });
    expect(missing.isError).toBe(true);
  });

  it("reading an entry never marks it read, and no read tool touches form-submit", async () => {
    const { call, site } = await connect();
    const unread = contact.find((e) => e.status === "unread");
    await call("forms_list");
    await call("forms_form_summary", { form_id: CONTACT });
    await call("forms_find_entries", { status: "unread" });
    await call("forms_entry_detail", { id: unread?.id, include_notes: true });
    await call("forms_report");
    expect(forbiddenCalls(site)).toEqual([]);
    expect(site.entries.find((e) => e.id === unread?.id)?.status).toBe("unread");
  });

  it("forms_report: buckets, read rate, top forms and revenue", async () => {
    const { call } = await connect();
    const res = (await call("forms_report", { after: "2026-07-01", before: "2026-10-12" })) as S<{
      total: number;
      read_rate: number;
      top_forms: Array<{ title: string; entries: number }>;
      revenue: { currency: string; paid_total: number } | null;
    }>;
    const overview = fixture<{ overview_chart: { values: { submissions: number[] } } }>(
      "report-overview.json",
    ).body;
    expect(res.structuredContent?.total).toBe(
      overview.overview_chart.values.submissions.reduce((a, b) => a + b, 0),
    );
    expect(res.structuredContent?.top_forms[0]?.title).toMatch(/\(test\)$/);
    expect(res.structuredContent?.revenue).toMatchObject({ currency: "USD" });
    expect(res.structuredContent?.revenue?.paid_total).toBeGreaterThan(0);
  });

  it("explains when Fluent Forms is not active", async () => {
    const { call } = await connect({ active: false });
    const res = await call("forms_list");
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Fluent Forms is not active/);
  });
});

describe("the forbidden-route guard in every test connection", () => {
  it("fails a test that calls GET submissions/{id}", async () => {
    const c = await connectForms();
    const entry = entries[0];
    await c.site.fetch(
      new Request(`${c.site.siteUrl}/wp-json/fluentform/v1/submissions/${entry?.id}`, {
        headers: {
          authorization: `Basic ${Buffer.from("fluentsuite-test:testpasswordabcdefghijkl").toString("base64")}`,
        },
      }),
    );
    await expect(c.close()).rejects.toThrow(
      /Forbidden Fluent Forms route called: GET fluentform\/v1\/submissions\/\d+/,
    );
  });

  it("fails a test that calls form-submit", async () => {
    const c = await connectForms();
    await c.site.fetch(
      new Request(`${c.site.siteUrl}/wp-json/fluentform/v1/form-submit`, {
        method: "POST",
        body: "{}",
        headers: {
          authorization: `Basic ${Buffer.from("fluentsuite-test:testpasswordabcdefghijkl").toString("base64")}`,
        },
      }),
    );
    await expect(c.close()).rejects.toThrow(/form-submit/);
  });
});
