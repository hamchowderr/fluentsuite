import { unexpectedFixtureHosts } from "@fluentsuite/core/testing";
import { describe, expect, it } from "vitest";
import { createMockForms, type EntryRecord, fixture } from "./mock-forms.js";

/**
 * The offline mock must answer like the live Fluent Forms site did. The entry list for each form is compared with
 * what the test site returned (scripts/record-forms-fixtures.mjs); if Fluent Forms changes its ordering or
 * filtering, re-record and these fail.
 */

const auth = `Basic ${Buffer.from("fluentsuite-test:testpasswordabcdefghijkl").toString("base64")}`;
async function get(route: string) {
  const site = createMockForms();
  const res = await site.fetch(
    new Request(`${site.siteUrl}/wp-json/fluentform/v1/${route}`, {
      headers: { authorization: auth },
    }),
  );
  return (await res.json()) as { total: number; data: EntryRecord[] };
}

const entries = fixture<EntryRecord[]>("entries.json").body;
const forms = fixture<Record<string, { form: { id: number } }>>("forms-detail.json").body;

describe("mock Fluent Forms matches the recorded site", () => {
  for (const id of Object.keys(forms)) {
    it(`lists form ${id}'s entries newest first, trashed ones apart`, async () => {
      const live = entries.filter((e) => e.form_id === id);
      const open = await get(`submissions?form_id=${id}&per_page=100`);
      const trashed = await get(`submissions?form_id=${id}&per_page=100&entry_type=trashed`);
      expect(open.total + trashed.total).toBe(live.length);
      expect(trashed.data.every((e) => e.status === "trashed")).toBe(true);
      const dates = open.data.map((e) => e.created_at);
      expect([...dates].sort().reverse()).toEqual(dates);
    });
  }

  it("the recording has 62 fictional entries", () => {
    expect(entries).toHaveLength(62);
    for (const e of entries) {
      for (const v of Object.values(JSON.parse(e.response) as Record<string, unknown>)) {
        if (typeof v === "string" && v.includes("@")) expect(v.endsWith("@example.com")).toBe(true);
      }
    }
  });

  it("fixtures mention only example.test hosts and known third parties", () => {
    expect(unexpectedFixtureHosts(new URL("./fixtures/", import.meta.url))).toEqual([]);
  });
});
